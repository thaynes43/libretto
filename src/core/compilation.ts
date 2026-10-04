import type { WorkItem } from '../builders/index.js';
import type { Builder } from '../recipes/schema.js';
import { OMNIBUS_STRONG } from '../resolve/google-books.js';

/**
 * Compilation editions in a recipe's member list (libretto#18).
 *
 * A series source (Hardcover) sometimes lists a box set or omnibus next to the individual books it
 * contains ("Shatter Me Series: 1-5", "The Dark Artifices, the Complete Collection"). Held books can
 * never match it, so it would sit in `missing[]` forever and a consumer would buy a box set of books it
 * already owns. A work is a COMPILATION when its title carries the same packaging signals as the resolve
 * broker's omnibus guard (box set, bundle, omnibus, starter pack, "N-Book", ...) plus the list-shaped ones
 * the guard does not need ("Books 1-5", "Series: 1-5", "Complete Collection").
 *
 * It is only treated as one when (a) the builder lists ONE series (`hardcover_series`), so a box set in the
 * list is by construction a compilation of the individual books beside it, and (b) the list ALSO holds an
 * individual member: a recipe whose only member is a box set wants that box set. A `static_ids` or
 * `nyt_list` recipe mixes unrelated titles, so there a box set is an ordinary wanted work.
 */

/** Builders whose whole work list is one series, the only source where a box set is "of" its neighbours. */
export function listsOneSeries(builder: Builder): boolean {
  return builder.type === 'hardcover_series';
}
const COMPILATION_EXTRA = [
  /\b(?:books?|volumes?|vols?\.?)\s*\d+\s*(?:-|\u2013|\u2014|to|through)\s*\d+\b/i, // "Books 1-5"
  /\bseries\s*:?\s*\d+\s*(?:-|\u2013|\u2014)\s*\d+\b/i, // "Shatter Me Series: 1-5"
  /\b(?:complete|ultimate|essential)\s+(?:collection|series|saga|set|boxed set)\b/i,
];

/** Does this title read as a packaged compilation edition (box set, omnibus, "Books 1-5", ...)? */
export function isCompilationTitle(title: string | undefined): boolean {
  if (!title) return false;
  return OMNIBUS_STRONG.test(title) || COMPILATION_EXTRA.some((re) => re.test(title));
}

/**
 * The works of `works` that are compilations of OTHER listed members. Empty unless the list also holds at
 * least one individual (non-compilation) member.
 */
export function findCompilations(works: readonly WorkItem[]): Set<WorkItem> {
  const compilations = new Set(works.filter((work) => isCompilationTitle(work.title)));
  if (compilations.size === 0 || compilations.size === works.length) return new Set();
  return compilations;
}
