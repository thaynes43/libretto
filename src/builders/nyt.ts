import type { DiskCache } from '../cache/disk.js';
import { fetchJson, HttpError } from '../http.js';
import { normalizeIdentifiers } from '../identifiers.js';
import type { Logger } from '../logger.js';
import type { WorkItem } from './index.js';

/**
 * nyt_list builder (DESIGN-037 D-05, the acquisition-driven list): a New York
 * Times bestseller list resolved to a rank-ordered, identifier-keyed work list.
 * A recipe's matched works become the collection; its missing works flow to
 * LazyLibrarian through the M3 acquisition leg — so flipping acquisitionEnabled
 * on makes the estate CHASE the current bestseller list.
 *
 * Verified against the NYT Books API (developer.nytimes.com/docs/books-product):
 *
 * - Endpoint GET https://api.nytimes.com/svc/books/v3/lists/current/{ref}.json
 *   where {ref} is a list's `list_name_encoded` value (e.g. hardcover-fiction,
 *   trade-fiction-paperback, combined-print-and-e-book-fiction). The full set of
 *   names is the /svc/books/v3/lists/names.json endpoint. The api-key rides the
 *   query string (env NYT_API_KEY); it is redacted out of every error/log line.
 * - The free tier is rate-limited (roughly 500 requests/day and 5/minute), so
 *   requests are paced through a serialized gate (>= minIntervalMs apart), every
 *   resolved list lands in the short-TTL disk cache (weekly-refresh data), and a
 *   429 is retried with exponential backoff before failing honestly.
 * - Each `results.books[]` entry carries `rank`, ALL-CAPS `title`, `author`,
 *   `primary_isbn13`/`primary_isbn10`, and an `isbns[]` array of {isbn10,isbn13}
 *   for the list's editions. Works are emitted ordered by rank, so an ordered:true
 *   recipe yields a ranked reading list. Titles are normalized to title case for
 *   display (the matcher is case-insensitive over normalized identifiers anyway).
 */

export interface NytListSourceOptions {
  apiKey: string;
  cache: DiskCache;
  log: Logger;
  /** Base URL (default https://api.nytimes.com); the list path is appended. */
  baseUrl?: string;
  /** Minimum spacing between requests (5/min limit => default 12s). */
  minIntervalMs?: number;
  /** How long a resolved list stays cached (default 6h, suited to weekly refresh). */
  cacheTtlMs?: number;
  /** How many times a 429 is retried before giving up (default 3). */
  maxRetries?: number;
  /** First backoff step after a 429; doubles each retry (default 1s). */
  backoffMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_BASE_URL = 'https://api.nytimes.com';
const DEFAULT_MIN_INTERVAL_MS = 12_000;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1_000;

/** The `list_name_encoded` values are what a recipe's ref must be. */
const NAMES_HINT =
  "the ref must be a list's list_name_encoded value (see the names at " +
  'https://api.nytimes.com/svc/books/v3/lists/names.json, ' +
  'e.g. hardcover-fiction, trade-fiction-paperback, combined-print-and-e-book-fiction)';

interface NytIsbn {
  isbn10?: string | null;
  isbn13?: string | null;
}

interface NytBook {
  rank?: number | null;
  title?: string | null;
  author?: string | null;
  primary_isbn13?: string | null;
  primary_isbn10?: string | null;
  isbns?: NytIsbn[] | null;
}

interface NytListResponse {
  status?: string;
  results?: { list_name?: string; list_name_encoded?: string; books?: NytBook[] } | unknown[];
}

/** Strip the api-key from a URL so it never lands in an error message or a log line. */
function redactUrl(url: string): string {
  return url.replace(/([?&])api-key=[^&]*/i, '$1api-key=REDACTED');
}

/**
 * ALL-CAPS -> title case for display only. Capitalizes the first letter of each
 * whitespace-delimited word and leaves the rest lowercase; matching never relies
 * on this (it is case-insensitive over normalized identifiers, and the D-04
 * title fallback lowercases both sides).
 */
export function toTitleCase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/(^|\s)(\S)/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());
}

export class NytListSource {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly options: NytListSourceOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Resolve a list ref (a `list_name_encoded` slug) to its rank-ordered work list. */
  async listWorks(ref: string): Promise<WorkItem[]> {
    // Versioned key: bump v1 whenever the cached WorkItem shape changes so a live
    // pod does not serve pre-change entries for the full TTL (the hardcover v2
    // lesson). Short TTL suits weekly-refresh bestseller data.
    const cacheKey = `nyt:list:v1:${ref}`;
    const cached = await this.options.cache.get<WorkItem[]>(cacheKey);
    if (cached !== undefined) {
      this.options.log.debug({ ref, works: cached.length }, 'nyt: list cache hit');
      return cached;
    }

    const response = await this.fetchList(ref);
    const results = response.results;
    if (results === undefined || Array.isArray(results) || !Array.isArray(results.books)) {
      // Defensive: an unknown list normally 404s (handled in fetchList), but if a
      // 200 ever carries no books object, fail the same honest way.
      throw new Error(`nyt_list builder: NYT has no current list named "${ref}" — ${NAMES_HINT}`);
    }

    const listDisplay = results.list_name ?? results.list_name_encoded ?? ref;
    const books = [...results.books].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));

    const works: WorkItem[] = [];
    for (const book of books) {
      const rawTitle = (book.title ?? '').trim();
      const title = rawTitle ? toTitleCase(rawTitle) : undefined;
      const author = book.author?.trim() ? book.author.trim() : undefined;
      // Preference order: the list's primary edition first, then every isbns[]
      // edition; normalizeIdentifiers dedupes and drops empties, keeping order.
      const identifiers = normalizeIdentifiers([
        book.primary_isbn13,
        book.primary_isbn10,
        ...(book.isbns ?? []).flatMap((isbn) => [isbn.isbn13, isbn.isbn10]),
      ]);
      const rank = typeof book.rank === 'number' ? String(book.rank) : '?';
      works.push({
        identifiers,
        label: `${title ?? identifiers[0] ?? 'unknown'} (#${rank} on ${listDisplay})`,
        ...(title ? { title } : {}),
        ...(author ? { authors: [author] } : {}),
      });
    }

    await this.options.cache.set(cacheKey, works, this.cacheTtlMs);
    this.options.log.info(
      { ref, list: results.list_name_encoded ?? ref, works: works.length },
      'nyt: resolved list',
    );
    return works;
  }

  /** Paced GET with 429 backoff; the api-key is redacted from any thrown error. */
  private async fetchList(ref: string): Promise<NytListResponse> {
    const url =
      `${this.baseUrl}/svc/books/v3/lists/current/${encodeURIComponent(ref)}.json` +
      `?api-key=${encodeURIComponent(this.options.apiKey)}`;
    const redacted = redactUrl(url);

    for (let attempt = 0; ; attempt++) {
      await this.pace();
      try {
        return await fetchJson<NytListResponse>(url, { headers: { 'user-agent': 'libretto' } });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        if (error.status === 429 && attempt < this.maxRetries) {
          const backoff = this.backoffMs * 2 ** attempt;
          this.options.log.warn(
            { ref, attempt: attempt + 1, backoff },
            'nyt: rate limited (HTTP 429), backing off',
          );
          await this.sleep(backoff);
          continue;
        }
        if (error.status === 404) {
          // Unknown list names come back as HTTP 404 {"status":"ERROR",
          // "errors":["list not found"]} (verified 2026-07-17) — surface the hint.
          throw new Error(
            `nyt_list builder: NYT has no current list named "${ref}" — ${NAMES_HINT}`,
          );
        }
        if (error.status === 401 || error.status === 403) {
          throw new Error(
            `nyt_list builder: NYT rejected the api key (HTTP ${error.status}) — check NYT_API_KEY (${redacted})`,
          );
        }
        if (error.status === 429) {
          throw new Error(
            'nyt_list builder: NYT rate limit exceeded (HTTP 429) after retries — the free tier ' +
              'allows roughly 5 requests/minute and 500/day',
          );
        }
        throw new Error(`nyt_list builder: HTTP ${error.status} from NYT (${redacted})`);
      }
    }
  }

  /** Serialize requests and keep them at least minIntervalMs apart. */
  private async pace(): Promise<void> {
    const turn = this.gate.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
    });
    this.gate = turn.catch(() => undefined);
    await turn;
  }
}
