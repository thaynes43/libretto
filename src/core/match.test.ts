import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../builders/index.js';
import type { TargetItem } from '../target/types.js';
import { matchWorks, toMissingMember } from './match.js';

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
