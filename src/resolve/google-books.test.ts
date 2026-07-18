import { describe, expect, it } from 'vitest';
import {
  gbQueryTitle,
  gbAuthorsMatch,
  gbResolveTitleMatches,
  GoogleBooksResolver,
} from './google-books.js';

/** Build a fake fetch that answers each GB `q=` with a canned volumes payload (or empty). */
function fakeFetch(byQuery: Record<string, unknown[]>): {
  fetchImpl: typeof fetch;
  queries: string[];
} {
  const queries: string[] = [];
  const fetchImpl = (async (url: string | URL): Promise<Response> => {
    const u = new URL(String(url));
    const q = u.searchParams.get('q') ?? '';
    queries.push(q);
    const items = byQuery[q] ?? [];
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, queries };
}

const vol = (id: string, title: string, authors?: string[], isbn13?: string) => ({
  id,
  volumeInfo: {
    title,
    ...(authors ? { authors } : {}),
    ...(isbn13 ? { industryIdentifiers: [{ type: 'ISBN_13', identifier: isbn13 }] } : {}),
  },
});

describe('gbQueryTitle', () => {
  it('strips leading file-title series prefixes', () => {
    expect(gbQueryTitle('Expanse 05 - Nemesis Games')).toBe('Nemesis Games');
    expect(gbQueryTitle("Wheel of Time [09]: Winter's Heart")).toBe("Winter's Heart");
    expect(gbQueryTitle('The Summer I Turned Pretty [Summer, Book 1]')).toBe(
      'The Summer I Turned Pretty',
    );
  });
  it('leaves bare-numeric and slash-date titles untouched', () => {
    expect(gbQueryTitle('1984')).toBe('1984');
    expect(gbQueryTitle('11/22/63')).toBe('11/22/63');
  });
});

describe('gbAuthorsMatch / gbResolveTitleMatches guards', () => {
  it('accepts a shared surname, rejects a disjoint author', () => {
    expect(gbAuthorsMatch('C. Harris', ['Charlaine Harris'])).toBe(true);
    expect(gbAuthorsMatch('Dean Koontz', ['Simon Beckett'])).toBe(false);
  });
  it('requires >=60% title-token coverage', () => {
    expect(gbResolveTitleMatches('Kingdom of Ash', 'Kingdom of Ash')).toBe(true);
    expect(gbResolveTitleMatches('Kingdom of Ash', 'Kingdom Hearts')).toBe(false);
  });
});

describe('GoogleBooksResolver.resolveVolume', () => {
  it('returns null with no key against the real GB API', async () => {
    const r = new GoogleBooksResolver({});
    expect(r.enabled).toBe(false);
    expect(await r.resolveVolume({ isbn: '9780316129084', title: 'Leviathan Wakes' })).toBeNull();
  });

  it('resolves by ISBN first, one call, no title query', async () => {
    const { fetchImpl, queries } = fakeFetch({
      'isbn:9780316129084': [
        vol('VOL_LW', 'Leviathan Wakes', ['James S. A. Corey'], '9780316129084'),
      ],
    });
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl });
    const out = await r.resolveVolume({ isbn: '9780316129084', title: 'Leviathan Wakes' });
    expect(out).toEqual({ volumeId: 'VOL_LW', isbn13: '9780316129084', via: 'isbn' });
    expect(queries).toEqual(['isbn:9780316129084']);
  });

  it('falls back to a guarded title query when there is no ISBN', async () => {
    const { fetchImpl } = fakeFetch({
      'intitle:Nemesis Games+inauthor:James S. A. Corey': [
        vol('VOL_NG', 'Nemesis Games', ['James S. A. Corey'], '9780316334716'),
      ],
    });
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl });
    const out = await r.resolveVolume({
      title: 'Expanse 05 - Nemesis Games',
      author: 'James S. A. Corey',
    });
    expect(out).toEqual({ volumeId: 'VOL_NG', isbn13: '9780316334716', via: 'title' });
  });

  it('rejects a title resolve that fails the coverage guard (honest null, no wrong-work id)', async () => {
    const { fetchImpl } = fakeFetch({
      'intitle:Kingdom of Ash': [vol('VOL_WRONG', 'Kingdom Hearts', ['Someone Else'])],
    });
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl });
    expect(await r.resolveVolume({ title: 'Kingdom of Ash' })).toBeNull();
  });

  it('rejects a title resolve that fails the author guard', async () => {
    const { fetchImpl } = fakeFetch({
      'intitle:Whispers+inauthor:Dean Koontz': [vol('VOL_X', 'Whispers', ['Simon Beckett'])],
    });
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl });
    expect(await r.resolveVolume({ title: 'Whispers', author: 'Dean Koontz' })).toBeNull();
  });

  it('uses the pre-colon fallback on a full-title miss', async () => {
    const { fetchImpl, queries } = fakeFetch({
      'intitle:Dead Ever After': [vol('VOL_DEA', 'Dead Ever After', ['Charlaine Harris'])],
    });
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl });
    const out = await r.resolveVolume({ title: 'Dead Ever After: A Sookie Stackhouse Novel' });
    expect(out?.volumeId).toBe('VOL_DEA');
    // first the full title missed, then the pre-colon retry hit.
    expect(queries).toContain('intitle:Dead Ever After: A Sookie Stackhouse Novel');
    expect(queries).toContain('intitle:Dead Ever After');
  });
});
