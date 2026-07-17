import type { DiskCache } from '../cache/disk.js';
import { fetchJson } from '../http.js';
import { normalizeIdentifiers } from '../identifiers.js';
import type { Logger } from '../logger.js';
import type { WorkItem } from './index.js';

/**
 * hardcover_series builder (DESIGN-037 D-05, the flagship): all books of a
 * Hardcover series ordered by series position, emitted as identifier-keyed
 * works. Verified against the Hardcover API docs source
 * (github.com/hardcoverapp/hardcover-docs, 2026-07):
 *
 * - Endpoint https://api.hardcover.app/v1/graphql (Hasura), header
 *   `authorization: Bearer <token>`; tokens expire after one year and reset on
 *   January 1st.
 * - Rate limit is 60 requests/minute with a 30s query timeout, so requests are
 *   paced through a serialized gate (>= minIntervalMs apart) and every series
 *   resolution result lands in the TTL disk cache.
 * - Queries have a MAXIMUM DEPTH OF 3, which is why this runs as two flat
 *   queries: series -> book_series -> book (scalars + default edition ids),
 *   then editions filtered by book_id. ISBN/ASIN live only on editions;
 *   the books table has no cached identifier column.
 * - The book_series recipe (distinct_on position, canonical_id null,
 *   is_partial_book false, compilation false) mirrors the official
 *   "books in a series" guide so positions match the website's series page.
 */

export interface HardcoverSeriesSourceOptions {
  token: string;
  cache: DiskCache;
  log: Logger;
  url?: string;
  /** Minimum spacing between requests (60/min limit => default 1100ms). */
  minIntervalMs?: number;
  /** How long a resolved series stays cached (default 6 hours). */
  cacheTtlMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_URL = 'https://api.hardcover.app/v1/graphql';
const DEFAULT_MIN_INTERVAL_MS = 1100;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const EDITIONS_CHUNK = 100;

const SERIES_QUERY = `
query LibrettoSeriesWorks($where: series_bool_exp!) {
  series(where: $where, limit: 1) {
    id
    name
    slug
    book_series(
      distinct_on: position
      order_by: [{ position: asc }, { book: { users_count: desc } }]
      where: {
        book: { canonical_id: { _is_null: true }, is_partial_book: { _eq: false } }
        compilation: { _eq: false }
      }
    ) {
      position
      book {
        id
        title
        default_physical_edition_id
        default_ebook_edition_id
        default_audio_edition_id
      }
    }
  }
}`;

const EDITIONS_QUERY = `
query LibrettoBookEditions($bookIds: [Int!]!) {
  editions(
    where: {
      book_id: { _in: $bookIds }
      _or: [
        { isbn_13: { _is_null: false } }
        { isbn_10: { _is_null: false } }
        { asin: { _is_null: false } }
      ]
    }
    order_by: { users_count: desc_nulls_last }
  ) {
    id
    book_id
    isbn_13
    isbn_10
    asin
  }
}`;

interface SeriesQueryData {
  series: {
    id: number;
    name: string;
    slug: string;
    book_series: {
      position: number | null;
      book: {
        id: number;
        title: string;
        default_physical_edition_id: number | null;
        default_ebook_edition_id: number | null;
        default_audio_edition_id: number | null;
      } | null;
    }[];
  }[];
}

interface EditionsQueryData {
  editions: {
    id: number;
    book_id: number;
    isbn_13: string | null;
    isbn_10: string | null;
    asin: string | null;
  }[];
}

export class HardcoverSeriesSource {
  private readonly url: string;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly options: HardcoverSeriesSourceOptions) {
    this.url = options.url ?? DEFAULT_URL;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Resolve a series ref (numeric id or slug) to its ordered work list. */
  async seriesWorks(ref: string): Promise<WorkItem[]> {
    // Bump the key version whenever the cached WorkItem shape changes — a live
    // pod otherwise serves pre-change entries for the full TTL (D-04's title
    // fallback matched 0 in production because v1 entries carried no `title`).
    const cacheKey = `hardcover:series-works:v2:${ref}`;
    const cached = await this.options.cache.get<WorkItem[]>(cacheKey);
    if (cached !== undefined) {
      this.options.log.debug({ ref, works: cached.length }, 'hardcover: series cache hit');
      return cached;
    }

    const where = /^\d+$/.test(ref) ? { id: { _eq: Number(ref) } } : { slug: { _eq: ref } };
    const seriesData = await this.request<SeriesQueryData>(SERIES_QUERY, { where });
    const series = seriesData.series[0];
    if (!series) {
      throw new Error(`hardcover series "${ref}" not found (ref must be a series id or slug)`);
    }

    const entries = series.book_series
      .filter(
        (entry): entry is typeof entry & { book: NonNullable<(typeof entry)['book']> } =>
          entry.book !== null,
      )
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));

    const bookIds = [...new Set(entries.map((entry) => entry.book.id))];
    const editionsByBook = new Map<number, EditionsQueryData['editions']>();
    for (let i = 0; i < bookIds.length; i += EDITIONS_CHUNK) {
      const chunk = bookIds.slice(i, i + EDITIONS_CHUNK);
      const { editions } = await this.request<EditionsQueryData>(EDITIONS_QUERY, {
        bookIds: chunk,
      });
      for (const edition of editions) {
        const list = editionsByBook.get(edition.book_id) ?? [];
        list.push(edition);
        editionsByBook.set(edition.book_id, list);
      }
    }

    const works: WorkItem[] = [];
    const seenBooks = new Set<number>();
    for (const entry of entries) {
      const { book } = entry;
      if (seenBooks.has(book.id)) continue;
      seenBooks.add(book.id);
      const editions = editionsByBook.get(book.id) ?? [];
      // Preference order: the book's default editions first, then the rest
      // (already sorted by users_count desc from the query).
      const defaultIds = new Set(
        [
          book.default_physical_edition_id,
          book.default_ebook_edition_id,
          book.default_audio_edition_id,
        ].filter((id): id is number => id !== null),
      );
      const ranked = [
        ...editions.filter((edition) => defaultIds.has(edition.id)),
        ...editions.filter((edition) => !defaultIds.has(edition.id)),
      ];
      const identifiers = normalizeIdentifiers(
        ranked.flatMap((edition) => [edition.isbn_13, edition.isbn_10, edition.asin]),
      );
      const position = entry.position === null ? '?' : String(entry.position);
      works.push({
        identifiers,
        label: `${book.title} (#${position} in ${series.name})`,
        // Clean title feeds the conservative D-04 title fallback when a target
        // exposes no scheme'd ISBNs (e.g. Kavita epubs). Author is out of reach
        // here: the Hardcover GraphQL depth-3 cap already spends its budget on
        // series -> book_series -> book, so contributions would exceed it.
        title: book.title,
      });
    }

    await this.options.cache.set(cacheKey, works, this.cacheTtlMs);
    this.options.log.info(
      { ref, series: series.slug, works: works.length },
      'hardcover: resolved series',
    );
    return works;
  }

  /** Paced GraphQL request: all requests serialize and keep minIntervalMs apart. */
  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const turn = this.gate.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
    });
    // Keep the gate moving even if this request fails.
    this.gate = turn.catch(() => undefined);
    await turn;

    const token = this.options.token.startsWith('Bearer ')
      ? this.options.token
      : `Bearer ${this.options.token}`;
    const response = await fetchJson<{ data?: T; errors?: { message: string }[] }>(this.url, {
      method: 'POST',
      headers: { authorization: token, 'user-agent': 'libretto' },
      body: { query, variables },
    });
    if (response.errors && response.errors.length > 0) {
      throw new Error(`hardcover graphql error: ${response.errors[0]!.message}`);
    }
    if (response.data === undefined) {
      throw new Error('hardcover graphql response carried no data');
    }
    return response.data;
  }
}
