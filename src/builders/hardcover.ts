import type { DiskCache } from '../cache/disk.js';
import { fetchJson } from '../http.js';
import { normalizeIdentifiers } from '../identifiers.js';
import type { Logger } from '../logger.js';
import type { BuilderSearchResponse, BuilderSearchResult, WorkItem } from './index.js';

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
  /** How long a typeahead search result stays cached (default 1 hour; softens rate limits). */
  searchCacheTtlMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_URL = 'https://api.hardcover.app/v1/graphql';
const DEFAULT_MIN_INTERVAL_MS = 1100;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
const EDITIONS_CHUNK = 100;
/** Hard ceiling on typeahead hits regardless of the caller's asked-for limit. */
const SEARCH_MAX_RESULTS = 25;

/**
 * Typeahead search over Hardcover series (M4 builder page). The `search` query is Hardcover's
 * Typesense-backed index; `results` is the raw Typesense response (found + hits[].document).
 * A Series document carries { id, name, slug, author_name, primary_books_count, books_count }
 * (verified live against api.hardcover.app, 2026-07). We key the recipe ref off the numeric
 * `id` (stable; the seriesWorks resolver accepts an id or a slug) and prefer
 * primary_books_count (the canonical series entries) as the member-count hint.
 */
const SEARCH_QUERY = `
query LibrettoSeriesSearch($q: String!, $perPage: Int!) {
  search(query: $q, query_type: "Series", per_page: $perPage, page: 1) {
    results
  }
}`;

interface HardcoverSeriesDocument {
  id?: number | string | null;
  name?: string | null;
  slug?: string | null;
  author_name?: string | null;
  primary_books_count?: number | null;
  books_count?: number | null;
}

interface HardcoverSearchData {
  search: {
    results?: {
      found?: number | null;
      hits?: { document?: HardcoverSeriesDocument | null }[] | null;
    } | null;
  } | null;
}

/**
 * Series METADATA only (name/slug/id) for the comics grain (hardcover_comics). At series grain a
 * whole Hardcover series maps to ONE target series by name, so resolving book_series + editions
 * (which SERIES_QUERY does) would be wasted work — this fetches just what the series-name match
 * needs. Still depth-safe (single flat select).
 */
const SERIES_META_QUERY = `
query LibrettoComicSeries($where: series_bool_exp!) {
  series(where: $where, limit: 1) {
    id
    name
    slug
  }
}`;

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

interface SeriesMetaQueryData {
  series: { id: number; name: string; slug: string }[];
}

/** A comics-grain series unit: the Hardcover series id (for dedup) plus its series-name WorkItem. */
interface ComicSeriesUnit {
  id: number;
  work: WorkItem;
}

export class HardcoverSeriesSource {
  private readonly url: string;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly searchCacheTtlMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly options: HardcoverSeriesSourceOptions) {
    this.url = options.url ?? DEFAULT_URL;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.searchCacheTtlMs = options.searchCacheTtlMs ?? DEFAULT_SEARCH_CACHE_TTL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Resolve a series ref (numeric id or slug) to its ordered work list. */
  async seriesWorks(ref: string): Promise<WorkItem[]> {
    // Bump the key version whenever the cached WorkItem shape changes — a live
    // pod otherwise serves pre-change entries for the full TTL (D-04's title
    // fallback matched 0 in production because v1 entries carried no `title`).
    // v3 adds WorkItem.position (series position) for the M4 member preview.
    const cacheKey = `hardcover:series-works:v3:${ref}`;
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
        ...(entry.position === null ? {} : { position: entry.position }),
      });
    }

    await this.options.cache.set(cacheKey, works, this.cacheTtlMs);
    this.options.log.info(
      { ref, series: series.slug, works: works.length },
      'hardcover: resolved series',
    );
    return works;
  }

  /**
   * Resolve a SET of Hardcover series refs to SERIES-grain works for the comics grain
   * (hardcover_comics builder). Each ref becomes ONE WorkItem whose `title` is the Hardcover
   * series NAME — the unit the series-grain matcher pairs (by conservative name equality) with a
   * single target series. No volumes, no identifiers (comics expose none); acquisition is out of
   * scope. Deduplicated by Hardcover series id (a ref repeated, or two refs resolving to the same
   * series, collapses), preserving ref order = collection order.
   */
  async comicSeries(refs: readonly string[]): Promise<WorkItem[]> {
    const works: WorkItem[] = [];
    const seen = new Set<number>();
    for (const ref of refs) {
      const unit = await this.comicSeriesUnit(String(ref));
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      works.push(unit.work);
    }
    return works;
  }

  /** Resolve one series ref (numeric id or slug) to its series-name unit (cached, own key space). */
  private async comicSeriesUnit(ref: string): Promise<ComicSeriesUnit> {
    // Own cache namespace, independent of series-works: this shape is {id, name-only WorkItem},
    // so it never collides with (or is invalidated by) the series-works:vN key. Bump this vN if
    // the ComicSeriesUnit shape ever changes, or a live pod serves stale entries for the full TTL.
    const cacheKey = `hardcover:comic-series:v1:${ref}`;
    const cached = await this.options.cache.get<ComicSeriesUnit>(cacheKey);
    if (cached !== undefined) {
      this.options.log.debug(
        { ref, series: cached.work.title },
        'hardcover: comic-series cache hit',
      );
      return cached;
    }

    const where = /^\d+$/.test(ref) ? { id: { _eq: Number(ref) } } : { slug: { _eq: ref } };
    const data = await this.request<SeriesMetaQueryData>(SERIES_META_QUERY, { where });
    const series = data.series[0];
    if (!series) {
      throw new Error(`hardcover series "${ref}" not found (ref must be a series id or slug)`);
    }
    const unit: ComicSeriesUnit = {
      id: series.id,
      // At series grain the series NAME is both the match key (title) and the missing-report handle
      // (label). identifiers stays empty — comics carry no scheme'd ISBNs, matching is name-only.
      work: { identifiers: [], label: series.name, title: series.name },
    };
    await this.options.cache.set(cacheKey, unit, this.cacheTtlMs);
    this.options.log.info(
      { ref, series: series.slug, name: series.name },
      'hardcover: resolved comic series',
    );
    return unit;
  }

  /**
   * Typeahead search over Hardcover series (M4 builder page). Returns bounded {ref, name,
   * workCount?, author?} hits so a user finds a series by name instead of pasting a slug. Paced
   * through the same rate-limit gate as seriesWorks and cached (short TTL) so repeated keystrokes
   * on the same prefix do not re-hit Hardcover.
   */
  async searchSeries(query: string, limit: number): Promise<BuilderSearchResponse> {
    const q = query.trim();
    const perPage = Math.min(Math.max(limit, 1), SEARCH_MAX_RESULTS);
    if (q.length === 0) return { results: [], truncated: false };

    const cacheKey = `hardcover:series-search:v1:${perPage}:${q.toLowerCase()}`;
    const cached = await this.options.cache.get<BuilderSearchResponse>(cacheKey);
    if (cached !== undefined) {
      this.options.log.debug({ q, hits: cached.results.length }, 'hardcover: search cache hit');
      return cached;
    }

    const data = await this.request<HardcoverSearchData>(SEARCH_QUERY, { q, perPage });
    const raw = data.search?.results;
    const hits = Array.isArray(raw?.hits) ? raw.hits : [];
    const found = typeof raw?.found === 'number' ? raw.found : hits.length;

    const results: BuilderSearchResult[] = [];
    for (const hit of hits) {
      const doc = hit.document;
      if (!doc || doc.id === null || doc.id === undefined) continue;
      const ref = String(doc.id);
      const primary = doc.primary_books_count;
      const total = doc.books_count;
      const workCount =
        typeof primary === 'number' && primary > 0
          ? primary
          : typeof total === 'number' && total > 0
            ? total
            : undefined;
      results.push({
        ref,
        name: doc.name ?? ref,
        ...(workCount !== undefined ? { workCount } : {}),
        ...(doc.author_name ? { author: doc.author_name } : {}),
      });
      if (results.length >= limit) break;
    }

    const out: BuilderSearchResponse = { results, truncated: found > results.length };
    await this.options.cache.set(cacheKey, out, this.searchCacheTtlMs);
    this.options.log.info({ q, hits: results.length, found }, 'hardcover: resolved series search');
    return out;
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
