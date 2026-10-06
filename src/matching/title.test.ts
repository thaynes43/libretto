import { describe, expect, it } from 'vitest';
import { authorsAgree, coreTitles, normalizeTitle, TitleIndex } from './title.js';

describe('normalizeTitle', () => {
  it('folds case, punctuation and whitespace to a stable key', () => {
    expect(normalizeTitle("Harry Potter and the Philosopher's Stone")).toBe(
      'harry potter and the philosophers stone',
    );
    expect(normalizeTitle('  Harry   Potter\tand the  Philosopher’s  Stone ')).toBe(
      'harry potter and the philosophers stone',
    );
  });

  it('drops a single leading article but keeps interior ones', () => {
    expect(normalizeTitle('The Martian')).toBe('martian');
    expect(normalizeTitle('A Wizard of Earthsea')).toBe('wizard of earthsea');
    // interior "the" is part of the distinguishing title, never stripped
    expect(normalizeTitle('Harry Potter and the Chamber of Secrets')).toBe(
      'harry potter and the chamber of secrets',
    );
  });

  it('strips bracketed edition/series noise but not the title itself', () => {
    expect(normalizeTitle('Leviathan Wakes (The Expanse, #1)')).toBe('leviathan wakes');
    expect(normalizeTitle('Dune [Illustrated Edition]')).toBe('dune');
  });

  it('folds diacritics and expands ampersands', () => {
    expect(normalizeTitle('Les Misérables')).toBe('les miserables');
    expect(normalizeTitle('War & Peace')).toBe('war and peace');
  });

  it('is empty when nothing comparable survives', () => {
    expect(normalizeTitle('   ')).toBe('');
    expect(normalizeTitle('(2011)')).toBe('');
  });

  it('keeps the honest US/UK divergence a real miss, not a fuzzy hit', () => {
    expect(normalizeTitle("Harry Potter and the Sorcerer's Stone")).not.toBe(
      normalizeTitle("Harry Potter and the Philosopher's Stone"),
    );
  });
});

describe('authorsAgree', () => {
  it('is permissive when either side lacks authors (title carries the match)', () => {
    expect(authorsAgree(undefined, ['J.K. Rowling'])).toBe(true);
    expect(authorsAgree(['J.K. Rowling'], [])).toBe(true);
    expect(authorsAgree(undefined, undefined)).toBe(true);
  });

  it('agrees across initials/spacing when both supply authors', () => {
    expect(authorsAgree(['J.K. Rowling'], ['J. K. Rowling'])).toBe(true);
    expect(authorsAgree(['JK Rowling'], ['Rowling'])).toBe(true);
  });

  it('vetoes disjoint authors (franchise mispair guard)', () => {
    expect(authorsAgree(['Frank Herbert'], ['Brian Herbert', 'Kevin J. Anderson'])).toBe(true); // shares "herbert"
    expect(authorsAgree(['Frank Herbert'], ['Kevin Anderson'])).toBe(false);
  });
});

describe('TitleIndex.match', () => {
  const none = new Set<string>();

  it('matches a work title to the one library item that carries it', () => {
    const index = new TitleIndex([
      { id: 'a', title: 'Leviathan Wakes' },
      { id: 'b', title: "Caliban's War" },
    ]);
    expect(index.match('Leviathan Wakes (The Expanse, #1)', undefined, none)?.id).toBe('a');
  });

  it('refuses a library-side ambiguous key (two distinct items same title) — never guesses', () => {
    const index = new TitleIndex([
      { id: 'a', title: 'The Gathering' },
      { id: 'b', title: 'The Gathering' },
    ]);
    expect(index.match('The Gathering', undefined, none)).toBeUndefined();
  });

  it('never binds an already-claimed item', () => {
    const index = new TitleIndex([{ id: 'a', title: 'Leviathan Wakes' }]);
    expect(index.match('Leviathan Wakes', undefined, new Set(['a']))).toBeUndefined();
  });

  it('applies the author guard when both sides supply authors', () => {
    const index = new TitleIndex([{ id: 'a', title: 'Dune', authors: ['Frank Herbert'] }]);
    expect(index.match('Dune', ['Frank Herbert'], none)?.id).toBe('a');
    expect(index.match('Dune', ['Kevin Anderson'], none)).toBeUndefined();
  });

  it('does not match an empty or unknown title key', () => {
    const index = new TitleIndex([{ id: 'a', title: 'Dune' }]);
    expect(index.match('(2011)', undefined, none)).toBeUndefined();
    expect(index.match('Nonexistent', undefined, none)).toBeUndefined();
    expect(index.match(undefined, undefined, none)).toBeUndefined();
  });

  it('items with unresolvable titles never enter the index', () => {
    const index = new TitleIndex([{ id: 'a', title: '   ' }]);
    expect(index.match('   ', undefined, none)).toBeUndefined();
  });
});

// thaynes43/haynesnetwork#759 — held books that read missing: a book filed inside a Kavita series, the same book
// held twice, and a title carrying its series decoration. Every case below is a live library shape.
describe('coreTitles — decoration taken off, never the book', () => {
  const keys = (raw: string, series?: string) => coreTitles(raw, series).map((core) => core);

  it('drops a series-position prefix and keeps its number as the volume', () => {
    expect(keys('Expanse 03 - Abaddon’s Gate')).toEqual([{ key: 'abaddons gate', volume: 3 }]);
    expect(keys("The Expanse, Book 3 - Abaddon's Gate")).toEqual([
      { key: 'abaddons gate', volume: 3 },
    ]);
    expect(keys('Aurora Teagarden #08 - Poppy done to death')).toEqual([
      { key: 'poppy done to death', volume: 8 },
    ]);
  });

  it('drops a subtitle that names a volume or the form', () => {
    expect(keys("Caliban's War: The Expanse, Book 2")).toEqual([
      { key: 'calibans war', volume: 2 },
    ]);
    expect(keys("Caliban's War: Book Two of the Expanse series")).toEqual([
      { key: 'calibans war', volume: 2 },
    ]);
    expect(keys('Children of Anguish and Anarchy: Legacy of Orisha 3')).toEqual([
      { key: 'children of anguish and anarchy', volume: 3 },
    ]);
    expect(keys('The Lost Metal--A Mistborn Novel')).toEqual([{ key: 'lost metal' }]);
    expect(keys('Lost Metal : A Mistborn Novel (9780765391209)')).toEqual([{ key: 'lost metal' }]);
  });

  it('drops the work’s own series name, before or after the title', () => {
    expect(keys('Artificial Condition--The Murderbot Diaries', 'The Murderbot Diaries')).toEqual([
      { key: 'artificial condition' },
    ]);
    expect(keys('Bridgerton: An Offer from a Gentleman', 'Bridgerton')).toEqual([
      { key: 'offer from a gentleman' },
    ]);
    // Without the series name the same titles keep their subtitle.
    expect(keys('Artificial Condition--The Murderbot Diaries')).toEqual([]);
  });

  it('never drops a subtitle that carries the book, another work or a bundle', () => {
    expect(keys('Mistborn: The Final Empire')).toEqual([]);
    expect(keys('The Duke and I: The 2nd Epilogue')).toEqual([]);
    expect(keys('Twilight: The Graphic Novel, Vol. 1')).toEqual([]);
    expect(keys('Wool: Omnibus Edition')).toEqual([]);
    expect(keys('The Expanse: Books 1-3')).toEqual([]);
    expect(keys('Curtain: Poirot’s Last Case')).toEqual([]);
    // The head IS the series: the subtitle names the book, so the head is no title for it.
    expect(keys('Mistborn: Mistborn, Book 2')).toEqual([]);
  });

  it('marks a subtitle that names only a volume as bare (its head may be the series name)', () => {
    expect(keys('Shadow and Bone: Book 3')).toEqual([
      { key: 'shadow and bone', volume: 3, bare: true },
    ]);
    // Words after the number are the book's own title, not a series name.
    expect(keys('Shadow and Bone: Book 3, Ruin and Rising')).toEqual([
      { key: 'shadow and bone', volume: 3, bare: true },
    ]);
    // ...while the position-prefix form yields the book itself.
    expect(keys('Shadow and Bone: Book 3 - Ruin and Rising')).toEqual([
      { key: 'ruin and rising', volume: 3 },
      { key: 'shadow and bone', volume: 3, bare: true },
    ]);
  });

  it('never reads a part, a year or a one-word name before a number as a position', () => {
    expect(keys('Batman: Year 1')).toEqual([]);
    expect(keys('Lost Moon: Apollo 13')).toEqual([]);
    expect(keys('Words of Radiance: Part 2')).toEqual([]);
  });

  it('never reads a number that belongs to the title as a position', () => {
    expect(keys('Catch-22: A Novel')).toEqual([{ key: 'catch 22' }]);
    expect(keys('Fahrenheit 451 - The Graphic Novel')).toEqual([]);
    expect(keys('2001: A Space Odyssey')).toEqual([]);
  });
});

describe('TitleIndex — books inside an item (Kavita series)', () => {
  const none = new Set<string>();
  const outlander = {
    id: 'o',
    title: 'Outlander',
    books: [
      ['Outlander'],
      ["Written in My Own Heart's Blood", "Outlander: Written in My Own Heart's Blood"],
    ],
  };

  it('finds a book filed as a volume of a series, and each book is its own claim', () => {
    const index = new TitleIndex([outlander]);
    const first = index.find('Outlander', undefined, none);
    const eighth = index.find(
      "Written in My Own Heart's Blood",
      undefined,
      new Set([first!.claim]),
    );
    expect(first?.item.id).toBe('o');
    expect(eighth?.item.id).toBe('o');
    expect(eighth?.claim).not.toBe(first?.claim);
    // The same book twice in one run is still one claim.
    expect(
      index.find("Written in My Own Heart's Blood", undefined, new Set([eighth!.claim])),
    ).toBeUndefined();
  });

  it('a series name with no book of that name claims none of its books', () => {
    const index = new TitleIndex([
      { id: 'd', title: 'The Discworld', books: [['Guards! Guards!'], ['Eric']] },
    ]);
    const guards = index.find('Guards! Guards!', undefined, none);
    expect(guards?.item.id).toBe('d');
    expect(index.find('Eric', undefined, new Set([guards!.claim]))?.item.id).toBe('d');
  });

  it('an item’s own title wins over a book inside another item (no work moves off its match)', () => {
    const index = new TitleIndex([
      { id: 'disc', title: 'The Discworld', books: [['Guards! Guards!'], ['Men At Arms']] },
      { id: 'men', title: 'Men at Arms' },
    ]);
    expect(index.match('Men at Arms', undefined, none)?.id).toBe('men');
  });
});

describe('TitleIndex — the same book held twice', () => {
  const none = new Set<string>();

  it('takes one copy when every pair names agreeing authors or writers', () => {
    const index = new TitleIndex([
      { id: '2', title: 'Caliban’s War', authors: ['James S. A. Corey'] },
      { id: '1', title: "Caliban's War", authors: ['James S.A. Corey'] },
    ]);
    expect(index.match("Caliban's War", undefined, none)?.id).toBe('1');
    // The second copy serves a second claim (a source that lists the book twice).
    expect(index.match("Caliban's War", undefined, new Set(['1']))?.id).toBe('2');
  });

  it('takes one copy when their files share a folder (an epub and a pdf filed as two series)', () => {
    const index = new TitleIndex([
      { id: '1714', title: 'The Way of Kings', folders: ['/b/Brandon Sanderson/The Way of Kings'] },
      {
        id: '1771',
        title: 'The Way of Kings',
        writers: ['Brandon Sanderson'],
        folders: ['/b/Brandon Sanderson/The Way of Kings'],
      },
    ]);
    // The copy that names its people is preferred.
    expect(index.match('The Way of Kings', undefined, none)?.id).toBe('1771');
  });

  it('still refuses what it cannot verify, and halves that are not copies', () => {
    expect(
      new TitleIndex([
        { id: 'a', title: 'Night Shift', writers: ['Stephen King'] },
        { id: 'b', title: 'Night Shift', writers: ['Charlaine Harris'] },
      ]).match('Night Shift', undefined, none),
    ).toBeUndefined();
    expect(
      new TitleIndex([
        { id: 'a', title: 'The Way of Kings' },
        { id: 'b', title: 'The Way of Kings', writers: ['Brandon Sanderson'] },
      ]).match('The Way of Kings', undefined, none),
    ).toBeUndefined();
    expect(
      new TitleIndex([
        { id: 'a', title: 'Dune (Part 1)', authors: ['Frank Herbert'] },
        { id: 'b', title: 'Dune (Part 2)', authors: ['Frank Herbert'] },
      ]).match('Dune', undefined, none),
    ).toBeUndefined();
  });

  it('writers never veto a match (partial credits are common)', () => {
    const index = new TitleIndex([{ id: 'g', title: 'Good Omens', writers: ['Neil Gaiman'] }]);
    expect(index.match('Good Omens', ['Terry Pratchett'], none)?.id).toBe('g');
  });
});

describe('TitleIndex.findDecorated', () => {
  const none = new Set<string>();
  const alone = () => false;

  it('pairs a decorated library title with the work, and a decorated work with the library title', () => {
    const index = new TitleIndex([
      { id: 'a', title: 'Expanse 03 - Abaddon’s Gate' },
      { id: 'c', title: "Caliban's War" },
    ]);
    expect(
      index.findDecorated({ title: "Abaddon's Gate", authors: undefined, position: 3 }, none, alone)
        ?.item.id,
    ).toBe('a');
    expect(
      index.findDecorated(
        { title: "Caliban's War: The Expanse, Book 2", authors: undefined },
        none,
        alone,
      )?.item.id,
    ).toBe('c');
  });

  it('refuses when the decoration names another volume than the work’s position', () => {
    const index = new TitleIndex([{ id: 'x', title: 'Redwall 04 - Mariel of Redwall' }]);
    expect(
      index.findDecorated(
        { title: 'Mariel of Redwall', authors: undefined, position: 5 },
        none,
        alone,
      ),
    ).toBeUndefined();
    expect(
      index.findDecorated(
        { title: 'Mariel of Redwall', authors: undefined, position: 4 },
        none,
        alone,
      )?.item.id,
    ).toBe('x');
  });

  it('a bare volume decoration pairs only with a work known to be that volume', () => {
    const index = new TitleIndex([{ id: 'x', title: 'Shadow and Bone: Book 3' }]);
    const work = (position?: number) => ({
      title: 'Shadow and Bone',
      authors: undefined,
      position,
    });
    expect(index.findDecorated(work(), none, alone)).toBeUndefined();
    expect(index.findDecorated(work(1), none, alone)).toBeUndefined();
    expect(index.findDecorated(work(3), none, alone)?.item.id).toBe('x');
    // The other way round: a work that names only its volume never takes the plain series-name title.
    const plain = new TitleIndex([{ id: 'p', title: 'Shadow and Bone' }]);
    expect(
      plain.findDecorated(
        { title: 'Shadow and Bone: Book 3', authors: undefined, position: 3 },
        none,
        alone,
      ),
    ).toBeUndefined();
  });

  it('refuses a key another member of the list shares', () => {
    const index = new TitleIndex([{ id: 'x', title: 'Shadows: A Saga Novel' }]);
    expect(
      index.findDecorated({ title: 'Shadows', authors: undefined }, none, () => true),
    ).toBeUndefined();
  });

  it('uses the series name only for a work of that series', () => {
    const index = new TitleIndex([
      { id: 'm', title: 'Artificial Condition--The Murderbot Diaries' },
    ]);
    expect(
      index.findDecorated({ title: 'Artificial Condition', authors: undefined }, none, alone),
    ).toBeUndefined();
    expect(
      index.findDecorated(
        { title: 'Artificial Condition', authors: undefined, series: 'The Murderbot Diaries' },
        none,
        alone,
      )?.item.id,
    ).toBe('m');
  });

  it('applies the author guard', () => {
    const index = new TitleIndex([
      { id: 'x', title: 'Gray Dawn: A Novel', authors: ['Stewart Edward White'] },
    ]);
    expect(
      index.findDecorated({ title: 'Gray Dawn', authors: ['Walter Mosley'] }, none, alone),
    ).toBeUndefined();
  });
});
