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
  /**
   * The books the item holds, when it can hold several (a Kavita series), each as the titles that book
   * is known by. Indexed beside `title`; see TargetItem.books.
   */
  books?: string[][];
  authors?: string[];
  /** Credited people that only verify duplicates, never veto a match (TargetItem.writers). */
  writers?: string[];
  /** Folders holding the item's files; only verify duplicates (TargetItem.folders). */
  folders?: string[];
}

/** A title match: the item, and the claim it takes (the item, or one book of a many-book item). */
export interface TitleHit {
  item: TitleCandidate;
  claim: string;
}

/** The work side of a decorated-title match (issue thaynes43/haynesnetwork#759). */
export interface DecoratedWork {
  title: string | undefined;
  authors: string[] | undefined;
  /** Series position, when the source orders the list by one. */
  position?: number | undefined;
  /** The series the work belongs to, when the source names it. */
  series?: string | undefined;
}

/** One way an item is named: the raw title, what a match on it claims, and whether it names a book inside the item. */
interface TitleEntry {
  item: TitleCandidate;
  raw: string;
  claim: string;
  book: boolean;
}

/** A decoration-stripped form of a title: its key, and the volume number the decoration named. */
export interface CoreTitle {
  key: string;
  volume?: number;
  /**
   * The decoration named a volume and nothing else ("Shadow and Bone: Book 3"), so what is left may be the
   * SERIES name rather than this book's title. Such a core pairs only with a side that names the same volume.
   */
  bare?: true;
}

/** Separates a title from its subtitle: a colon, a double hyphen, or a spaced dash. */
const SUBTITLE_SEPARATOR = /\s*(?::|--|\s[-–—]\s)\s*/;

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};
const NUMBER = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})`;

/** "Book 2", "Book Two", "Vol. 3", "#4": a subtitle that names a volume. */
const MARKED_VOLUME = new RegExp(`(?:\\b(?:book|bk|volume|vol)\\.?\\s*|#\\s*)${NUMBER}\\b`, 'i');
/**
 * "Legacy of Orisha 3": a subtitle that ends in a series position after at least two words of series name. One
 * word plus a number ("Year 1", "Apollo 13") is too often part of the title, and so is a part, an episode, a day.
 */
const TRAILING_POSITION = /[a-z][a-z'’]*\s+[a-z][a-z'’]*\s+(\d{1,2})\s*$/i;
const NOT_A_POSITION = /\b(?:part|year|episode|chapter|day|act|phase|season|apollo)\b/i;
/** Words a volume marker is made of, which do not name a series ("Book Two of the series"). */
const MARKER_WORDS = new Set([
  'book',
  'bk',
  'volume',
  'vol',
  'of',
  'the',
  'a',
  'an',
  'series',
  'unabridged',
  'abridged',
  ...Object.keys(NUMBER_WORDS),
]);
/** "A Mistborn Novel", "(Unabridged)": a subtitle that names the form, not the book. */
const FORM_WORD = /\b(?:novel|novella|novelette|unabridged|abridged)\b/i;
/**
 * A subtitle that names ANOTHER work or a different thing (an adaptation, a companion, a bundle, an extra), so
 * dropping it would let a different book satisfy a member: never decoration.
 */
const OTHER_WORK =
  /\b(?:graphic|manga|comic|omnibus|box(?:ed)?\s?set|bundle|collection|anthology|companion|guide|epilogue|prequel|sequel|stories|short|excerpt|sampler|preview|summary|study)\b/i;
/** "Expanse 03 - Abaddon's Gate", "The Expanse, Book 3 - Abaddon's Gate": a series-position prefix. */
const POSITION_PREFIX = new RegExp(
  `^(.*?[a-z].*?)[\\s,]+(?:#\\s*|no\\.?\\s*|book\\s+|bk\\.?\\s*|vol(?:ume)?\\.?\\s*)?(\\d{1,2})(?:\\.\\d+)?\\s+[-\\u2013\\u2014]\\s+(.+)$`,
  'i',
);

function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if (lower in NUMBER_WORDS) return NUMBER_WORDS[lower];
  const value = Number(lower);
  return Number.isFinite(value) ? value : undefined;
}

/** True when `inner` occurs in `outer` as whole words (both normalized keys). */
function containsWords(outer: string, inner: string): boolean {
  return inner.length > 0 && ` ${outer} `.includes(` ${inner} `);
}

/** Does this stretch of a subtitle hold any word that is not part of a volume marker? */
function namesWords(text: string): boolean {
  return normalizeTitle(text)
    .split(' ')
    .some((word) => word.length > 0 && !MARKER_WORDS.has(word) && !/^\d+$/.test(word));
}

/**
 * Is this subtitle decoration (it names the series, a position or the form) rather than part of the title?
 * Returns the volume it names (none when it names the form only) and whether it named ONLY a volume, or null
 * when it is NOT decoration.
 */
function decoration(
  tail: string,
  headKey: string,
  compilation: (t: string) => boolean,
): { volume?: number; bare?: true } | null {
  if (OTHER_WORK.test(tail) || compilation(tail)) return null;
  const tailKey = normalizeTitle(tail);
  // The head is the series itself ("Mistborn: Mistborn, Book 2"): the subtitle carries the book, not the decoration.
  if (containsWords(tailKey, headKey)) return null;
  const marked = MARKED_VOLUME.exec(tail);
  if (marked) {
    const volume = toNumber(marked[1]);
    // The series is named before the marker ("The Expanse, Book 2") or after an "of" ("Book Two of the Expanse
    // series"). Words that just follow the number are the BOOK's title ("Shadow and Bone: Book 3, Ruin and Rising"),
    // and "Book 3" alone names nothing: either way the head may BE the series, so the core is bare.
    const before = tail.slice(0, marked.index);
    const after = tail.slice(marked.index + marked[0].length);
    const namesSeries = namesWords(before) || (/^[\s,]*of\b/i.test(after) && namesWords(after));
    return volume === undefined ? null : namesSeries ? { volume } : { volume, bare: true };
  }
  const plain = tail.replace(/\s*[([{][^)\]}]*[)\]}]\s*$/, '');
  const trailing = NOT_A_POSITION.test(plain) ? null : TRAILING_POSITION.exec(plain);
  if (trailing) {
    const volume = toNumber(trailing[1]);
    return volume === undefined ? null : { volume };
  }
  if (FORM_WORD.test(tail)) return {};
  return null;
}

/**
 * The decoration-stripped forms of a title (issue thaynes43/haynesnetwork#759), each with the volume number its
 * decoration named. Never includes the title's own full key. Conservative by construction:
 *
 *   - a series-position PREFIX ("Expanse 03 - Abaddon's Gate", "The Expanse, Book 3 - Abaddon's Gate") leaves
 *     the book's own title, so it is safe to drop; its number is the volume;
 *   - a SUBTITLE is dropped only when it is decoration: it names a volume ("The Expanse, Book 2", "Book Two of
 *     the Expanse series", "Legacy of Orisha 3") or the form ("A Mistborn Novel", "Unabridged"), or it is the
 *     work's own series name ("Artificial Condition--The Murderbot Diaries"), and it names no other work (a
 *     graphic novel, a companion, an epilogue, a bundle). A subtitle that carries the book ("Mistborn: The Final
 *     Empire", "The Duke and I: The 2nd Epilogue") is never dropped;
 *   - a HEAD that is the work's series name ("Bridgerton: An Offer from a Gentleman") is dropped.
 */
export function coreTitles(
  raw: string,
  series?: string,
  compilation: (t: string) => boolean = () => false,
): CoreTitle[] {
  const full = normalizeTitle(raw);
  const seriesKey = series === undefined ? '' : normalizeTitle(series);
  const out: CoreTitle[] = [];
  const push = (text: string, volume: number | undefined, bare?: true): void => {
    const key = normalizeTitle(text);
    if (key.length === 0 || key === full || !/[a-z]/.test(key)) return;
    if (out.some((core) => core.key === key && core.volume === volume && core.bare === bare))
      return;
    out.push({ key, ...(volume === undefined ? {} : { volume }), ...(bare ? { bare } : {}) });
  };
  const subtitle = (text: string, prefixVolume: number | undefined): void => {
    const split = SUBTITLE_SEPARATOR.exec(text);
    if (!split || split.index === 0) return;
    const head = text.slice(0, split.index);
    const tail = text.slice(split.index + split[0].length);
    const headKey = normalizeTitle(head);
    const tailKey = normalizeTitle(tail);
    if (headKey.length === 0 || tailKey.length === 0) return;
    if (seriesKey.length > 0 && tailKey === seriesKey) push(head, prefixVolume);
    if (seriesKey.length > 0 && headKey === seriesKey && !compilation(tail))
      push(tail, prefixVolume);
    const found = decoration(tail, headKey, compilation);
    if (found === null) return;
    const volume = found.volume;
    if (volume !== undefined && prefixVolume !== undefined && volume !== prefixVolume) return;
    // A prefix already named the volume of THIS title, so a bare "Book 3" after it is no longer bare.
    push(head, volume ?? prefixVolume, prefixVolume === undefined ? found.bare : undefined);
  };

  const prefix = POSITION_PREFIX.exec(raw.trim());
  if (prefix && prefix[3] !== undefined) {
    const rest = prefix[3];
    const volume = toNumber(prefix[2]);
    if (!FORM_WORD.test(rest) || /[a-z]{3,}/i.test(rest.replace(FORM_WORD, ''))) {
      push(rest, volume);
      subtitle(rest, volume);
    }
  }
  subtitle(raw.trim(), undefined);
  return out;
}

/** The volume numbers a title carries outside its key (bracketed noise): "Dune (Part 2)" -> "2". */
function numberMarks(raw: string): string {
  const numbers = [...raw.matchAll(/\b\d{1,3}\b/g)].map((m) => String(Number(m[0])));
  const words = [
    ...raw
      .toLowerCase()
      .matchAll(new RegExp(`\\b(?:book|volume|vol|part)\\.?\\s+${NUMBER}\\b`, 'g')),
  ].map((m) => String(toNumber(m[1])));
  return [...new Set([...numbers, ...words])].sort().join(',');
}

/**
 * Are these entries, spread over several library items, the SAME book held more than once (an epub and a pdf
 * filed as two series, an import and a re-download as two audiobooks)? Only when it can be verified for every
 * pair of items — both name their authors (or writers) and they agree, or their files share a folder — and no
 * copy carries a volume number the others do not ("Dune (Part 1)" and "Dune (Part 2)" are two halves, not two
 * copies). Anything less stays ambiguous and is refused.
 */
function sameBook(
  entries: readonly TitleEntry[],
  volumesAgree: (entries: readonly TitleEntry[]) => boolean = (all) =>
    new Set(all.map((entry) => numberMarks(entry.raw))).size === 1,
): boolean {
  const items = [...new Map(entries.map((entry) => [entry.item.id, entry.item])).values()];
  const credits = items.map((item) =>
    item.authors && item.authors.length > 0 ? item.authors : (item.writers ?? []),
  );
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const credited =
        credits[i]!.length > 0 && credits[j]!.length > 0 && authorsAgree(credits[i], credits[j]);
      const together = (items[i]!.folders ?? []).some((folder) =>
        items[j]!.folders?.includes(folder),
      );
      if (!credited && !together) return false;
    }
  }
  return volumesAgree(entries);
}

const credited = (item: TitleCandidate): boolean =>
  (item.authors?.length ?? 0) > 0 || (item.writers?.length ?? 0) > 0;

/** Among copies of one book, the better-described copy first (it names its people), then the lowest id. */
const byPreference = (a: TitleEntry, b: TitleEntry): number =>
  Number(credited(b.item)) - Number(credited(a.item)) ||
  a.item.id.localeCompare(b.item.id, undefined, { numeric: true });

/**
 * Build the title index once per reconcile. Keys are normalized titles; a key
 * that resolves to two or more DISTINCT items is ambiguous and never satisfies a
 * match (library-side franchise collision -> refuse, never guess), unless the
 * items are verifiably the same book held twice (`sameBook`).
 *
 * Two tiers. An item's own title (a Kavita series name, an ABS title) is looked up
 * first, exactly as before. The titles of the books an item holds (`books`) are
 * looked up only for a title no item carries as its own, so a book filed as a
 * volume of a series ("Written in My Own Heart's Blood" in "Outlander") is found
 * without ever moving a work off the item it already matched. Each book of an item
 * that holds several is its own claim, so one series can satisfy one work per
 * volume it holds; the series name of such an item claims none of its books.
 */
export class TitleIndex {
  private readonly byKey = new Map<string, TitleEntry[]>();
  private readonly byBookKey = new Map<string, TitleEntry[]>();
  private readonly entries: TitleEntry[] = [];
  private cores:
    Map<string, Array<{ entry: TitleEntry; volume?: number; bare?: true }>> | undefined;
  private splits:
    | Array<{ entry: TitleEntry; headKey: string; tailKey: string; head: string; tail: string }>
    | undefined;

  constructor(
    items: readonly TitleCandidate[],
    private readonly compilation: (title: string) => boolean = () => false,
  ) {
    for (const item of items) {
      for (const entry of titleEntries(item)) {
        const key = normalizeTitle(entry.raw);
        if (key.length === 0) continue;
        const index = entry.book ? this.byBookKey : this.byKey;
        const bucket = index.get(key);
        if (bucket) {
          if (!bucket.some((other) => other.claim === entry.claim)) bucket.push(entry);
        } else {
          index.set(key, [entry]);
        }
        this.entries.push(entry);
      }
    }
  }

  /** Does any library item carry exactly this (normalized) title, as its own or a book's? */
  has(title: string | undefined): boolean {
    if (title === undefined) return false;
    const key = normalizeTitle(title);
    return key.length > 0 && (this.byKey.has(key) || this.byBookKey.has(key));
  }

  /**
   * Resolve a work's title (and optional authors) to exactly one library item,
   * or undefined when there is no match, the key is empty, the library key is
   * ambiguous, or the author guard leaves no survivor. `claimed` excludes items
   * already taken by an identifier or earlier title match, so a run never binds
   * two works to the same item (for an item without books, its claim is its id).
   */
  match(
    title: string | undefined,
    authors: string[] | undefined,
    claimed: ReadonlySet<string>,
  ): TitleCandidate | undefined {
    return this.find(title, authors, claimed)?.item;
  }

  /** `match`, returning the claim the hit takes as well. */
  find(
    title: string | undefined,
    authors: string[] | undefined,
    claimed: ReadonlySet<string>,
  ): TitleHit | undefined {
    if (title === undefined) return undefined;
    const key = normalizeTitle(title);
    if (key.length === 0) return undefined;
    // An item's own title first; a book inside an item only when no item carries the title as its own.
    const bucket = this.byKey.get(key) ?? this.byBookKey.get(key);
    if (!bucket) return undefined;
    return pick(bucket, authors, claimed);
  }

  /**
   * The decorated-title pass (issue thaynes43/haynesnetwork#759), for a work the exact pass found NO library
   * title for: the work's title and the library's titles are compared with their decoration taken off
   * (`coreTitles`) — "Caliban's War: The Expanse, Book 2" holds "Caliban's War", "Expanse 03 - Abaddon's Gate"
   * holds "Abaddon's Gate". Every guard of the exact pass still applies (ambiguity, author, claims), plus:
   *
   *   - the volume a decoration names must agree with the other side's and with the work's series position, and a
   *     decoration that names only a volume ("Shadow and Bone: Book 3", whose head may be the series name) pairs
   *     only with a side known to be that same volume;
   *   - the key the work matches under must be the work's alone in this list (`sharedKey`), so two members that
   *     share a stripped title ("X: Book 1", "X: Book 2") never take one item. A source that lists one book twice
   *     ("Caliban's War" at position 2 and "Caliban's War: The Expanse, Book 2") is not a clash: same volume.
   */
  findDecorated(
    work: DecoratedWork,
    claimed: ReadonlySet<string>,
    sharedKey: (key: string) => boolean,
  ): TitleHit | undefined {
    if (work.title === undefined) return undefined;
    const full = normalizeTitle(work.title);
    if (full.length === 0) return undefined;
    const workKeys: CoreTitle[] = [
      { key: full },
      ...coreTitles(work.title, work.series, this.compilation),
    ];
    const seriesKey = work.series === undefined ? '' : normalizeTitle(work.series);
    // Each library title found, with the volume its stripped decoration named (none for a whole title).
    const found: Array<{ entry: TitleEntry; volume?: number }> = [];
    const agrees = (...volumes: Array<number | undefined>): boolean => {
      const known = volumes.filter((v): v is number => v !== undefined);
      return known.every((v) => v === known[0]);
    };
    for (const workKey of workKeys) {
      if (sharedKey(workKey.key)) continue; // another member of the list shares this key: refuse
      const stripped = workKey.key !== full;
      const workSide = stripped ? workKey.volume : undefined;
      const workBare = stripped && workKey.bare === true;
      // The volume this work is known to be: its own decoration's, else its series position.
      const workVolume = workSide ?? work.position;
      // The work's decoration stripped, the library's title whole. A bare work key ("Shadow and Bone: Book 3")
      // may have left the series name, which a whole library title of that name is not.
      if (stripped && !workBare) {
        for (const entry of [
          ...(this.byKey.get(workKey.key) ?? []),
          ...(this.byBookKey.get(workKey.key) ?? []),
        ]) {
          if (agrees(workSide, work.position)) found.push({ entry });
        }
      }
      // The library's decoration stripped (the work's title whole or stripped). A bare decoration on either
      // side pairs only with the same volume named on the other.
      for (const core of this.coreIndex().get(workKey.key) ?? []) {
        if (!agrees(workSide, core.volume, work.position)) continue;
        if (core.bare && (core.volume === undefined || workVolume !== core.volume)) continue;
        if (workBare && core.volume !== workSide) continue;
        found.push(core);
      }
      if (seriesKey.length > 0 && !workBare) {
        for (const split of this.splitIndex()) {
          const side =
            split.tailKey === seriesKey && split.headKey === workKey.key
              ? split.head
              : split.headKey === seriesKey &&
                  split.tailKey === workKey.key &&
                  !this.compilation(split.tail)
                ? split.tail
                : undefined;
          if (side !== undefined && agrees(workSide, work.position))
            found.push({ entry: split.entry });
        }
      }
    }
    if (found.length === 0) return undefined;
    const unique = [...new Map(found.map((one) => [one.entry.claim, one.entry])).values()];
    // Copies across items agree on the volume when no two decorations name different ones (a whole title
    // names none); bracketed noise was already set aside with the decoration.
    const volumes = found.map((one) => one.volume);
    return pick(unique, work.authors, claimed, () => agrees(...volumes));
  }

  private coreIndex(): Map<string, Array<{ entry: TitleEntry; volume?: number; bare?: true }>> {
    if (this.cores) return this.cores;
    const cores = new Map<string, Array<{ entry: TitleEntry; volume?: number; bare?: true }>>();
    for (const entry of this.entries) {
      for (const core of coreTitles(entry.raw, undefined, this.compilation)) {
        const list = cores.get(core.key) ?? [];
        list.push({
          entry,
          ...(core.volume === undefined ? {} : { volume: core.volume }),
          ...(core.bare ? { bare: core.bare } : {}),
        });
        cores.set(core.key, list);
      }
    }
    this.cores = cores;
    return cores;
  }

  private splitIndex(): NonNullable<TitleIndex['splits']> {
    if (this.splits) return this.splits;
    const splits: NonNullable<TitleIndex['splits']> = [];
    for (const entry of this.entries) {
      const split = SUBTITLE_SEPARATOR.exec(entry.raw);
      if (!split || split.index === 0) continue;
      const head = entry.raw.slice(0, split.index);
      const tail = entry.raw.slice(split.index + split[0].length);
      const headKey = normalizeTitle(head);
      const tailKey = normalizeTitle(tail);
      if (headKey.length > 0 && tailKey.length > 0)
        splits.push({ entry, headKey, tailKey, head, tail });
    }
    this.splits = splits;
    return splits;
  }
}

/**
 * The entries one item is indexed under. An item with one book (or none listed) is one claim, its id; an item
 * that holds several books claims each book separately, and its own title claims the book of that name, or
 * none of them (a series name like "The Discworld" names no book).
 */
function titleEntries(item: TitleCandidate): TitleEntry[] {
  const books = item.books ?? [];
  if (books.length <= 1) {
    return [
      { item, raw: item.title, claim: item.id, book: false },
      ...(books[0] ?? []).map((raw) => ({ item, raw, claim: item.id, book: true })),
    ];
  }
  const own = normalizeTitle(item.title);
  const ownBook = books.findIndex((titles) => titles.some((raw) => normalizeTitle(raw) === own));
  const entries: TitleEntry[] = [
    {
      item,
      raw: item.title,
      claim: `${item.id}#${ownBook === -1 ? 'series' : ownBook}`,
      book: false,
    },
  ];
  books.forEach((titles, index) => {
    for (const raw of titles) entries.push({ item, raw, claim: `${item.id}#${index}`, book: true });
  });
  return entries;
}

/** Choose among the entries one key resolved to: refuse ambiguity, apply the author guard, honor claims. */
function pick(
  entries: readonly TitleEntry[],
  authors: string[] | undefined,
  claimed: ReadonlySet<string>,
  volumesAgree?: (entries: readonly TitleEntry[]) => boolean,
): TitleHit | undefined {
  const distinct = new Set(entries.map((entry) => entry.item.id));
  // Library-side ambiguity (two distinct items) is refused up front, even if some are already claimed — we will
  // not guess which one was meant — unless the items are the same book held twice.
  if (distinct.size > 1 && !sameBook(entries, volumesAgree)) return undefined;
  const candidates = entries
    .filter((entry) => !claimed.has(entry.claim) && authorsAgree(authors, entry.item.authors))
    .sort(byPreference);
  const hit = candidates[0];
  return hit ? { item: hit.item, claim: hit.claim } : undefined;
}
