/**
 * Conservative title fallback (DESIGN-037 D-04, flagged).
 *
 * Identifier matching is the ceiling on targets that expose scheme'd ISBNs, but
 * some do not: Kavita only parses an epub ISBN when the OPF <dc:identifier>
 * carries opf:scheme="ISBN" (see target/kavita.ts), so a whole library can hit
 * 0/N by identifier alone. This module adds the ONE fallback D-04 sanctions: a
 * NOISE-STRIPPED EXACT full-title match, guarded by author agreement, borrowing
 * the conservative-pairing doctrine from haynesnetwork ADR-065.
 *
 * The doctrine, and why each rule earns its place:
 *
 *   - FULL-title equality after noise stripping, never substring/prefix. So the
 *     franchise umbrella "Harry Potter" never pairs with "Harry Potter and the
 *     Chamber of Secrets", and one volume never absorbs the next.
 *   - AMBIGUITY IS REFUSED, never guessed. If a normalized title maps to two or
 *     more distinct library items, or the author guard cannot pick one, the work
 *     goes to missing[] rather than mispair. This is the real hardening against
 *     franchise mispairs.
 *   - AUTHOR is a guard applied WHEN BOTH SIDES SUPPLY IT: disjoint authors veto
 *     a title match. When either side lacks author data (Kavita series carry
 *     none today) the full-title equality stands on its own — the fallback stays
 *     useful without inventing agreement it cannot verify.
 *
 * No fuzz: a US/UK title divergence like "Sorcerer's Stone" vs "Philosopher's
 * Stone" is an honest miss, not something to force with edit distance.
 */

/** Leading articles dropped so "The Martian" and "Martian" share a key. */
const LEADING_ARTICLE = /^(the|a|an)\s+/;

/**
 * Fold a title to its comparison key: diacritics stripped, bracketed/parenthetical
 * noise removed (edition/series tags like "(Illustrated)" or "[Book 1]"),
 * punctuation flattened to spaces, a leading article dropped, whitespace
 * collapsed. Returns '' when nothing comparable survives (an empty key never
 * matches anything).
 */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks (diacritics)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ') // (…) […] {…} edition/series noise
    .replace(/['’`ʼ]/g, '') // apostrophes join, so "Philosopher's" == "Philosophers"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(LEADING_ARTICLE, '')
    .trim();
}

/**
 * Significant, comparison-folded tokens of an author string (length >= 2, so
 * bare initials drop out). "J.K. Rowling", "J. K. Rowling" and "JK Rowling" all
 * reduce to a set containing "rowling"; agreement is a shared surname-ish token.
 */
function authorTokens(raw: string): Set<string> {
  const tokens = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length >= 2);
  return new Set(tokens);
}

/**
 * Author guard for a candidate title match. Conservative on both ends:
 *   - if EITHER side supplies no authors, agreement cannot be disproved -> true
 *     (the full-title equality carries the match on its own);
 *   - if BOTH supply authors, they must share at least one significant token,
 *     else the pairing is vetoed.
 */
export function authorsAgree(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || a.length === 0 || !b || b.length === 0) return true;
  const left = new Set<string>();
  for (const author of a) for (const token of authorTokens(author)) left.add(token);
  for (const author of b) {
    for (const token of authorTokens(author)) {
      if (left.has(token)) return true;
    }
  }
  return false;
}

/** A library item as the title fallback needs to see it. */
export interface TitleCandidate {
  id: string;
  title: string;
  authors?: string[];
}

/**
 * Build the title index once per reconcile. Keys are normalized titles; a key
 * that resolves to two or more DISTINCT items is marked ambiguous and can never
 * satisfy a match (library-side franchise collision -> refuse, never guess).
 */
export class TitleIndex {
  private readonly byKey = new Map<string, TitleCandidate[]>();

  constructor(items: TitleCandidate[]) {
    for (const item of items) {
      const key = normalizeTitle(item.title);
      if (key.length === 0) continue;
      const bucket = this.byKey.get(key);
      if (bucket) bucket.push(item);
      else this.byKey.set(key, [item]);
    }
  }

  /**
   * Resolve a work's title (and optional authors) to exactly one library item,
   * or undefined when there is no match, the key is empty, the library key is
   * ambiguous, or the author guard leaves anything other than a single survivor.
   * `claimed` excludes items already taken by an identifier or earlier title
   * match, so a run never binds two works to the same item.
   */
  match(
    title: string | undefined,
    authors: string[] | undefined,
    claimed: ReadonlySet<string>,
  ): TitleCandidate | undefined {
    if (title === undefined) return undefined;
    const key = normalizeTitle(title);
    if (key.length === 0) return undefined;
    const bucket = this.byKey.get(key);
    if (!bucket) return undefined;
    // Library-side ambiguity (two distinct titles collide) is refused up front,
    // even if some are already claimed — we will not guess which one was meant.
    if (bucket.length > 1) return undefined;
    const candidates = bucket.filter(
      (item) => !claimed.has(item.id) && authorsAgree(authors, item.authors),
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }
}
