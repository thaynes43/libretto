import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HardcoverSeriesSource } from './hardcover.js';
import { DiskCache } from '../cache/disk.js';
import { makeTempDir, silentLogger } from '../testing/fixtures.js';
import { startStubServer } from '../testing/http.js';

/**
 * Recorded response shapes from the Hardcover GraphQL API (docs source,
 * docs.hardcover.app): series -> book_series (position-ordered) -> book with
 * default edition id scalars; editions queried flat by book_id because query
 * depth is capped at 3.
 */
const SERIES_FIXTURE = {
  series: [
    {
      id: 4,
      name: 'The Expanse',
      slug: 'the-expanse',
      book_series: [
        {
          position: 1,
          book: {
            id: 101,
            title: 'Leviathan Wakes',
            default_physical_edition_id: 1001,
            default_ebook_edition_id: null,
            default_audio_edition_id: 1003,
          },
        },
        {
          position: 2,
          book: {
            id: 102,
            title: "Caliban's War",
            default_physical_edition_id: null,
            default_ebook_edition_id: null,
            default_audio_edition_id: null,
          },
        },
        { position: 3, book: null },
        {
          position: 4,
          book: {
            id: 104,
            title: 'Cibola Burn',
            default_physical_edition_id: null,
            default_ebook_edition_id: null,
            default_audio_edition_id: null,
          },
        },
      ],
    },
  ],
};

const EDITIONS_FIXTURE = {
  editions: [
    // Sorted by users_count desc, as the query orders them.
    { id: 1002, book_id: 101, isbn_13: '9780553418026', isbn_10: null, asin: null },
    { id: 1001, book_id: 101, isbn_13: '9780316129084', isbn_10: null, asin: null },
    { id: 1003, book_id: 101, isbn_13: null, isbn_10: null, asin: 'B0071IHYRW' },
    { id: 2001, book_id: 102, isbn_13: null, isbn_10: '0316129062', asin: null },
    // book 104 has no editions with identifiers.
  ],
};

describe('HardcoverSeriesSource', () => {
  let close: () => Promise<void>;
  let url: string;
  let cache: DiskCache;
  let cleanup: () => Promise<void>;
  let requests: { auth: string | undefined; query: string; variables: unknown }[];
  let sleeps: number[];
  let source: HardcoverSeriesSource;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    cache = new DiskCache(path.join(tmp.dir, 'cache'));
    requests = [];
    sleeps = [];

    const app = new Hono();
    app.post('/', async (c) => {
      const body = await c.req.json<{ query: string; variables: unknown }>();
      requests.push({
        auth: c.req.header('authorization'),
        query: body.query,
        variables: body.variables,
      });
      if (body.query.includes('LibrettoSeriesWorks')) {
        const where = (body.variables as { where: Record<string, unknown> }).where;
        const wantsUnknown = JSON.stringify(where).includes('no-such-series');
        return c.json({ data: wantsUnknown ? { series: [] } : SERIES_FIXTURE });
      }
      if (body.query.includes('LibrettoBookEditions')) {
        return c.json({ data: EDITIONS_FIXTURE });
      }
      return c.json({ errors: [{ message: 'unknown operation' }] });
    });
    const server = await startStubServer(app);
    close = server.close;
    url = server.url;

    let virtualNow = 1_000_000;
    source = new HardcoverSeriesSource({
      token: 'hc-token',
      cache,
      log: silentLogger,
      url,
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

  it('resolves a series slug to position-ordered works with normalized identifiers', async () => {
    const works = await source.seriesWorks('the-expanse');
    expect(works.map((work) => work.label)).toEqual([
      'Leviathan Wakes (#1 in The Expanse)',
      "Caliban's War (#2 in The Expanse)",
      'Cibola Burn (#4 in The Expanse)',
    ]);
    // Default editions rank first; the rest keep users_count order. ISBN-10
    // converts to ISBN-13; ASINs come along.
    expect(works[0]!.identifiers).toEqual([
      'isbn:9780316129084',
      'asin:B0071IHYRW',
      'isbn:9780553418026',
    ]);
    expect(works[1]!.identifiers).toEqual(['isbn:9780316129060']);
    // A book with no identifier-bearing editions is emitted honestly (it can
    // only ever land in missing[]).
    expect(works[2]!.identifiers).toEqual([]);
    // Bearer prefix is added to a bare token.
    expect(requests[0]!.auth).toBe('Bearer hc-token');
  });

  it('queries by id when the ref is numeric', async () => {
    await source.seriesWorks('4');
    expect(requests[0]!.variables).toEqual({ where: { id: { _eq: 4 } } });
  });

  it('paces requests at least minIntervalMs apart', async () => {
    await source.seriesWorks('the-expanse');
    // Two requests (series + editions): the second waits out the interval.
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([1100]);
  });

  it('serves repeat resolutions from the disk cache without new requests', async () => {
    const first = await source.seriesWorks('the-expanse');
    const before = requests.length;
    const second = await source.seriesWorks('the-expanse');
    expect(second).toEqual(first);
    expect(requests.length).toBe(before);
  });

  it('throws honestly when the series does not exist', async () => {
    await expect(source.seriesWorks('no-such-series')).rejects.toThrow(
      'hardcover series "no-such-series" not found',
    );
  });

  it('surfaces graphql errors as errors', async () => {
    // An unknown operation makes the stub return an errors[] payload; force it
    // by asking through a source pointed at a query the stub rejects.
    const bad = new HardcoverSeriesSource({
      token: 'hc-token',
      cache,
      log: silentLogger,
      url: `${url}/`,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    // Simulate by clearing the cache and intercepting: the stub only errors on
    // unknown queries, so this asserts the error path via a directly crafted
    // request instead.
    await expect(
      (bad as unknown as { request: (q: string, v: object) => Promise<unknown> }).request(
        'query Nope { nope }',
        {},
      ),
    ).rejects.toThrow('hardcover graphql error: unknown operation');
  });
});
