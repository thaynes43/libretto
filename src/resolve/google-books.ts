/**
 * ISBN-first Google Books resolver (the M3 resolve broker's engine).
 *
 * This is Libretto's OWN reliable ISBN -> Google-Books volume-id resolution, ported from the
 * haynesnetwork hardened resolver (packages/goodreads/src/google-books.ts, v0.70.1) so that the
 * acquisition leg no longer depends on LazyLibrarian's keyless, rate-throttled Google Books search
 * (`addBookByISBN`, which answers "No results" for most wants — the ~0 M3 resolution gap).
 *
 * The doctrine, verbatim from the donor resolver and the PLAN-059 pairing fix:
 *
 *   1. Try `isbn:<isbn>` FIRST — the most reliable key, exact, one call, immune to title fuzz.
 *   2. Fall back to `intitle:<title>+inauthor:<author>` ONLY when the ISBN leg misses (or there is
 *      no ISBN). The fuzzy leg is guarded so it can never resolve a WRONG work:
 *        - title-token COVERAGE guard (>= 60% of the queried title's distinctive tokens must be
 *          covered by the resolved volume's title), and
 *        - SURNAME author guard (a shared >=3-char name token) when both sides carry an author.
 *      A guard failure returns null (an honest gap), never a wrong-work volume id.
 *   3. Pre-colon fallback on a miss ("Dead Ever After: A Sookie Stackhouse Novel" -> "Dead Ever
 *      After") — colon subtitles are often edition dressing GB does not index under.
 *
 * The GB volume id it returns IS the LazyLibrarian addBook key (LL BookID is a GB volume id), so the
 * acquisition leg can drive `addBook(<volumeId>)` — the reliable ingestion path — instead of the
 * throttled `addBookByISBN`. The key is OPTIONAL: with no key against the real GB API, resolve returns
 * null and acquisition falls back to its prior addBookByISBN behavior (no regression).
 */

/** Strip the TRAILING series parenthetical / bracket and LEADING file-title series prefixes for the
 * `intitle:` query — the file-derived titles Kavita/ABS expose ("Expanse 05 - Nemesis Games",
 * "Wheel of Time [09]: Winter's Heart") never index under the series prefix. Ported verbatim from the
 * donor `gbQueryTitle`; the coverage + author guards catch an over-strip, so a bad strip fails to null. */
export function gbQueryTitle(title: string): string {
  let stripped = title.replace(/\s*\([^()]*\)\s*$/, '').trim();
  stripped = stripped.replace(/\s*\[[^\][]*\]\s*$/, '').trim();
  stripped = stripped.replace(/^.*?(?:\[\d{1,3}\]|#\d{1,3})\s*[-–:]\s+(?=\S)/, '').trim();
  stripped = stripped.replace(/^.+?\s\d{1,3}\s*[-–]\s+(?=\S)/, '').trim();
  stripped = stripped.replace(/^\d{1,3}\s*[-–.]\s+(?=\S)/, '').trim();
  return stripped.length > 0 ? stripped : title;
}

/** Loose author agreement: the queried author and one resolved author must share a >=3-char token
 * ("Dean Koontz" vs "Simon Beckett" rejects; "C. Harris" vs "Charlaine Harris" accepts). */
export function gbAuthorsMatch(queryAuthor: string, resolvedAuthors: readonly string[]): boolean {
  const tokens = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3);
  const q = new Set(tokens(queryAuthor));
  if (q.size === 0) return true;
  return resolvedAuthors.some((a) => tokens(a).some((t) => q.has(t)));
}

const TITLE_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'by',
  'vol',
  'volume',
  'part',
  'book',
  'no',
  'edition',
]);

function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0 && !TITLE_STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/** Guard a TITLE-search resolve: the resolved volume's title must cover >= 60% of the queried
 * title's distinctive tokens, or the resolve is rejected as a different work. ISBN resolves skip this. */
export function gbResolveTitleMatches(
  queryTitle: string,
  resolvedTitle: string | undefined,
): boolean {
  if (!resolvedTitle) return false;
  const q = titleTokens(gbQueryTitle(queryTitle));
  if (q.length === 0) return true;
  const resolved = new Set(titleTokens(resolvedTitle));
  const covered = q.filter((t) => resolved.has(t)).length;
  return covered >= Math.max(1, Math.ceil(q.length * 0.6));
}

export interface GbResolveInput {
  isbn?: string | null;
  title: string;
  author?: string | null;
}

export interface GbVolume {
  /** The Google-Books volume id — the LazyLibrarian addBook key. */
  volumeId: string;
  /** The ISBN-13 GB reports for the resolved volume (or the anchor ISBN on an ISBN resolve). */
  isbn13: string | null;
  /** How the volume was resolved — surfaced in the run log / broker response for honesty. */
  via: 'isbn' | 'title';
}

interface Volume {
  id: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    industryIdentifiers?: { type?: string; identifier?: string }[];
  };
}

export interface GoogleBooksResolverOptions {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  /** Per-attempt timeout (ms); default 15s. */
  timeoutMs?: number;
  /** Transient-failure retries (GB `backendFailed` bursts); default 2. */
  retries?: number;
  /** Base backoff (ms), grows linearly; default 400. */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = 'https://www.googleapis.com/books/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 400;
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ISBN-first Google Books resolver. `resolveVolume` returns null on no-key / no-match / guard-reject. */
export class GoogleBooksResolver {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: GoogleBooksResolverOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (options.apiKey) this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  /** True when this resolver can actually reach GB (a key is set, or a non-Google test base URL). */
  get enabled(): boolean {
    return Boolean(this.apiKey) || !this.baseUrl.startsWith('https://www.googleapis.com');
  }

  private async getJson(url: string): Promise<unknown | null> {
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        if (attempt < this.retries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        // 429 (daily quota) and 5xx (backendFailed bursts) are transient — retry then give up to null.
        if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        return null;
      }
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
  }

  private async query(q: string): Promise<Volume[]> {
    const params = new URLSearchParams({ q, maxResults: '5', country: 'US' });
    if (this.apiKey) params.set('key', this.apiKey);
    const raw = await this.getJson(`${this.baseUrl}/volumes?${params.toString()}`);
    const items = (raw as { items?: unknown })?.items;
    return Array.isArray(items) ? (items as Volume[]) : [];
  }

  private static pickIsbn13(vol: Volume): string | null {
    const ids = vol.volumeInfo?.industryIdentifiers ?? [];
    return ids.find((i) => i.type === 'ISBN_13')?.identifier ?? null;
  }

  /**
   * Resolve to a GB volume id. `isbn:<isbn>` first, then a guarded `intitle:+inauthor:` fallback and a
   * pre-colon retry. Returns null with no key against the real GB API, or when nothing resolves / a
   * guard rejects the fuzzy leg — the caller keeps the want honestly un-added, never fabricates an id.
   */
  async resolveVolume(input: GbResolveInput): Promise<GbVolume | null> {
    if (!this.enabled) return null;
    if (input.isbn) {
      const [vol] = await this.query(`isbn:${input.isbn}`);
      if (vol) {
        return {
          volumeId: vol.id,
          isbn13: GoogleBooksResolver.pickIsbn13(vol) ?? input.isbn,
          via: 'isbn',
        };
      }
    }
    const primary = await this.resolveByTitle(gbQueryTitle(input.title), input);
    if (primary) return primary;
    const preColon = input.title.split(':')[0]?.trim();
    if (preColon && preColon.length >= 3 && preColon !== input.title.trim()) {
      return this.resolveByTitle(gbQueryTitle(preColon), input);
    }
    return null;
  }

  private async resolveByTitle(
    queryTitle: string,
    input: GbResolveInput,
  ): Promise<GbVolume | null> {
    const authorPart = input.author ? `+inauthor:${input.author}` : '';
    const [vol] = await this.query(`intitle:${queryTitle}${authorPart}`);
    if (!vol) return null;
    const resolvedTitle = [vol.volumeInfo?.title, vol.volumeInfo?.subtitle]
      .filter(Boolean)
      .join(' ');
    if (!gbResolveTitleMatches(queryTitle, resolvedTitle || undefined)) return null;
    if (input.author && (vol.volumeInfo?.authors?.length ?? 0) > 0) {
      if (!gbAuthorsMatch(input.author, vol.volumeInfo?.authors ?? [])) return null;
    }
    return { volumeId: vol.id, isbn13: GoogleBooksResolver.pickIsbn13(vol), via: 'title' };
  }
}
