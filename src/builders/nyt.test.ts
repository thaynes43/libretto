import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NYT_LIST_NAMES, NytListSource, searchNytLists, toTitleCase } from './nyt.js';
import { resolveBuilder } from './index.js';
import { DiskCache } from '../cache/disk.js';
import { makeRecipe, makeTempDir, silentLogger } from '../testing/fixtures.js';
import { startStubServer } from '../testing/http.js';

/**
 * Recorded response shape from the NYT Books API
 * (GET /svc/books/v3/lists/current/{list}.json, verified 2026-07-17): a
 * `results` object with `list_name`/`list_name_encoded` and a `books[]` array
 * whose entries carry `rank`, ALL-CAPS `title`, `author`, `primary_isbn13`,
 * `primary_isbn10` (often ""), and an `isbns[]` array of {isbn10,isbn13}
 * per edition. Books are given out of rank order here to prove the sort.
 */
const LIST_FIXTURE = {
  status: 'OK',
  num_results: 3,
  results: {
    list_name: 'Hardcover Fiction',
    list_name_encoded: 'hardcover-fiction',
    books: [
      {
        rank: 3,
        title: 'THE WOMEN',
        author: 'Kristin Hannah',
        primary_isbn13: '9780385550369',
        primary_isbn10: '',
        isbns: [
          { isbn10: '', isbn13: '9780385550369' },
          { isbn10: '', isbn13: '9780385550376' },
        ],
      },
      {
        rank: 1,
        title: 'YESTERYEAR',
        author: 'Caro Claire Burke',
        primary_isbn13: '9780593804216',
        primary_isbn10: '',
        isbns: [{ isbn10: '', isbn13: '9780593804216' }],
      },
      {
        rank: 2,
        title: 'JAMES',
        author: 'Percival Everett',
        primary_isbn13: '',
        primary_isbn10: '0316129062',
        isbns: [
          { isbn10: '0316129062', isbn13: '9780316129060' },
          { isbn10: '', isbn13: '9780553418026' },
        ],
      },
    ],
  },
};

describe('NytListSource', () => {
  let close: () => Promise<void>;
  let baseUrl: string;
  let cache: DiskCache;
  let cleanup: () => Promise<void>;
  let requests: { ref: string; apiKey: string | undefined }[];
  let sleeps: number[];
  let source: NytListSource;
  // Per-ref counter so a test can make the stub 429 the first N calls.
  let failFirst: number;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    cache = new DiskCache(path.join(tmp.dir, 'cache'));
    requests = [];
    sleeps = [];
    failFirst = 0;

    const app = new Hono();
    app.get('/svc/books/v3/lists/current/:file', (c) => {
      const ref = c.req.param('file').replace(/\.json$/, '');
      requests.push({ ref, apiKey: c.req.query('api-key') });
      if (requests.length <= failFirst) {
        return c.json({ status: 'ERROR', fault: { faultstring: 'Rate limit' } }, 429);
      }
      if (ref !== 'hardcover-fiction') {
        return c.json({ status: 'ERROR', errors: ['list not found'] }, 404);
      }
      return c.json(LIST_FIXTURE);
    });
    const server = await startStubServer(app);
    close = server.close;
    baseUrl = server.url;

    let virtualNow = 1_000_000;
    source = new NytListSource({
      apiKey: 'nyt-key',
      cache,
      log: silentLogger,
      baseUrl,
      // Isolate backoff behavior from the request-pacing gate (its spacing is the
      // hardcover gate pattern, already covered there).
      minIntervalMs: 0,
      now: () => virtualNow,
      sleep: (ms) => {
        sleeps.push(ms);
        virtualNow += ms;
        return Promise.resolve();
      },
    });
  });

  afterEach(async () => {
    await close();
    await cleanup();
  });

  it('resolves a list to rank-ordered works with title-cased labels and authors', async () => {
    const works = await source.listWorks('hardcover-fiction');
    // Sorted by rank (1, 2, 3), titles normalized from ALL-CAPS for display.
    expect(works.map((work) => work.label)).toEqual([
      'Yesteryear (#1 on Hardcover Fiction)',
      'James (#2 on Hardcover Fiction)',
      'The Women (#3 on Hardcover Fiction)',
    ]);
    expect(works.map((work) => work.title)).toEqual(['Yesteryear', 'James', 'The Women']);
    expect(works.map((work) => work.authors)).toEqual([
      ['Caro Claire Burke'],
      ['Percival Everett'],
      ['Kristin Hannah'],
    ]);
    // The api-key rides the query string.
    expect(requests[0]!.apiKey).toBe('nyt-key');
  });

  it('extracts identifiers from primary + isbns[] (isbn10 converted, deduped, in order)', async () => {
    const works = await source.listWorks('hardcover-fiction');
    // rank 1: single isbn13.
    expect(works[0]!.identifiers).toEqual(['isbn:9780593804216']);
    // rank 2: primary_isbn10 converts to isbn13 and ranks first; the duplicate
    // edition in isbns[] is dropped; the second edition follows.
    expect(works[1]!.identifiers).toEqual(['isbn:9780316129060', 'isbn:9780553418026']);
    // rank 3: primary_isbn13 first, then the extra edition from isbns[].
    expect(works[2]!.identifiers).toEqual(['isbn:9780385550369', 'isbn:9780385550376']);
  });

  it('serves repeat resolutions from the disk cache without new requests', async () => {
    const first = await source.listWorks('hardcover-fiction');
    const before = requests.length;
    const second = await source.listWorks('hardcover-fiction');
    expect(second).toEqual(first);
    expect(requests.length).toBe(before);
  });

  it('throws a friendly error naming list_name_encoded when the list is unknown (404)', async () => {
    await expect(source.listWorks('no-such-list')).rejects.toThrow(
      /NYT has no current list named "no-such-list".*list_name_encoded/s,
    );
  });

  it('retries a 429 with backoff, then succeeds', async () => {
    failFirst = 2; // first two calls 429, third succeeds
    const works = await source.listWorks('hardcover-fiction');
    expect(works).toHaveLength(3);
    expect(requests).toHaveLength(3);
    // Exponential backoff: 1000ms then 2000ms between the retries.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('gives up after maxRetries with a rate-limit message', async () => {
    const limited = new NytListSource({
      apiKey: 'nyt-key',
      cache,
      log: silentLogger,
      baseUrl,
      maxRetries: 1,
      now: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    failFirst = 99; // always 429
    await expect(limited.listWorks('hardcover-fiction')).rejects.toThrow(
      'nyt_list builder: NYT rate limit exceeded (HTTP 429)',
    );
  });
});

describe('resolveBuilder nyt_list', () => {
  it('fails honestly when NYT_API_KEY is not configured', async () => {
    const recipe = makeRecipe({ builder: { type: 'nyt_list', ref: 'hardcover-fiction' } });
    await expect(resolveBuilder(recipe.builder, {})).rejects.toThrow(
      'the nyt_list builder needs NYT_API_KEY',
    );
  });

  it('delegates to the wired nyt source', async () => {
    const recipe = makeRecipe({ builder: { type: 'nyt_list', ref: 'hardcover-fiction' } });
    const works = await resolveBuilder(recipe.builder, {
      nytList: { listWorks: (ref) => Promise.resolve([{ identifiers: [ref], label: ref }]) },
    });
    expect(works).toEqual([{ identifiers: ['hardcover-fiction'], label: 'hardcover-fiction' }]);
  });
});

describe('searchNytLists', () => {
  it('filters the curated list names by a display-name substring (case-insensitive)', () => {
    const { results } = searchNytLists('fiction', 25);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.name.toLowerCase().includes('fiction'))).toBe(true);
    expect(results).toContainEqual({ ref: 'hardcover-fiction', name: 'Hardcover Fiction' });
  });

  it('also matches on the encoded ref', () => {
    const { results } = searchNytLists('young-adult', 25);
    expect(results.every((r) => r.ref.includes('young-adult'))).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns the whole set (capped) for a blank query', () => {
    const { results, truncated } = searchNytLists('', 5);
    expect(results).toHaveLength(5);
    expect(truncated).toBe(true);
    expect(results.length).toBeLessThan(NYT_LIST_NAMES.length);
  });

  it('reports truncated when more match than the limit', () => {
    const wide = searchNytLists('', 100);
    expect(wide.results).toHaveLength(NYT_LIST_NAMES.length);
    expect(wide.truncated).toBe(false);
  });

  it('is empty for a no-match query', () => {
    expect(searchNytLists('zzzznope', 25)).toEqual({ results: [], truncated: false });
  });
});

describe('toTitleCase', () => {
  it('lowercases then capitalizes each word, preserving apostrophes', () => {
    expect(toTitleCase('THE WOMEN')).toBe('The Women');
    expect(toTitleCase("CALIBAN'S WAR")).toBe("Caliban's War");
    expect(toTitleCase('JAMES')).toBe('James');
  });
});
