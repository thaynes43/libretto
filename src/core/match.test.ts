import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../builders/index.js';
import type { TargetItem } from '../target/types.js';
import { recipeSchema } from '../recipes/schema.js';
import { matchWorks, recipeMatchOptions, toMissingMember } from './match.js';

const work = (p: Partial<WorkItem> & { label: string }): WorkItem => ({ identifiers: [], ...p });

describe('matchWorks', () => {
  const items: TargetItem[] = [
    { id: 'i1', title: 'Leviathan Wakes', identifiers: ['isbn:9780316129084'] },
    { id: 'i2', title: 'Project Hail Mary', identifiers: [], authors: ['Andy Weir'] },
  ];

  it('matches by identifier, then title fallback, and collects missing works', () => {
    const works = [
      work({
        identifiers: ['isbn:9780316129084'],
        label: 'Leviathan Wakes',
        title: 'Leviathan Wakes',
      }),
      work({
        identifiers: ['isbn:0000000000000'],
        label: 'Project Hail Mary',
        title: 'Project Hail Mary',
        authors: ['Andy Weir'],
      }),
      work({ identifiers: ['isbn:9781111111111'], label: 'Nemesis Games', title: 'Nemesis Games' }),
    ];
    const r = matchWorks(works, items, { titleFallback: true });
    expect(r.matchedIds).toEqual(['i1', 'i2']);
    expect(r.matchedByTitle).toBe(1); // Project Hail Mary via title
    expect(r.missingWorks.map((w) => w.label)).toEqual(['Nemesis Games']);
  });

  it('flags an author-guarded title match as title_author (ADR-076 C-07)', () => {
    // A { title, author } static entry carries no identifier and its own author -> title_author.
    const works = [
      work({
        label: 'Project Hail Mary by Andy Weir',
        title: 'Project Hail Mary',
        authors: ['Andy Weir'],
      }),
      // A title-only work (no author) stays plain 'title'.
      work({ label: 'Leviathan Wakes', title: 'Leviathan Wakes' }),
    ];
    const noIsbnItems: TargetItem[] = [
      { id: 'i2', title: 'Project Hail Mary', identifiers: [], authors: ['Andy Weir'] },
      { id: 'i1', title: 'Leviathan Wakes', identifiers: [] },
    ];
    const r = matchWorks(works, noIsbnItems, { titleFallback: true });
    expect(r.matchedVia).toEqual(['title_author', 'title']);
    expect(r.matchedByTitle).toBe(2);
  });

  it('identifier-only when titleFallback is disabled', () => {
    const works = [
      work({
        identifiers: ['isbn:0000000000000'],
        label: 'Project Hail Mary',
        title: 'Project Hail Mary',
        authors: ['Andy Weir'],
      }),
    ];
    const r = matchWorks(works, items, { titleFallback: false });
    expect(r.matchedIds).toEqual([]);
    expect(r.missingWorks).toHaveLength(1);
  });

  it('carries every canonical work bound to a retained series and the confirmed full alias', () => {
    const first = work({ label: 'First', identifiers: ['isbn:first'] });
    const second = work({ label: 'Second', title: 'Canonical second' });
    const result = matchWorks(
      [first, second],
      [
        {
          id: 'old-series',
          title: 'Old series',
          identifiers: ['isbn:first'],
          books: [['First'], ['Library second']],
        },
      ],
      { titleFallback: true, titleAliases: { 'Canonical second': ['Library second'] } },
    );
    expect(result.matchedIds).toEqual(['old-series']);
    expect(result.matchedWorks).toEqual([
      { itemId: 'old-series', work: first },
      { itemId: 'old-series', work: second, confirmedTitle: 'Library second' },
    ]);
  });

  it('does not promote a series-name alias into a confirmed book title', () => {
    const canonical = work({ label: 'Canonical book', title: 'Canonical book' });
    const result = matchWorks(
      [canonical],
      [
        {
          id: 'umbrella',
          title: 'Umbrella',
          identifiers: [],
          books: [['Actual other book', 'Umbrella: Actual other book']],
        },
      ],
      { titleFallback: true, titleAliases: { 'Canonical book': ['Umbrella'] } },
    );
    expect(result.matchedIds).toEqual(['umbrella']);
    expect(result.matchedWorks).toEqual([{ itemId: 'umbrella', work: canonical }]);
  });
});

describe('matchWorks — series grain (comics)', () => {
  // A Kavita-like comics library: each comic is ONE series (volumes are chapters), no ISBNs.
  const comicsLibrary: TargetItem[] = [
    { id: 's-invincible', title: 'Invincible', identifiers: [] },
    { id: 's-guarding', title: 'Guarding the Globe', identifiers: [] },
    { id: 's-scott', title: 'Scott Pilgrim', identifiers: [] },
  ];
  // Series-grain works: title = the Hardcover series name, no identifiers (comics expose none).
  const seriesWork = (name: string): WorkItem => ({ identifiers: [], label: name, title: name });

  it('matches a Hardcover series to a target series by conservative name equality', () => {
    const r = matchWorks([seriesWork('Invincible')], comicsLibrary, {
      titleFallback: false, // irrelevant at series grain — name equality is always the path
      grain: 'series',
    });
    expect(r.matchedIds).toEqual(['s-invincible']);
    expect(r.matchedVia).toEqual(['series']);
    expect(r.matchedByTitle).toBe(1); // flagged as a name (not identifier) match
    expect(r.missingWorks).toHaveLength(0);
  });

  it('builds a MULTI-series collection (an "Invincible Universe")', () => {
    const r = matchWorks(
      [seriesWork('Invincible'), seriesWork('Guarding the Globe')],
      comicsLibrary,
      {
        titleFallback: true,
        grain: 'series',
      },
    );
    expect(r.matchedIds).toEqual(['s-invincible', 's-guarding']);
    expect(r.matchedVia).toEqual(['series', 'series']);
    expect(r.missingWorks).toHaveLength(0);
  });

  it('strips parenthetical noise from a series name but still refuses a divergent name', () => {
    const r = matchWorks(
      [seriesWork('Invincible (2003)'), seriesWork('Invincible Compendium')],
      comicsLibrary,
      { titleFallback: true, grain: 'series' },
    );
    // "Invincible (2003)" normalizes to "invincible" and matches; the Compendium is an honest miss.
    expect(r.matchedIds).toEqual(['s-invincible']);
    expect(r.missingWorks.map((w) => w.label)).toEqual(['Invincible Compendium']);
  });

  it('refuses a library-side ambiguous series name rather than guess', () => {
    const ambiguous: TargetItem[] = [
      { id: 'a-1', title: 'Invincible', identifiers: [] },
      { id: 'a-2', title: 'Invincible', identifiers: [] },
    ];
    const r = matchWorks([seriesWork('Invincible')], ambiguous, {
      titleFallback: true,
      grain: 'series',
    });
    expect(r.matchedIds).toEqual([]);
    expect(r.missingWorks.map((w) => w.label)).toEqual(['Invincible']);
  });

  it('does not read identifiers at series grain (name is the only key)', () => {
    // A work whose identifiers happen to collide with a target item still only matches by NAME.
    const work: WorkItem = {
      identifiers: ['isbn:9780316129084'],
      label: 'Nonexistent Series',
      title: 'Nonexistent Series',
    };
    const withIdItem: TargetItem[] = [
      { id: 's-x', title: 'Something Else', identifiers: ['isbn:9780316129084'] },
    ];
    const r = matchWorks([work], withIdItem, { titleFallback: true, grain: 'series' });
    expect(r.matchedIds).toEqual([]);
    expect(r.missingWorks).toHaveLength(1);
  });
});

// thaynes43/haynesnetwork#759 — members a library holds that read missing.
describe('matchWorks — held books the library files differently', () => {
  it('finds each volume a Kavita series holds, and the series joins the collection once', () => {
    const items: TargetItem[] = [
      {
        id: 'o',
        title: 'Outlander',
        identifiers: [],
        books: [['Outlander'], ['Dragonfly in Amber'], ["Written in My Own Heart's Blood"]],
      },
    ];
    const works = [
      work({ label: 'Outlander (#1)', title: 'Outlander', position: 1 }),
      work({ label: 'Dragonfly in Amber (#2)', title: 'Dragonfly in Amber', position: 2 }),
      work({ label: 'Voyager (#3)', title: 'Voyager', position: 3 }),
      work({
        label: "Written in My Own Heart's Blood (#8)",
        title: "Written in My Own Heart's Blood",
        position: 8,
      }),
    ];
    const r = matchWorks(works, items, { titleFallback: true });
    expect(r.missingWorks.map((w) => w.title)).toEqual(['Voyager']);
    expect(r.matchedIds).toEqual(['o']);
  });

  it('pairs decorated titles, and a source that lists one book twice holds both entries', () => {
    const items: TargetItem[] = [
      { id: 'a', title: 'Expanse 03 - Abaddon’s Gate', identifiers: [] },
      { id: 'c1', title: "Caliban's War", identifiers: [], authors: ['James S. A. Corey'] },
      { id: 'c2', title: "Caliban's War", identifiers: [], authors: ['James S.A. Corey'] },
    ];
    const works = [
      work({
        label: "Caliban's War (#2)",
        title: "Caliban's War",
        position: 2,
        series: 'The Expanse',
      }),
      work({
        label: "Abaddon's Gate (#3)",
        title: "Abaddon's Gate",
        position: 3,
        series: 'The Expanse',
      }),
      work({
        label: "Caliban's War: The Expanse, Book 2 (#?)",
        title: "Caliban's War: The Expanse, Book 2",
        series: 'The Expanse',
      }),
    ];
    const r = matchWorks(works, items, { titleFallback: true, oneSeries: true });
    expect(r.missingWorks).toEqual([]);
    expect(r.matchedVia).toEqual(['title', 'title', 'title']);
  });

  it('a list rank is not a volume: only a work that names its series has a position to guard with', () => {
    const items: TargetItem[] = [
      { id: 'a', title: 'Expanse 03 - Abaddon’s Gate', identifiers: [] },
    ];
    // An NYT-style rank 2 (no series) does not veto volume 3.
    const ranked = matchWorks(
      [work({ label: "Abaddon's Gate", title: "Abaddon's Gate", position: 2 })],
      items,
      {
        titleFallback: true,
      },
    );
    expect(ranked.missingWorks).toEqual([]);
    // A series position 2 does.
    const series = matchWorks(
      [
        work({
          label: "Abaddon's Gate",
          title: "Abaddon's Gate",
          position: 2,
          series: 'The Expanse',
        }),
      ],
      items,
      { titleFallback: true },
    );
    expect(series.missingWorks).toHaveLength(1);
  });

  it('two members that share a stripped title at different volumes take nothing by it', () => {
    const items: TargetItem[] = [{ id: 'x', title: 'Shadows: A Saga Novel', identifiers: [] }];
    const works = [
      work({ label: 'Shadows: Book 1', title: 'Shadows: Book 1', position: 1 }),
      work({ label: 'Shadows: Book 2', title: 'Shadows: Book 2', position: 2 }),
    ];
    const r = matchWorks(works, items, { titleFallback: true });
    expect(r.missingWorks).toHaveLength(2);
  });

  it('series grain matches the series name only, never a book inside it', () => {
    const items: TargetItem[] = [
      { id: 's', title: 'Invincible', identifiers: [], books: [['Family Matters']] },
    ];
    const r = matchWorks([work({ label: 'Family Matters', title: 'Family Matters' })], items, {
      titleFallback: true,
      grain: 'series',
    });
    expect(r.missingWorks).toHaveLength(1);
  });
});

describe('matchWorks — member title aliases (thaynes43/haynesnetwork#777)', () => {
  // The live shapes: the library holds each book under a title that differs from the member's in words.
  const items: TargetItem[] = [
    { id: 'wod', title: 'The World of Divergent', identifiers: [] },
    { id: 'wed', title: 'On the Way to the Wedding with 2nd Epilogue', identifiers: [] },
    {
      id: 'chb',
      title:
        'From Percy Jackson: Camp Half-Blood Confidential: Your Real Guide to the Demigod Training Camp',
      identifiers: [],
      authors: ['Rick Riordan'],
    },
  ];
  const wod = work({
    label: 'The World of Divergent: The Path to Allegiant (#2.5 in Divergent)',
    title: 'The World of Divergent: The Path to Allegiant',
    series: 'Divergent',
    position: 2.5,
  });

  it('a member is held under the title a person aliased it to, and only then', () => {
    expect(matchWorks([wod], items, { titleFallback: true }).missingWorks).toEqual([wod]);
    const r = matchWorks([wod], items, {
      titleFallback: true,
      titleAliases: { 'The World of Divergent: The Path to Allegiant': ['The World of Divergent'] },
    });
    expect(r.matchedIds).toEqual(['wod']);
    expect(r.matchedVia).toEqual(['alias']);
    expect(r.matchedByTitle).toBe(1);
  });

  it('the alias key is compared like a title: case and punctuation never miss it', () => {
    const r = matchWorks([wod], items, {
      titleFallback: true,
      titleAliases: {
        'the world of divergent -- the path to allegiant': ['THE WORLD OF DIVERGENT'],
      },
    });
    expect(r.matchedIds).toEqual(['wod']);
  });

  it('an alias is an exact title, never a prefix: it names the item it was written for', () => {
    const r = matchWorks([wod], items, {
      titleFallback: true,
      titleAliases: { 'The World of Divergent: The Path to Allegiant': ['The World'] },
    });
    expect(r.missingWorks).toEqual([wod]);
  });

  it('a member whose own title is held keeps that item; its alias never moves it', () => {
    const own: TargetItem = { id: 'own', title: 'On the Way to the Wedding', identifiers: [] };
    const wedding = work({
      label: 'On the Way to the Wedding',
      title: 'On the Way to the Wedding',
    });
    const r = matchWorks([wedding], [...items, own], {
      titleFallback: true,
      titleAliases: {
        'On the Way to the Wedding': ['On the Way to the Wedding with 2nd Epilogue'],
      },
    });
    expect(r.matchedIds).toEqual(['own']);
    expect(r.matchedVia).toEqual(['title']);
  });

  it('an own title the library carries but refused stays refused: the alias never moves the member', () => {
    const wedding = work({
      label: 'On the Way to the Wedding',
      title: 'On the Way to the Wedding',
    });
    const aliases = {
      'On the Way to the Wedding': ['On the Way to the Wedding with 2nd Epilogue'],
    };
    // Two items carry the member's own title (ambiguous, refused).
    const twice: TargetItem[] = [
      ...items,
      { id: 'own1', title: 'On the Way to the Wedding', identifiers: [], authors: ['Julia Quinn'] },
      {
        id: 'own2',
        title: 'On the Way to the Wedding',
        identifiers: [],
        authors: ['Someone Else'],
      },
    ];
    expect(
      matchWorks([wedding], twice, { titleFallback: true, titleAliases: aliases }).missingWorks,
    ).toEqual([wedding]);
    // The fallback off: the library carries the own title, so the alias does not stand in for it.
    const once: TargetItem[] = [
      ...items,
      { id: 'own', title: 'On the Way to the Wedding', identifiers: [] },
    ];
    expect(
      matchWorks([wedding], once, { titleFallback: false, titleAliases: aliases }).missingWorks,
    ).toEqual([wedding]);
  });

  it('an alias keeps every guard: the author veto, ambiguity, and an item another member took', () => {
    const camp = work({
      label: 'Camp Half-Blood Confidential',
      title: 'Camp Half-Blood Confidential',
      authors: ['Rick Riordan'],
    });
    const aliases = {
      'Camp Half-Blood Confidential': [
        'From Percy Jackson: Camp Half-Blood Confidential: Your Real Guide to the Demigod Training Camp',
      ],
    };
    expect(
      matchWorks([camp], items, { titleFallback: true, titleAliases: aliases }).matchedIds,
    ).toEqual(['chb']);
    // Another author's book under the aliased title is vetoed.
    const other = work({ ...camp, authors: ['Someone Else'] });
    expect(
      matchWorks([other], items, { titleFallback: true, titleAliases: aliases }).missingWorks,
    ).toEqual([other]);
    // Two items under the aliased title: refused, never guessed.
    const twice: TargetItem[] = [
      ...items,
      { id: 'wod2', title: 'The World of Divergent', identifiers: [], authors: ['Another Writer'] },
    ];
    expect(
      matchWorks([wod], twice, {
        titleFallback: true,
        titleAliases: {
          'The World of Divergent: The Path to Allegiant': ['The World of Divergent'],
        },
      }).missingWorks,
    ).toEqual([wod]);
    // An item a member earlier in the list took by its own title is not taken again by an alias.
    const first = work({ label: 'The World of Divergent', title: 'The World of Divergent' });
    const r = matchWorks([first, wod], items, {
      titleFallback: true,
      titleAliases: { 'The World of Divergent: The Path to Allegiant': ['The World of Divergent'] },
    });
    expect(r.matchedIds).toEqual(['wod']);
    expect(r.missingWorks).toEqual([wod]);
  });

  it('aliases apply with the title fallback off (a person confirmed each), and only aliases do', () => {
    const r = matchWorks(
      [wod, work({ label: 'The World of Divergent', title: 'The World of Divergent' })],
      items,
      {
        titleFallback: false,
        titleAliases: {
          'The World of Divergent: The Path to Allegiant': ['The World of Divergent'],
        },
      },
    );
    expect(r.matchedVia).toEqual(['alias', undefined]);
  });

  it('series grain ignores aliases (a comics recipe pairs whole series by name)', () => {
    const r = matchWorks(
      [work({ label: 'Invincible', title: 'Invincible' })],
      [{ id: 's', title: 'Invincible Universe', identifiers: [] }],
      {
        titleFallback: true,
        grain: 'series',
        titleAliases: { Invincible: ['Invincible Universe'] },
      },
    );
    expect(r.missingWorks).toHaveLength(1);
  });
});

describe('recipeMatchOptions', () => {
  it('carries the recipe’s fallback, grain, series flag and aliases', () => {
    const recipe = recipeSchema.parse({
      id: 'divergent',
      name: 'Divergent',
      targets: [{ server: 'kavita', libraryId: '1' }],
      builder: { type: 'hardcover_series', ref: 'divergent' },
      variables: {
        syncMode: 'sync',
        ordered: true,
        schedule: 'manual',
        titleAliases: {
          'The World of Divergent: The Path to Allegiant': ['The World of Divergent'],
        },
      },
      enabled: true,
    });
    expect(recipeMatchOptions(recipe)).toEqual({
      titleFallback: true,
      grain: 'work',
      oneSeries: true,
      titleAliases: { 'The World of Divergent: The Path to Allegiant': ['The World of Divergent'] },
    });
  });
});

describe('toMissingMember', () => {
  it('projects a work to its identity (title/author/isbn/refs)', () => {
    const member = toMissingMember(
      work({
        identifiers: ['isbn:9781250319890', 'asin:B0CT2QN1XN'],
        label: 'Wind and Truth (#5 in The Stormlight Archive)',
        title: 'Wind and Truth',
        authors: ['Brandon Sanderson'],
      }),
    );
    expect(member).toEqual({
      label: 'Wind and Truth (#5 in The Stormlight Archive)',
      title: 'Wind and Truth',
      authors: ['Brandon Sanderson'],
      isbn: '9781250319890',
      identifiers: ['isbn:9781250319890', 'asin:B0CT2QN1XN'],
    });
  });

  it('names the member by the source’s credits when the work has no authors of its own (#771)', () => {
    const member = toMissingMember(
      work({
        label: 'Gray Dawn (#17 in Easy Rawlins)',
        title: 'Gray Dawn',
        credits: ['Walter Mosley'],
      }),
    );
    expect(member.authors).toEqual(['Walter Mosley']);
    // A work's own authors win over credits.
    expect(
      toMissingMember(work({ label: 'x', authors: ['Andy Weir'], credits: ['Someone Else'] }))
        .authors,
    ).toEqual(['Andy Weir']);
  });

  it('credits never guard the library match (a library’s own author data is too uneven to veto with)', () => {
    const items: TargetItem[] = [
      { id: 'i', title: 'The End is Nigh', identifiers: [], authors: ['Veronica Roth (1)'] },
    ];
    const r = matchWorks(
      [work({ label: 'The End is Nigh', title: 'The End is Nigh', credits: ['Hugh Howey'] })],
      items,
      { titleFallback: true },
    );
    expect(r.matchedIds).toEqual(['i']);
  });

  it('handles an identifier-only work (no title/author/isbn)', () => {
    expect(toMissingMember(work({ identifiers: ['asin:B0071IHYRW'], label: 'x' }))).toEqual({
      label: 'x',
      title: null,
      authors: [],
      isbn: null,
      identifiers: ['asin:B0071IHYRW'],
    });
  });
});
