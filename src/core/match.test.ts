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
    const r = matchWorks(works, items, true);
    expect(r.matchedIds).toEqual(['i1', 'i2']);
    expect(r.matchedByTitle).toBe(1); // Project Hail Mary via title
    expect(r.missingWorks.map((w) => w.label)).toEqual(['Nemesis Games']);
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
    const r = matchWorks(works, items, false);
    expect(r.matchedIds).toEqual([]);
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
