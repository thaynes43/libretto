import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../builders/index.js';
import type { TargetItem } from '../target/types.js';
import { matchWorks, toMissingMember, toPreviewMember } from './match.js';
import { findUnnumbered, isUnnumberedSeriesWork } from './unnumbered.js';

const SERIES = 'Throne of Glass';

/** A hardcover_series work: numbered when `position` is given, unnumbered otherwise. */
const w = (title: string, isbn: string, position?: number): WorkItem => ({
  identifiers: [`isbn:${isbn}`],
  label: `${title} (#${position ?? '?'} in ${SERIES})`,
  title,
  series: SERIES,
  ...(position === undefined ? {} : { position }),
});

const held = (titles: string[]): TargetItem[] =>
  titles.map((title, n) => ({ id: `i${n}`, title, identifiers: [] }));

const oneSeries = { titleFallback: true, oneSeries: true } as const;

describe('isUnnumberedSeriesWork (libretto#30)', () => {
  it('is a series work with no position', () => {
    expect(isUnnumberedSeriesWork(w('The Throne of Glass Coloring Book', '9'))).toBe(true);
  });
  it('is not a numbered one, position 0 included', () => {
    expect(isUnnumberedSeriesWork(w('Throne of Glass', '1', 1))).toBe(false);
    expect(isUnnumberedSeriesWork(w('The Assassin and the Pirate Lord', '0', 0))).toBe(false);
  });
  it('is not a work that names no series (static_ids, nyt_list)', () => {
    expect(isUnnumberedSeriesWork({ identifiers: ['isbn:1'], label: 'Dune', title: 'Dune' })).toBe(
      false,
    );
  });
});

describe('findUnnumbered', () => {
  it('finds the unnumbered book beside numbered ones', () => {
    const coloring = w('The Throne of Glass Coloring Book', '9');
    expect([...findUnnumbered([w('Throne of Glass', '1', 1), coloring])]).toEqual([coloring]);
  });
  it('is empty when no member is numbered (a series with no numbering is its books)', () => {
    expect(findUnnumbered([w('Silo Stories', '1')]).size).toBe(0);
  });
});

describe('unnumbered books in the missing report', () => {
  const works = [
    w('Throne of Glass', '1', 1),
    w('Crown of Midnight', '2', 2),
    w('The Throne of Glass Coloring Book', '9781681198019'),
  ];

  it('an unheld unnumbered book is neither missing nor a compilation; it is reported apart', () => {
    const r = matchWorks(works, held(['Throne of Glass']), oneSeries);
    expect(r.missingWorks.map((x) => x.title)).toEqual(['Crown of Midnight']);
    expect(r.unnumberedWorks.map((x) => x.title)).toEqual(['The Throne of Glass Coloring Book']);
    expect(r.compilationWorks).toHaveLength(0);
    expect(toMissingMember(r.unnumberedWorks[0]!, 'unnumbered')).toMatchObject({
      isbn: '9781681198019',
      unnumbered: true,
    });
    const plain = toMissingMember(r.missingWorks[0]!);
    expect(plain).not.toHaveProperty('unnumbered');
    expect(plain).not.toHaveProperty('compilation');
  });

  it('a HELD unnumbered book still matches (it stays in the collection)', () => {
    const r = matchWorks(works, held(['The Throne of Glass Coloring Book']), oneSeries);
    expect(r.matchedIds).toEqual(['i0']);
    expect(r.unnumberedWorks).toHaveLength(0);
    expect(r.missingWorks.map((x) => x.title)).toEqual(['Throne of Glass', 'Crown of Midnight']);
  });

  it('a real unnumbered read is treated the same (the ruling covers it)', () => {
    const potter = [
      { ...w("Harry Potter and the Sorcerer's Stone", '1', 1), series: 'Harry Potter' },
      { ...w('Harry Potter and the Cursed Child', '8'), series: 'Harry Potter' },
    ];
    const r = matchWorks(potter, held([]), oneSeries);
    expect(r.missingWorks.map((x) => x.title)).toEqual(["Harry Potter and the Sorcerer's Stone"]);
    expect(r.unnumberedWorks.map((x) => x.title)).toEqual(['Harry Potter and the Cursed Child']);
  });

  it('an unnumbered compilation stays a compilation', () => {
    const r = matchWorks(
      [w('Shatter Me', '1', 1), w('Shatter Me Series: 1-5', '9780062372703')],
      held([]),
      oneSeries,
    );
    expect(r.compilationWorks.map((x) => x.title)).toEqual(['Shatter Me Series: 1-5']);
    expect(r.unnumberedWorks).toHaveLength(0);
  });

  it('a series whose only member is unnumbered keeps it missing', () => {
    const r = matchWorks([w('Silo Stories', '1')], held([]), oneSeries);
    expect(r.missingWorks).toHaveLength(1);
    expect(r.unnumberedWorks).toHaveLength(0);
  });

  it('only a one-series list sets them apart', () => {
    const r = matchWorks(works, held([]), { titleFallback: true });
    expect(r.missingWorks).toHaveLength(3);
    expect(r.unnumberedWorks).toHaveLength(0);
  });

  it('series grain never sets them apart', () => {
    const r = matchWorks(works, held([]), { ...oneSeries, grain: 'series' });
    expect(r.unnumberedWorks).toHaveLength(0);
  });

  it('the preview flags an unnumbered member', () => {
    expect(toPreviewMember(works[2]!, 'unnumbered')).toMatchObject({
      position: null,
      unnumbered: true,
    });
    expect(toPreviewMember(works[0]!)).not.toHaveProperty('unnumbered');
  });
});
