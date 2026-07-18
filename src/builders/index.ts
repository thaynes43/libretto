import type { DiskCache } from '../cache/disk.js';
import type { AppConfig } from '../config.js';
import { normalizeIdentifier } from '../identifiers.js';
import type { Logger } from '../logger.js';
import type { Recipe } from '../recipes/schema.js';
import { HardcoverSeriesSource } from './hardcover.js';
import { NytListSource, searchNytLists } from './nyt.js';

/**
 * A unit of work a builder wants in the collection. A work can be known by
 * several identifiers (an ISBN-13 and an ASIN for the same book); it matches a
 * library item when ANY of them matches (D-04 — still exact-string, never fuzz).
 * The label is what missing[] reports when nothing matches.
 */
export interface WorkItem {
  /** Normalized identifiers (see identifiers.ts), any-match, order = preference. */
  identifiers: string[];
  /** Human-readable handle for the missing report (title when known, else the id). */
  label: string;
  /**
   * Clean work title for the conservative D-04 title fallback (distinct from the
   * decorated `label`). Undefined when the builder has no title to offer (e.g.
   * static_ids), which simply means this work never participates in the fallback.
   */
  title?: string;
  /** Author names for the fallback's author guard, when the builder supplies them. */
  authors?: string[];
  /**
   * Ordinal position within the source ordering (series position, list rank) when the
   * builder exposes one. Purely for display in the member preview (M4 builder page); the
   * matcher never reads it. Undefined for order-free sources (static_ids).
   */
  position?: number;
}

/**
 * One typeahead search hit (M4 builder-page search): the `ref` a user can paste straight
 * into a recipe's builder, a human-readable name, and — when the source exposes them —
 * an approximate member count and the primary author/attribution. The same shape backs
 * every searchable builder (hardcover_series, nyt_list); static_ids returns none.
 */
export interface BuilderSearchResult {
  /** The value to place in `builder.ref` (a Hardcover series id, an NYT list_name_encoded). */
  ref: string;
  /** Human-readable name to show in the typeahead. */
  name: string;
  /** Approximate member count, when the source exposes one (Hardcover primary_books_count). */
  workCount?: number;
  /** Primary author/attribution, when known. */
  author?: string;
}

/** A bounded typeahead search response: the hits plus whether the source had more. */
export interface BuilderSearchResponse {
  results: BuilderSearchResult[];
  /** True when the source reported more matches than were returned (cap hit). */
  truncated: boolean;
}

export interface BuilderInfo {
  type: string;
  description: string;
  /** Human-readable shape of builder.ref (drives docs and API consumers). */
  ref: string;
  /** Whether this Libretto instance can run the builder right now (env present). */
  available: boolean;
  note?: string;
}

/**
 * External-source dependencies builders resolve through. Absent entries mean the
 * corresponding env is not configured; using such a builder fails honestly at
 * run time, never at boot (validated at use, like target credentials).
 */
export interface BuilderContext {
  /** Hardcover series source (undefined until HARDCOVER_TOKEN is set). */
  hardcoverSeries?: {
    seriesWorks(ref: string): Promise<WorkItem[]>;
    /** Typeahead search over Hardcover series (M4 builder page); optional (validated at use). */
    searchSeries?(query: string, limit: number): Promise<BuilderSearchResponse>;
  };
  /** NYT bestseller-list source (undefined until NYT_API_KEY is set). */
  nytList?: { listWorks(ref: string): Promise<WorkItem[]> };
}

/** Wire the builder sources whose env is present (validated at use, not boot). */
export function createBuilderContext(
  config: AppConfig,
  cache: DiskCache,
  log: Logger,
): BuilderContext {
  const ctx: BuilderContext = {};
  if (config.hardcoverToken !== undefined) {
    ctx.hardcoverSeries = new HardcoverSeriesSource({ token: config.hardcoverToken, cache, log });
  }
  if (config.nytApiKey !== undefined) {
    ctx.nytList = new NytListSource({ apiKey: config.nytApiKey, cache, log });
  }
  return ctx;
}

/** M2 builder set (DESIGN-037 D-05): static_ids (the tracer) + hardcover_series. */
export function builderInfos(ctx: BuilderContext): BuilderInfo[] {
  return [
    {
      type: 'static_ids',
      description: 'An ordered identifier list inlined in the recipe. No external source.',
      ref: 'array of identifier strings (order is the collection order)',
      available: true,
    },
    {
      type: 'hardcover_series',
      description:
        'All books of a Hardcover series, ordered by series position. Positions the library lacks become missing[].',
      ref: 'a Hardcover series id or slug',
      available: ctx.hardcoverSeries !== undefined,
      ...(ctx.hardcoverSeries === undefined ? { note: 'set HARDCOVER_TOKEN to enable' } : {}),
    },
    {
      type: 'nyt_list',
      description:
        'A New York Times bestseller list, ordered by rank. Matched works become the collection; ' +
        'missing works flow to LazyLibrarian when acquisition is enabled (chase the current list).',
      ref: 'a NYT list_name_encoded slug (e.g. hardcover-fiction, combined-print-and-e-book-fiction)',
      available: ctx.nytList !== undefined,
      ...(ctx.nytList === undefined ? { note: 'set NYT_API_KEY to enable' } : {}),
    },
  ];
}

/**
 * Resolve a builder to its ordered work list (deduplicated, first wins). Takes the builder
 * directly (not the whole recipe) so the draft-preview path (M4) can resolve an UNSAVED
 * builder without synthesizing a full recipe.
 */
export async function resolveBuilder(
  builder: Recipe['builder'],
  ctx: BuilderContext,
): Promise<WorkItem[]> {
  switch (builder.type) {
    case 'static_ids': {
      const seen = new Set<string>();
      const works: WorkItem[] = [];
      for (const raw of builder.ref) {
        const identifier = normalizeIdentifier(raw);
        if (seen.has(identifier)) continue;
        seen.add(identifier);
        works.push({ identifiers: [identifier], label: identifier });
      }
      return works;
    }
    case 'hardcover_series': {
      if (!ctx.hardcoverSeries) {
        throw new Error(
          'the hardcover_series builder needs HARDCOVER_TOKEN (validated at use, not at boot)',
        );
      }
      return ctx.hardcoverSeries.seriesWorks(String(builder.ref));
    }
    case 'nyt_list': {
      if (!ctx.nytList) {
        throw new Error('the nyt_list builder needs NYT_API_KEY (validated at use, not at boot)');
      }
      return ctx.nytList.listWorks(builder.ref);
    }
  }
}

/**
 * Typeahead search for a builder's ref (M4 builder page): find the series/list by typing a
 * name, so a user never pastes a slug. Bounded server-side (the client debounces). Throws
 * UnknownBuilderError for an unrecognized type and BuilderUnavailableError when the source is
 * not configured — the API maps those to 400 and 503; static_ids has no searchable ref (empty).
 */
export async function searchBuilder(
  type: string,
  query: string,
  limit: number,
  ctx: BuilderContext,
): Promise<BuilderSearchResponse> {
  const q = query.trim();
  switch (type) {
    case 'static_ids':
      // Free-form identifier entry — there is nothing to search.
      return { results: [], truncated: false };
    case 'hardcover_series': {
      if (!ctx.hardcoverSeries?.searchSeries) {
        throw new BuilderUnavailableError('hardcover_series search needs HARDCOVER_TOKEN');
      }
      if (q.length === 0) return { results: [], truncated: false };
      return ctx.hardcoverSeries.searchSeries(q, limit);
    }
    case 'nyt_list':
      // Static, key-free: the well-known list_name_encoded set filtered by substring.
      return searchNytLists(q, limit);
    default:
      throw new UnknownBuilderError(type);
  }
}

/** The search `type` param named a builder this Libretto does not know. */
export class UnknownBuilderError extends Error {
  constructor(type: string) {
    super(`unknown builder type "${type}"`);
    this.name = 'UnknownBuilderError';
  }
}

/** The builder is known but its source is not configured (env absent). */
export class BuilderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuilderUnavailableError';
  }
}
