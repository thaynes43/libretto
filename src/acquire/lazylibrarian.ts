import type { ServiceEndpoint } from '../config.js';

/**
 * LazyLibrarian acquisition client (DESIGN-037 M3 — the acquisition leg).
 *
 * LL exposes a single query-string command API: `GET {url}/api?apikey=<key>&cmd=<command>&<params>`.
 * Every command returns HTTP 200 — success and logical failure alike — with either a JSON body
 * (getAllBooks) or a plain-text ack ("false", "No results for <isbn>", a book name). So this client
 * reads the body as TEXT and lets the caller interpret it; it does NOT treat a 200 "No results" as an
 * error. The apikey is appended here and NEVER logged (errors carry a redacted URL).
 *
 * The command set was verified empirically against the deployed LL (build 40a389ea,
 * lazylibrarian.downloads:5299, BOOK_API=GoogleBooks) from a frontend-namespace probe Job, 2026-07-17:
 *
 *   - `getAllBooks` → the whole book table (one call/run, the idempotency + BookID source). Rows carry
 *     BookID (a Google Books volume id), BookName, BookIsbn, and the two per-format statuses `Status`
 *     (eBook) and `AudioStatus` (AudioBook). RELIABLE — it reads LL's own DB, no Google Books call.
 *   - `queueBook &id= &type=eBook|AudioBook` → mark that FORMAT Wanted; `searchBook &id= &type=` → fire
 *     the hunt. Both operate on a BookID already in LL's DB (no Google Books) — the reliable drive.
 *   - `addBookByISBN &isbn=` → add a book LL doesn't yet know, resolving the ISBN via LL's OWN Google
 *     Books budget (Libretto has no GB key and MUST NOT acquire one). BEST-EFFORT: the deployed LL's
 *     anonymous GB quota is throttled, so this frequently answers "No results for <isbn>" — the caller
 *     treats that as a soft skip and retries on a later run, never an error.
 *   - `addBook &id=<gbVolumeId>` → add by a known Google Books volume id (only useful when a builder's
 *     identifier already IS a GB id; Libretto's ISBN/ASIN identifiers use addBookByISBN instead).
 *
 * NOTE: `findBook`/`findAuthor` (LL's live GB search) return `[]` for every query in this deployment
 * (GB throttling), so a keyless findBook→addBook path is NOT viable — hence the getAllBooks-keyed
 * reconcile + addBookByISBN design. This client deliberately does NOT touch LL provider config or the
 * MAM governor (OPS-013 / PLAN-039 hard constraint): usenet-first (SAB) provider priority is owned by
 * Prowlarr's app-sync, and MAM only fills gaps when its governor opens the gate.
 */

/** The two book formats LL tracks as separate per-book statuses (Status vs AudioStatus). */
export type LlFormat = 'ebook' | 'audiobook';

/** Map our format to LL's DLTYPES vocabulary ('eBook'/'AudioBook'). */
function llTypeParam(format: LlFormat): string {
  return format === 'audiobook' ? 'AudioBook' : 'eBook';
}

/** One LL book row as the acquisition leg needs to see it (from `cmd=getAllBooks`). */
export interface LlBook {
  /** LL BookID — a Google Books volume id; the key for queueBook/searchBook. */
  bookId: string;
  /** LL BookName — feeds the conservative title fallback when identifiers miss. */
  title: string;
  /** Raw BookIsbn (LL stores ISBN-10 or ISBN-13); normalized by the caller for lookup. */
  isbn: string | null;
  /** The EBOOK status string (LL `Status`) — null when LL omits it. */
  ebookStatus: string | null;
  /** The AUDIOBOOK status string (LL `AudioStatus`) — null when LL omits it. */
  audioStatus: string | null;
}

/**
 * The command surface the acquisition planner drives. The real client and the test fake both implement
 * it, so acquire.ts never depends on live HTTP (ADR precedent: inject the seam, test offline).
 */
export interface LazyLibrarianCommands {
  getAllBooks(): Promise<LlBook[]>;
  addBook(id: string): Promise<string>;
  addBookByISBN(isbn: string): Promise<string>;
  queueBook(id: string, format: LlFormat): Promise<string>;
  searchBook(id: string, format: LlFormat): Promise<string>;
}

export class LazyLibrarianError extends Error {
  constructor(
    readonly cmd: string,
    readonly redactedUrl: string,
    message: string,
  ) {
    super(`lazylibrarian ${cmd}: ${message} (${redactedUrl})`);
    this.name = 'LazyLibrarianError';
  }
}

export interface LazyLibrarianClientOptions {
  url: string;
  apiKey: string;
  /** Per-request timeout (ms); default 30s (LL's own GB lookups can be slow). */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Strip the apikey from a URL so it never lands in an error message or a log line. */
function redactUrl(url: string): string {
  return url.replace(/([?&])apikey=[^&]*/i, '$1apikey=REDACTED');
}

export class LazyLibrarianClient implements LazyLibrarianCommands {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LazyLibrarianClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private buildUrl(cmd: string, params: Record<string, string | undefined>): string {
    const query = new URLSearchParams();
    query.set('cmd', cmd);
    query.set('apikey', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, value);
    }
    return `${this.baseUrl}/api?${query.toString()}`;
  }

  /** Run an LL command, returning the raw response text (LL answers 200 for success AND soft failure). */
  private async command(
    cmd: string,
    params: Record<string, string | undefined> = {},
  ): Promise<string> {
    const url = this.buildUrl(cmd, params);
    const redacted = redactUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json, text/plain, */*' },
        signal: controller.signal,
      });
    } catch (error) {
      throw new LazyLibrarianError(
        cmd,
        redacted,
        controller.signal.aborted ? `timed out after ${this.timeoutMs}ms` : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new LazyLibrarianError(cmd, redacted, `HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return text;
  }

  /**
   * `cmd=getAllBooks` — every book LL tracks with its two per-format statuses, keyed by BookID. Tolerant
   * of LL's array / `{ data: [...] }` / error-string / error-object shapes (all → [] on anything but a
   * real list) because LL's response shape varies by build (the @hnet/lazylibrarian precedent).
   */
  async getAllBooks(): Promise<LlBook[]> {
    const text = await this.command('getAllBooks');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return []; // a plain-text error body ("Unknown command…") → no books
    }
    const rows: unknown[] = Array.isArray(raw)
      ? raw
      : raw !== null && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
        ? (raw as { data: unknown[] }).data
        : [];
    const books: LlBook[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (r.BookID === undefined || r.BookID === null) continue;
      books.push({
        bookId: String(r.BookID),
        title: typeof r.BookName === 'string' ? r.BookName : '',
        isbn: typeof r.BookIsbn === 'string' && r.BookIsbn !== '' ? r.BookIsbn : null,
        ebookStatus: typeof r.Status === 'string' ? r.Status : null,
        audioStatus: typeof r.AudioStatus === 'string' ? r.AudioStatus : null,
      });
    }
    return books;
  }

  /** `cmd=addBook&id=<bookId>` — add by a known Google Books volume id. Returns the ack text. */
  async addBook(id: string): Promise<string> {
    return this.command('addBook', { id });
  }

  /**
   * `cmd=addBookByISBN&isbn=<isbn>` — add a book LL doesn't know, resolving the ISBN via LL's own Google
   * Books budget. Returns the ack ("No results for <isbn>" when LL's GB lookup came back empty).
   */
  async addBookByISBN(isbn: string): Promise<string> {
    return this.command('addBookByISBN', { isbn });
  }

  /** `cmd=queueBook&id=&type=` — mark the given FORMAT Wanted (the drive step; no Google Books). */
  async queueBook(id: string, format: LlFormat): Promise<string> {
    return this.command('queueBook', { id, type: llTypeParam(format) });
  }

  /** `cmd=searchBook&id=&type=` — fire the hunt for the given format (usenet-first via LL's dlpriority). */
  async searchBook(id: string, format: LlFormat): Promise<string> {
    return this.command('searchBook', { id, type: llTypeParam(format) });
  }
}

/** Wire the LL client from the resolved endpoint (undefined when LAZYLIBRARIAN_* is not configured). */
export function createLazyLibrarianClient(
  endpoint: ServiceEndpoint | undefined,
): LazyLibrarianClient | undefined {
  if (!endpoint) return undefined;
  return new LazyLibrarianClient({ url: endpoint.url, apiKey: endpoint.apiKey });
}
