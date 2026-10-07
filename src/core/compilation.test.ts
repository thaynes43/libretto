import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../builders/index.js';
import type { TargetItem } from '../target/types.js';
import { findCompilations, isCompilationTitle } from './compilation.js';
import { matchWorks, toMissingMember } from './match.js';

const w = (title: string, isbn: string): WorkItem => ({
  identifiers: [`isbn:${isbn}`],
  label: title,
  title,
});

describe('isCompilationTitle (libretto#18)', () => {
  it.each([
    'Shatter Me Series: 1-5',
    'The Dark Artifices, the Complete Collection',
    'Shatter Me Starter Pack',
    'The Odd Thomas Series 7-Book Bundle',
    'Harry Potter Boxed Set',
    'Grisha Trilogy Box Set',
    'Hunger Games Omnibus',
    'The Expanse Books 1-3',
  ])('flags %j', (title) => expect(isCompilationTitle(title)).toBe(true));

  it.each([
    'Shatter Me',
    'Lady Midnight',
    'Queen of Air and Darkness',
    'Shadow and Bone (The Grisha Trilogy, #1)',
    'A Collection of Stories',
    'The Book of Three',
  ])('does not flag %j', (title) => expect(isCompilationTitle(title)).toBe(false));

  it('does not flag a missing title', () => expect(isCompilationTitle(undefined)).toBe(false));
});

describe('findCompilations', () => {
  it('is empty when the recipe is ONLY a box set (it stays a wanted work)', () => {
    expect(findCompilations([w('The Dark Artifices Box Set', '1')]).size).toBe(0);
    expect(
      findCompilations([w('Series Box Set', '1'), w('Series: Complete Collection', '2')]).size,
    ).toBe(0);
  });
});

describe('compilations in the missing report (the two issue recipes)', () => {
  const held = (titles: string[]): TargetItem[] =>
    titles.map((title, n) => ({ id: `i${n}`, title, identifiers: [] }));

  it('shatter-me: the Starter Pack ISBN is not missing, the unheld single book still is', () => {
    const works = [
      w('Shatter Me', '9780062085481'),
      w('Unravel Me', '9780062085504'),
      w('Shatter Me Series: 1-5', '9780062372703'),
    ];
    const r = matchWorks(works, held(['Unravel Me']), { titleFallback: true, oneSeries: true });
    expect(r.missingWorks.map((x) => x.label)).toEqual(['Shatter Me']);
    expect(r.compilationWorks.map((x) => x.label)).toEqual(['Shatter Me Series: 1-5']);
    expect(toMissingMember(r.compilationWorks[0]!, 'compilation')).toMatchObject({
      isbn: '9780062372703',
      compilation: true,
    });
    expect(toMissingMember(r.missingWorks[0]!)).not.toHaveProperty('compilation');
  });

  it('the-dark-artifices: the Complete Collection is not missing when every novel is held', () => {
    const works = [
      w('Lady Midnight', '1'),
      w('Lord of Shadows', '2'),
      w('Queen of Air and Darkness', '3'),
      w('The Dark Artifices, the Complete Collection', '9781534488021'),
    ];
    const r = matchWorks(works, held(['Lady Midnight', 'Lord of Shadows']), {
      titleFallback: true,
      oneSeries: true,
    });
    expect(r.missingWorks.map((x) => x.label)).toEqual(['Queen of Air and Darkness']);
    expect(r.compilationWorks).toHaveLength(1);
  });

  it('a recipe that is ONLY a box set keeps it missing', () => {
    const works = [w('The Dark Artifices, the Complete Collection', '9781534488021')];
    const r = matchWorks(works, held([]), { titleFallback: true, oneSeries: true });
    expect(r.missingWorks).toHaveLength(1);
    expect(r.compilationWorks).toHaveLength(0);
  });

  it('an unrelated box set in a mixed (non-series) list stays missing', () => {
    const works = [w('Dune', '1'), w('Harry Potter Boxed Set', '2')];
    const r = matchWorks(works, held([]), { titleFallback: true });
    expect(r.missingWorks).toHaveLength(2);
    expect(r.compilationWorks).toHaveLength(0);
  });

  it('a HELD compilation still matches (it stays in the collection)', () => {
    const works = [w('Shatter Me', '1'), w('Shatter Me Series: 1-5', '2')];
    const items: TargetItem[] = [{ id: 'box', title: 'x', identifiers: ['isbn:2'] }];
    const r = matchWorks(works, items, { titleFallback: true, oneSeries: true });
    expect(r.matchedIds).toEqual(['box']);
    expect(r.compilationWorks).toHaveLength(0);
  });

  it('series grain never flags compilations', () => {
    const r = matchWorks([w('Invincible', '1'), w('Box Set Heroes', '2')], held([]), {
      titleFallback: true,
      oneSeries: true,
      grain: 'series',
    });
    expect(r.compilationWorks).toHaveLength(0);
    expect(r.missingWorks).toHaveLength(2);
  });
});
