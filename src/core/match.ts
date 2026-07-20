import type { WorkItem } from '../builders/index.js';
import { TitleIndex } from '../matching/title.js';
import type { TargetItem } from '../target/types.js';

/**
 * The identifier-first, title-fallback matcher shared by the reconciler (which writes the collection)
 * and the member-missing endpoint (which reports the wanted-but-unheld identities). Factored out so the
 * two surfaces can never drift: a book the reconciler counts as `missing` is exactly a book the missing
 * endpoint reports, resolved by the identical rules (DESIGN-037 D-04).
 */
export interface MatchResult {
  /** Target item ids matched, in work order (identifier match then conservative title fallback). */
  matchedIds: string[];
  /** Set of matched target item ids (a run never binds two works to one item). */
  matchedSeen: Set<string>;
  /**
   * Subset of matches resolved by conservative NAME equality rather than an identifier: the D-04
   * title fallback (work grain) OR the series-name match (series grain). Both use the same
   * noise-stripped, ambiguity-refusing index, so both are "flagged" here to stay distinguishable
   * from an identifier match. `matchedVia` carries the finer 'title' vs 'series' provenance.
   */
  matchedByTitle: number;
  /** Per-work match provenance, in work order (undefined = unmatched). */
  matchedVia: (('identifier' | 'title' | 'series') | undefined)[];
  /** The full unmatched works (identities, not just labels) — feeds acquisition + the missing endpoint. */
  missingWorks: WorkItem[];
}

export interface MatchOptions {
  /**
   * D-04 conservative title fallback (WORK grain only): when identifier matching leaves a work
   * unmatched, try a noise-stripped exact-title (+ author guard) match. Mirrors the recipe's
   * variables.titleFallback; false pins a work-grain recipe to identifier-only matching.
   */
  titleFallback: boolean;
  /**
   * Match grain (comics support, 2026-07-20):
   *   - 'work' (default): each work is a book/volume, matched by identifier then the D-04 title
   *     fallback. The historical behavior.
   *   - 'series': each work IS a whole series (comics/manga), matched by conservative normalized
   *     SERIES-NAME equality against the target's series — because a target like Kavita stores a
   *     whole comic as ONE series of volume-chapters, so per-volume matching hits 0/N and comics
   *     expose no scheme'd ISBNs. There is no identifier path at series grain and `titleFallback`
   *     is irrelevant (name equality IS the match, always on). Matches flag matchedVia 'series'.
   */
  grain?: 'work' | 'series';
}

/** Match an ordered work list against a target's library items (work grain by default). */
export function matchWorks(
  works: readonly WorkItem[],
  items: readonly TargetItem[],
  options: MatchOptions,
): MatchResult {
  const grain = options.grain ?? 'work';
  const seriesGrain = grain === 'series';

  const byIdentifier = new Map<string, TargetItem>();
  if (!seriesGrain) {
    for (const item of items) {
      for (const identifier of item.identifiers) {
        if (!byIdentifier.has(identifier)) byIdentifier.set(identifier, item);
      }
    }
  }
  // The name index backs both the D-04 title fallback (work grain, opt-out) and series-grain
  // matching (always on — it is the sole match path there).
  const nameIndex =
    seriesGrain || options.titleFallback ? new TitleIndex(items as TargetItem[]) : undefined;

  const matchedIds: string[] = [];
  const matchedSeen = new Set<string>();
  const missingWorks: WorkItem[] = [];
  const matchedVia: (('identifier' | 'title' | 'series') | undefined)[] = [];
  let matchedByTitle = 0;

  for (const work of works) {
    let via: 'identifier' | 'title' | 'series' | undefined;
    let item: TargetItem | undefined;
    if (seriesGrain) {
      const candidate = nameIndex!.match(work.title, work.authors, matchedSeen);
      if (candidate) {
        item = items.find((one) => one.id === candidate.id);
        via = 'series';
      }
    } else {
      item = work.identifiers
        .map((identifier) => byIdentifier.get(identifier))
        .find((candidate) => candidate !== undefined);
      if (item) {
        via = 'identifier';
      } else if (nameIndex) {
        const candidate = nameIndex.match(work.title, work.authors, matchedSeen);
        if (candidate) {
          item = items.find((one) => one.id === candidate.id);
          via = 'title';
        }
      }
    }

    if (!item) {
      missingWorks.push(work);
      matchedVia.push(undefined);
    } else if (!matchedSeen.has(item.id)) {
      matchedSeen.add(item.id);
      matchedIds.push(item.id);
      matchedVia.push(via);
      if (via === 'title' || via === 'series') matchedByTitle += 1;
    } else {
      // The item is already claimed by an earlier work — this work neither matches nor is missing.
      matchedVia.push(via);
    }
  }

  return { matchedIds, matchedSeen, matchedByTitle, matchedVia, missingWorks };
}

/** One missing member's identity, enough for a consumer to mint a request row (title/author/ISBN/refs). */
export interface MissingMember {
  /** The builder's human handle ("Wind and Truth (#5 in The Stormlight Archive)"). */
  label: string;
  /** Clean work title. */
  title: string | null;
  /** Author names, when the builder supplied them. */
  authors: string[];
  /** Primary ISBN-13 (first isbn: identifier), when known. */
  isbn: string | null;
  /** All normalized identifiers (isbn:/asin:/opaque) — the "ll ref" set for acquisition. */
  identifiers: string[];
}

/** Project an unmatched WorkItem to its wire identity for the missing endpoint. */
export function toMissingMember(work: WorkItem): MissingMember {
  return {
    label: work.label,
    title: work.title ?? null,
    authors: work.authors ?? [],
    isbn: work.identifiers.find((id) => id.startsWith('isbn:'))?.slice('isbn:'.length) ?? null,
    identifiers: work.identifiers,
  };
}

/**
 * One resolved member's identity for the draft PREVIEW endpoint (M4 builder page). This is the
 * full resolved membership a run would produce — NOT just the missing ones — so the app can split
 * it into held vs missing against its own mirrors. `author` is the primary (first) author for a
 * compact tile; `position` is the series position / list rank when the source exposes one.
 */
export interface PreviewMember {
  /** The builder's human handle ("Wind and Truth (#5 in The Stormlight Archive)"). */
  label: string;
  /** Clean work title. */
  title: string | null;
  /** Primary author, when the builder supplied one. */
  author: string | null;
  /** Primary ISBN-13 (first isbn: identifier), when known. */
  isbn: string | null;
  /** Series position / list rank, when the source is ordered. */
  position: number | null;
  /** All normalized identifiers (isbn:/asin:/opaque) — the app's held-match keys. */
  identifiers: string[];
}

/** Project a resolved WorkItem to its wire identity for the preview endpoint. */
export function toPreviewMember(work: WorkItem): PreviewMember {
  return {
    label: work.label,
    title: work.title ?? null,
    author: work.authors?.[0] ?? null,
    isbn: work.identifiers.find((id) => id.startsWith('isbn:'))?.slice('isbn:'.length) ?? null,
    position: work.position ?? null,
    identifiers: work.identifiers,
  };
}
