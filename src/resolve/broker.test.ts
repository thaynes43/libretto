import { describe, expect, it } from 'vitest';
import { silentLogger } from '../testing/fixtures.js';
import { brokerFromResolver } from './broker.js';
import { GoogleBooksResolver } from './google-books.js';

/** A daily-quota 429 body (RESOURCE_EXHAUSTED + "Queries per day") — the exact incident signal. */
const QUOTA_BODY = {
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'.",
    errors: [{ reason: 'dailyLimitExceeded' }],
    status: 'RESOURCE_EXHAUSTED',
  },
};

/** A fetch that answers every request with `status`/`body`. */
function statusFetch(status: number, body: unknown): typeof fetch {
  return (async (): Promise<Response> =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function brokerWith(fetchImpl: typeof fetch, opts: { retries?: number } = {}) {
  const resolver = new GoogleBooksResolver({
    apiKey: 'k',
    fetchImpl,
    sleepImpl: async () => {},
    log: silentLogger,
    ...(opts.retries === undefined ? {} : { retries: opts.retries }),
  });
  return brokerFromResolver(resolver, silentLogger);
}

describe('resolve broker — additive honesty reason', () => {
  it('reason "resolved" with the volume on an ISBN hit', async () => {
    const fetchImpl = statusFetch(200, {
      items: [
        {
          id: 'VOL_LW',
          volumeInfo: {
            title: 'Leviathan Wakes',
            industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780316129084' }],
          },
        },
      ],
    });
    const out = await brokerWith(fetchImpl).resolve({
      isbn: '9780316129084',
      title: 'Leviathan Wakes',
    });
    expect(out).toEqual({
      resolved: { volumeId: 'VOL_LW', isbn13: '9780316129084', via: 'isbn' },
      reason: 'resolved',
    });
  });

  it('reason "no_match" (resolved:null) on a legitimate 200 totalItems:0', async () => {
    const out = await brokerWith(statusFetch(200, { items: [] })).resolve({
      isbn: '9780000000000',
      title: 'No Such Book',
      authors: ['Nobody'],
    });
    expect(out).toEqual({ resolved: null, reason: 'no_match' });
  });

  it('reason "quota_exhausted" (resolved:null) on a daily-quota 429 — NOT conflated with a no-match', async () => {
    const out = await brokerWith(statusFetch(429, QUOTA_BODY)).resolve({
      isbn: '9780316129084',
      title: 'Leviathan Wakes',
    });
    // resolved stays null so downstream (haynesnetwork wants pass) self-heals hourly; reason tells the truth.
    expect(out).toEqual({ resolved: null, reason: 'quota_exhausted' });
  });

  it('reason "upstream_error" (resolved:null) on a persistent 5xx', async () => {
    const out = await brokerWith(statusFetch(503, { error: { message: 'backend error' } }), {
      retries: 0,
    }).resolve({ isbn: '9780316129084', title: 'Leviathan Wakes' });
    expect(out).toEqual({ resolved: null, reason: 'upstream_error' });
  });
});

describe('resolve broker — the acquisition language check (issue #26)', () => {
  const frenchOnly = statusFetch(200, {
    items: [{ id: 'J_DajwEACAAJ', volumeInfo: { title: 'Troll Bridge', language: 'fr' } }],
  });

  it('reason "wrong_language" when only a refused edition is found', async () => {
    const out = await brokerWith(frenchOnly).resolve({
      isbn: '9782841721399',
      title: 'Troll Bridge',
      acceptLanguage: (language) => language === 'en',
    });
    expect(out).toEqual({ resolved: null, reason: 'wrong_language' });
  });

  it('without a check (the /api/resolve service) the same volume resolves', async () => {
    const out = await brokerWith(frenchOnly).resolve({
      isbn: '9782841721399',
      title: 'Troll Bridge',
    });
    expect(out.reason).toBe('resolved');
    expect(out.resolved?.language).toBe('fr');
  });

  it('reason "wrong_language" when the ISBN leg was refused and the title leg then hits a dead quota', async () => {
    let call = 0;
    const fetchImpl = (async (): Promise<Response> => {
      call += 1;
      return call === 1
        ? new Response(
            JSON.stringify({
              items: [
                { id: 'J_DajwEACAAJ', volumeInfo: { title: 'Drame de troll', language: 'fr' } },
              ],
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify(QUOTA_BODY), { status: 429 });
    }) as unknown as typeof fetch;
    const out = await brokerWith(fetchImpl, { retries: 0 }).resolve({
      isbn: '9782841721399',
      title: 'Troll Bridge',
      acceptLanguage: (language) => language === 'en',
    });
    expect(out).toEqual({ resolved: null, reason: 'wrong_language' });
    expect(call).toBe(2);
  });

  it('a dead quota with no refusal is still reported as the quota', async () => {
    const out = await brokerWith(statusFetch(429, QUOTA_BODY), { retries: 0 }).resolve({
      isbn: '9780316129084',
      title: 'Leviathan Wakes',
      acceptLanguage: (language) => language === 'en',
    });
    expect(out.reason).toBe('quota_exhausted');
  });
});

describe('resolve broker — honest no_match cache (issue #34)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A fetch that counts requests and answers each with `status`/`body`. */
  function countingFetch(status: number, body: unknown) {
    const calls = { n: 0 };
    const fetchImpl = (async (): Promise<Response> => {
      calls.n += 1;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  function cachedBroker(fetchImpl: typeof fetch, clock: { now: number }, noMatchTtlMs = DAY) {
    const resolver = new GoogleBooksResolver({
      apiKey: 'k',
      fetchImpl,
      sleepImpl: async () => {},
      log: silentLogger,
      retries: 0,
    });
    return brokerFromResolver(resolver, silentLogger, { noMatchTtlMs, nowImpl: () => clock.now });
  }

  const want = { isbn: '9780000000000', title: 'Compulsory', authors: ['Nobody'] };

  it('answers a repeat no_match inside 24h with zero Google Books requests', async () => {
    const { fetchImpl, calls } = countingFetch(200, { items: [] });
    const clock = { now: 1_000_000 };
    const broker = cachedBroker(fetchImpl, clock);
    expect(await broker.resolve(want)).toEqual({ resolved: null, reason: 'no_match' });
    const spent = calls.n;
    expect(spent).toBeGreaterThan(0);
    clock.now += DAY - 1;
    expect(await broker.resolve(want)).toEqual({ resolved: null, reason: 'no_match' });
    expect(calls.n).toBe(spent);
  });

  it('refetches once the 24h TTL has passed', async () => {
    const { fetchImpl, calls } = countingFetch(200, { items: [] });
    const clock = { now: 1_000_000 };
    const broker = cachedBroker(fetchImpl, clock);
    await broker.resolve(want);
    const spent = calls.n;
    clock.now += DAY;
    expect(await broker.resolve(want)).toEqual({ resolved: null, reason: 'no_match' });
    expect(calls.n).toBe(spent * 2);
  });

  it('shares an entry across trivial spelling differences, with the ISBN taken from identifiers', async () => {
    const { fetchImpl, calls } = countingFetch(200, { items: [] });
    const broker = cachedBroker(fetchImpl, { now: 1 });
    await broker.resolve(want);
    const spent = calls.n;
    await broker.resolve({
      identifiers: ['isbn:9780000000000'],
      title: '  COMPULSORY ',
      authors: ['nobody'],
    });
    expect(calls.n).toBe(spent);
  });

  it('keeps different wants apart (isbn, title, author, volume number)', async () => {
    const { fetchImpl, calls } = countingFetch(200, { items: [] });
    const broker = cachedBroker(fetchImpl, { now: 1 });
    await broker.resolve(want);
    let spent = calls.n;
    for (const other of [
      { ...want, isbn: '9781111111111' },
      { ...want, title: 'Compulsory Two' },
      { ...want, authors: ['Somebody Else'] },
      { title: 'Wheel of Time [09]', authors: ['Jordan'] },
      { title: 'Wheel of Time [10]', authors: ['Jordan'] },
    ]) {
      await broker.resolve(other);
      expect(calls.n).toBeGreaterThan(spent);
      spent = calls.n;
    }
  });

  it('keeps distinct non-Latin titles apart when there is no ISBN', async () => {
    const { fetchImpl, calls } = countingFetch(200, { items: [] });
    const broker = cachedBroker(fetchImpl, { now: 1 });
    await broker.resolve({ title: 'Война и мир', authors: ['Толстой'] });
    const spent = calls.n;
    await broker.resolve({ title: 'Анна Каренина', authors: ['Толстой'] });
    expect(calls.n).toBeGreaterThan(spent);
    // The same Cyrillic want still hits.
    const again = calls.n;
    await broker.resolve({ title: 'Анна Каренина', authors: ['Толстой'] });
    expect(calls.n).toBe(again);
  });

  it('keeps Devanagari titles apart: vowel signs are combining marks and must survive the fold', async () => {
    const { fetchImpl, calls } = countingFetch(200, { items: [] });
    const broker = cachedBroker(fetchImpl, { now: 1 });
    await broker.resolve({ title: 'दिन' });
    const spent = calls.n;
    await broker.resolve({ title: 'दान' });
    expect(calls.n).toBeGreaterThan(spent);
  });

  it('never caches quota_exhausted', async () => {
    const { fetchImpl, calls } = countingFetch(429, QUOTA_BODY);
    const clock = { now: 1 };
    const broker = cachedBroker(fetchImpl, clock);
    expect((await broker.resolve(want)).reason).toBe('quota_exhausted');
    // A quota that has recovered must be asked again: swap in a fetch that answers no_match and check it is called.
    const recovered = countingFetch(200, { items: [] });
    const broker2 = cachedBroker(recovered.fetchImpl, clock);
    expect((await broker2.resolve(want)).reason).toBe('no_match');
    expect(calls.n).toBe(1);
    expect(recovered.calls.n).toBeGreaterThan(0);
  });

  it('never caches upstream_error', async () => {
    const { fetchImpl, calls } = countingFetch(503, { error: { message: 'backend error' } });
    const broker = cachedBroker(fetchImpl, { now: 1 });
    expect((await broker.resolve(want)).reason).toBe('upstream_error');
    const spent = calls.n;
    expect((await broker.resolve(want)).reason).toBe('upstream_error');
    expect(calls.n).toBeGreaterThan(spent);
  });

  it('never caches wrong_language', async () => {
    const { fetchImpl, calls } = countingFetch(200, {
      items: [
        { id: 'VOL_FR', volumeInfo: { title: 'Compulsory', authors: ['Nobody'], language: 'fr' } },
      ],
    });
    const broker = cachedBroker(fetchImpl, { now: 1 });
    const input = { ...want, acceptLanguage: (l: string | null) => l === 'en' };
    expect((await broker.resolve(input)).reason).toBe('wrong_language');
    const spent = calls.n;
    expect((await broker.resolve(input)).reason).toBe('wrong_language');
    expect(calls.n).toBeGreaterThan(spent);
  });

  it('never caches a miss after the ISBN leg failed transiently', async () => {
    let n = 0;
    const fetchImpl = (async (input: unknown): Promise<Response> => {
      n += 1;
      const url = String(input);
      if (url.includes('isbn%3A') || url.includes('isbn:')) {
        return new Response(JSON.stringify({ error: { message: 'backend error' } }), {
          status: 503,
        });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const broker = cachedBroker(fetchImpl, { now: 1 });
    expect((await broker.resolve(want)).reason).toBe('no_match');
    const spent = n;
    await broker.resolve(want);
    expect(n).toBeGreaterThan(spent);
  });

  it('never caches a resolved volume', async () => {
    const { fetchImpl, calls } = countingFetch(200, {
      items: [
        {
          id: 'VOL_LW',
          volumeInfo: {
            title: 'Leviathan Wakes',
            industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780316129084' }],
          },
        },
      ],
    });
    const broker = cachedBroker(fetchImpl, { now: 1 });
    const input = { isbn: '9780316129084', title: 'Leviathan Wakes' };
    await broker.resolve(input);
    await broker.resolve(input);
    expect(calls.n).toBe(2);
  });

  it('a TTL of 0 turns the cache off', async () => {
    const { fetchImpl, calls } = countingFetch(200, { items: [] });
    const broker = cachedBroker(fetchImpl, { now: 1 }, 0);
    await broker.resolve(want);
    const spent = calls.n;
    await broker.resolve(want);
    expect(calls.n).toBe(spent * 2);
  });
});
