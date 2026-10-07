import { describe, expect, it } from 'vitest';
import { selectBookChapters } from './kavita-chapters.js';
import type { MatchedWork } from './types.js';

describe('canonical Kavita book chapters', () => {
  const clare: MatchedWork = {
    itemId: '160',
    work: {
      label: 'City of Bones',
      title: 'City of Bones',
      identifiers: ['isbn:9781406331417'],
      credits: ['Cassandra Clare'],
    },
  };
  const chapters = [
    {
      id: 184,
      isbn: '9781406331417',
      titleName: 'City of Bones',
      writers: [{ name: 'Cassandra Clare' }],
    },
    { id: 185, isbn: '', titleName: 'City of Bones', writers: [{ name: 'Martha Wells' }] },
  ];

  it('selects the exact ISBN and excludes the complete same-title foreign author', () => {
    expect(selectBookChapters('160', chapters, [clare]).get(clare)).toEqual([184]);
  });

  it('excludes a known unrelated full title without requiring Writer metadata', () => {
    expect(
      selectBookChapters(
        '160',
        [chapters[0]!, { id: 999, titleName: 'Known other book' }],
        [clare],
      ).get(clare),
    ).toEqual([184]);
    expect(() =>
      selectBookChapters('160', [chapters[0]!, { id: 999, titleName: '', title: '0' }], [clare]),
    ).toThrow('incomplete book identities');
  });

  it('uses full title and Hardcover credits when chapters expose no matching ISBN', () => {
    const copies = [
      { ...chapters[0]!, isbn: null },
      { ...chapters[0]!, id: 186, isbn: null },
      chapters[1]!,
    ];
    expect(selectBookChapters('160', copies, [clare]).get(clare)).toEqual([184, 186]);
  });

  it('accepts only the full alias the library matcher confirmed', () => {
    const alias = { ...clare, confirmedTitle: 'City of Bones: A Mortal Instruments Novel' };
    expect(
      selectBookChapters(
        '160',
        [{ ...chapters[0]!, isbn: null, titleName: alias.confirmedTitle }],
        [alias],
      ).get(alias),
    ).toEqual([184]);
    expect(() =>
      selectBookChapters('160', [{ ...chapters[0]!, isbn: null, titleName: 'City' }], [alias]),
    ).toThrow('no longer verified');
  });

  it('excludes same-title books sharing only a first name or surname', () => {
    for (const [canonical, foreign] of [
      ['John Grisham', 'John Adams'],
      ['Frank Herbert', 'Brian Herbert'],
    ] as const) {
      const match: MatchedWork = {
        itemId: '1',
        work: { label: 'Same title', title: 'Same title', identifiers: [], credits: [canonical] },
      };
      const copies = [
        { id: 1, titleName: 'Same title', writers: [{ name: canonical }] },
        { id: 2, titleName: 'Same title', writers: [{ name: foreign }] },
      ];
      expect(selectBookChapters('1', copies, [match]).get(match)).toEqual([1]);
    }
  });

  it('confirms full names despite case, accents, punctuation and initial spacing', () => {
    const match: MatchedWork = {
      itemId: '1',
      work: { label: 'Book', title: 'Book', identifiers: [], credits: ['J.K. Rówling'] },
    };
    expect(
      selectBookChapters(
        '1',
        [{ id: 1, titleName: 'Book', writers: [{ name: 'j. k. rowling' }] }],
        [match],
      ).get(match),
    ).toEqual([1]);
    expect(() =>
      selectBookChapters(
        '1',
        [{ id: 1, titleName: 'Book', writers: [{ name: 'Joanne Kathleen Rowling' }] }],
        [match],
      ),
    ).toThrow('no longer verified');
    expect(
      selectBookChapters(
        '1',
        [{ id: 1, titleName: 'Book', writers: [{ name: 'Rowling, J.K.' }] }],
        [match],
      ).get(match),
    ).toEqual([1]);
    expect(() =>
      selectBookChapters(
        '1',
        [{ id: 1, titleName: 'Book', writers: [{ name: 'Rowling J.K.' }] }],
        [match],
      ),
    ).toThrow('no longer verified');
    for (const name of ['Rowling, J.K., PhD', 'Rowling,', ',J.K.'])
      expect(() =>
        selectBookChapters('1', [{ id: 1, titleName: 'Book', writers: [{ name }] }], [match]),
      ).toThrow('incomplete book identities');
  });

  it('accepts an equal ISBN even when the author metadata spells an expanded name', () => {
    const match: MatchedWork = {
      itemId: '1',
      work: {
        label: 'Book',
        title: 'Book',
        identifiers: ['isbn:9780747532743'],
        credits: ['J.K. Rowling'],
      },
    };
    expect(
      selectBookChapters(
        '1',
        [
          {
            id: 1,
            isbn: '9780747532743',
            titleName: 'Book',
            writers: [{ name: 'Joanne Kathleen Rowling' }],
          },
        ],
        [match],
      ).get(match),
    ).toEqual([1]);
  });

  it('refuses unknown chapter identities and missing canonical author agreement', () => {
    expect(() =>
      selectBookChapters('160', [chapters[0]!, { id: 185, titleName: 'City of Bones' }], [clare]),
    ).toThrow('incomplete book identities');
    const noCredits = { ...clare, work: { ...clare.work, credits: [] } };
    expect(() => selectBookChapters('160', [{ ...chapters[0]!, isbn: null }], [noCredits])).toThrow(
      'incomplete book identities',
    );
  });
});
