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
  /** Subset of matches resolved by the D-04 title fallback rather than an identifier. */
  matchedByTitle: number;
  /** Per-work match provenance, in work order (undefined = unmatched). */
  matchedVia: (('identifier' | 'title') | undefined)[];
  /** The full unmatched works (identities, not just labels) — feeds acquisition + the missing endpoint. */
  missingWorks: WorkItem[];
}

/**
 * Match an ordered work list against a target's library items. `titleFallbackEnabled` mirrors the
 * recipe's `variables.titleFallback` (identifier-only matching when false).
 */
export function matchWorks(
  works: readonly WorkItem[],
  items: readonly TargetItem[],
  titleFallbackEnabled: boolean,
): MatchResult {
  const byIdentifier = new Map<string, TargetItem>();
  for (const item of items) {
    for (const identifier of item.identifiers) {
      if (!byIdentifier.has(identifier)) byIdentifier.set(identifier, item);
    }
  }
  const titleIndex = titleFallbackEnabled ? new TitleIndex(items as TargetItem[]) : undefined;

  const matchedIds: string[] = [];
  const matchedSeen = new Set<string>();
  const missingWorks: WorkItem[] = [];
  const matchedVia: (('identifier' | 'title') | undefined)[] = [];
  let matchedByTitle = 0;

  for (const work of works) {
    let via: 'identifier' | 'title' | undefined;
    let item = work.identifiers
      .map((identifier) => byIdentifier.get(identifier))
      .find((candidate) => candidate !== undefined);
    if (item) {
      via = 'identifier';
    } else if (titleIndex) {
      const candidate = titleIndex.match(work.title, work.authors, matchedSeen);
      if (candidate) {
        item = items.find((one) => one.id === candidate.id);
        via = 'title';
      }
    }

    if (!item) {
      missingWorks.push(work);
      matchedVia.push(undefined);
    } else if (!matchedSeen.has(item.id)) {
      matchedSeen.add(item.id);
      matchedIds.push(item.id);
      matchedVia.push(via);
      if (via === 'title') matchedByTitle += 1;
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
