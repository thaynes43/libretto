import type { WorkItem } from '../builders/index.js';

/**
 * Unnumbered series books in a recipe's member list (libretto#30): a member, never fetched.
 *
 * A `hardcover_series` list keeps one book with no series position (Hardcover's `distinct_on: position` folds every
 * unnumbered book into one, the most read). Most of them are companions rather than books of the series: a coloring
 * book, a guide, a pocket companion, a cookbook. Some are real reads (a play, a story collection). The owner's ruling
 * (2026-10-07) treats them all the way compilations are treated: a held one matches and stays in the collection, but an
 * unheld one is never reported missing and never acquired. The builder's own drops still come first (an unnumbered
 * duplicate of a numbered book, a book only in another language: `leftOutSeriesBooks`).
 *
 * A work is UNNUMBERED when it names its series (only a series builder sets `series`) and has no position. It is only
 * treated as one when (a) the builder lists ONE series (`listsOneSeries`) and (b) the list ALSO holds a numbered
 * member: a series with no numbering at all is its books, so they stay wanted.
 */

/** Is this work a series book with no position in its series? */
export function isUnnumberedSeriesWork(work: WorkItem): boolean {
  return work.series !== undefined && work.position === undefined;
}

/**
 * The works of `works` that are unnumbered books of the series the others are numbered in. Empty unless the list also
 * holds at least one numbered member.
 */
export function findUnnumbered(works: readonly WorkItem[]): Set<WorkItem> {
  const unnumbered = new Set(works.filter(isUnnumberedSeriesWork));
  if (unnumbered.size === 0 || unnumbered.size === works.length) return new Set();
  return unnumbered;
}
