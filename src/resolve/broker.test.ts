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
