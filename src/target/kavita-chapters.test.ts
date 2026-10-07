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
