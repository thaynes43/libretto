import type { WorkItem } from '../builders/index.js';
import { findCompilations, isCompilationTitle } from './compilation.js';
import { coreTitles, normalizeTitle, TitleIndex } from '../matching/title.js';
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
   * from an identifier match. `matchedVia` carries the finer 'title'/'title_author'/'series'
   * provenance.
   */
  matchedByTitle: number;
  /**
   * Per-work match provenance, in work order (undefined = unmatched):
   *   - 'identifier'   — an exact identifier hit (the ceiling);
   *   - 'title'        — the conservative title fallback, no author on the work to guard with;
   *   - 'title_author' — the title fallback WITH an author guard actively in play (the honest
   *     flag for `{ title, author }` static entries — ADR-076 C-07);
   *   - 'series'       — series-grain name equality (comics).
   */
  matchedVia: (('identifier' | 'title' | 'title_author' | 'series') | undefined)[];
  /** The full unmatched works (identities, not just labels) — feeds acquisition + the missing endpoint. */
  missingWorks: WorkItem[];
  /**
   * Unmatched works that are compilation editions (box set, omnibus, "Series: 1-5") of individual members
   * the recipe also lists (libretto#18). Kept OUT of `missingWorks` so neither the missing report nor
   * acquisition chases a box set of books already held; reported separately and flagged on the wire.
   */
  compilationWorks: WorkItem[];
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
  /**
   * The work list is ONE series (a `hardcover_series` recipe), so a packaged compilation in it is a
   * compilation of its neighbours and is kept out of `missingWorks` (libretto#18). Default false: an
   * unrelated box set in a mixed list stays an ordinary missing work.
   */
  oneSeries?: boolean;
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
  // Series grain matches the series NAME only; book-level titles (TargetItem.books) are a work-grain index.
  const nameIndex =
    seriesGrain || options.titleFallback
      ? new TitleIndex(
          seriesGrain
            ? items.map(({ id, title, authors }) => ({
                id,
                title,
                ...(authors ? { authors } : {}),
              }))
            : items,
          isCompilationTitle,
        )
      : undefined;
  // The decorated-title pass refuses a key two members share, unless both name the same volume (a source
  // that lists one book twice). A member's volume is its series position, else the one its title names.
  const keyOwners = new Map<string, { work: WorkItem; volume: number | undefined }[]>();
  if (!seriesGrain && nameIndex) {
    for (const work of works) {
      if (work.title === undefined) continue;
      const cores = coreTitles(work.title, work.series, isCompilationTitle);
      const volume = work.position ?? cores.find((core) => core.volume !== undefined)?.volume;
      const keys = new Set([normalizeTitle(work.title), ...cores.map((core) => core.key)]);
      for (const key of keys) {
        if (key.length === 0) continue;
        const owners = keyOwners.get(key) ?? [];
        owners.push({ work, volume });
        keyOwners.set(key, owners);
      }
    }
  }
  const sharedKeyFor =
    (work: WorkItem) =>
    (key: string): boolean => {
      const owners = keyOwners.get(key) ?? [];
      const own = owners.find((owner) => owner.work === work)?.volume;
      return owners.some(
        (owner) =>
          owner.work !== work &&
          (own === undefined || owner.volume === undefined || owner.volume !== own),
      );
    };
  // What matches have taken: an item's id, or one book of an item that holds several (TitleIndex claims).
  const claimed = new Set<string>();

  const matchedIds: string[] = [];
  const matchedSeen = new Set<string>();
  const missingWorks: WorkItem[] = [];
  const compilationWorks: WorkItem[] = [];
  // Work grain only: a series-grain "work" is a whole series, never a box set of one.
  const compilations =
    !seriesGrain && options.oneSeries ? findCompilations(works) : new Set<WorkItem>();
  const matchedVia: (('identifier' | 'title' | 'title_author' | 'series') | undefined)[] = [];
  let matchedByTitle = 0;

  for (const work of works) {
    let via: 'identifier' | 'title' | 'title_author' | 'series' | undefined;
    let item: TargetItem | undefined;
    if (seriesGrain) {
      const hit = nameIndex!.find(work.title, work.authors, claimed);
      if (hit) {
        claimed.add(hit.claim);
        item = items.find((one) => one.id === hit.item.id);
        via = 'series';
      }
    } else {
      item = work.identifiers
        .map((identifier) => byIdentifier.get(identifier))
        .find((candidate) => candidate !== undefined);
      if (item) {
        claimed.add(item.id);
        via = 'identifier';
      } else if (nameIndex) {
        // The exact title first; only a title the library carries nowhere tries the decorated pass, so
        // an exact key that was refused (ambiguous, author-vetoed, claimed) stays refused.
        const hit =
          nameIndex.find(work.title, work.authors, claimed) ??
          (nameIndex.has(work.title)
            ? undefined
            : nameIndex.findDecorated(
                {
                  title: work.title,
                  authors: work.authors,
                  position: work.position,
                  series: work.series,
                },
                claimed,
                sharedKeyFor(work),
              ));
        if (hit) {
          claimed.add(hit.claim);
          item = items.find((one) => one.id === hit.item.id);
          // Flag an author-guarded title match distinctly (ADR-076 C-07): a work that carries its
          // own author (e.g. a { title, author } static entry) matched via title_author.
          via = work.authors && work.authors.length > 0 ? 'title_author' : 'title';
        }
      }
    }

    if (!item) {
      (compilations.has(work) ? compilationWorks : missingWorks).push(work);
      matchedVia.push(undefined);
    } else if (!matchedSeen.has(item.id)) {
      matchedSeen.add(item.id);
      matchedIds.push(item.id);
      matchedVia.push(via);
      if (via === 'title' || via === 'title_author' || via === 'series') matchedByTitle += 1;
    } else {
      // The item is already claimed by an earlier work — this work neither matches nor is missing.
      matchedVia.push(via);
    }
  }

  return { matchedIds, matchedSeen, matchedByTitle, matchedVia, missingWorks, compilationWorks };
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
  /** Always true when present: this member is a compilation edition (libretto#18). Only set on `compilations[]`. */
  compilation?: true;
}

/** Project an unmatched WorkItem to its wire identity for the missing endpoint. */
export function toMissingMember(work: WorkItem, compilation = false): MissingMember {
  return {
    label: work.label,
    title: work.title ?? null,
    authors: work.authors ?? [],
    isbn: work.identifiers.find((id) => id.startsWith('isbn:'))?.slice('isbn:'.length) ?? null,
    identifiers: work.identifiers,
    ...(compilation ? { compilation: true as const } : {}),
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
  /** Present (true) only when this member is a compilation edition of other listed members (libretto#18). */
  compilation?: true;
}

/** Project a resolved WorkItem to its wire identity for the preview endpoint. */
export function toPreviewMember(work: WorkItem, compilation = false): PreviewMember {
  return {
    label: work.label,
    title: work.title ?? null,
    author: work.authors?.[0] ?? null,
    isbn: work.identifiers.find((id) => id.startsWith('isbn:'))?.slice('isbn:'.length) ?? null,
    position: work.position ?? null,
    identifiers: work.identifiers,
    ...(compilation ? { compilation: true as const } : {}),
  };
}
