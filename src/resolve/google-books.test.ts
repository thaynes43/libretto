import { describe, expect, it } from 'vitest';
import type { Logger } from '../logger.js';
import {
  gbQueryTitle,
  gbAuthorsMatch,
  gbResolveTitleMatches,
  isDailyQuotaExhausted,
  parseGbError,
  GoogleBooksResolver,
  GoogleBooksUpstreamError,
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

// --- The 2026-07-20 observability + honesty fix: non-200s are never a silent no-match.

/** A daily-quota 429 body, carrying every signal Google emits for it (RESOURCE_EXHAUSTED + "Queries per day"). */
const QUOTA_BODY = {
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'books.googleapis.com'.",
    errors: [{ reason: 'dailyLimitExceeded', message: 'Daily Limit Exceeded' }],
    status: 'RESOURCE_EXHAUSTED',
  },
};

/** A fetch that always answers with `status`/`body`, counting the calls it actually served. */
function statusFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (async (): Promise<Response> => {
    n += 1;
    return new Response(JSON.stringify(body), { status, ...(headers ? { headers } : {}) });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

/** A logger that records every (level, obj, msg) entry, for asserting the status was actually logged. */
function captureLogger(): { log: Logger; entries: { level: string; obj: unknown; msg: string }[] } {
  const entries: { level: string; obj: unknown; msg: string }[] = [];
  const at =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      entries.push(
        typeof obj === 'string' ? { level, obj: {}, msg: obj } : { level, obj, msg: msg ?? '' },
      );
    };
  const log = {
    warn: at('warn'),
    error: at('error'),
    debug: at('debug'),
    info: at('info'),
  } as unknown as Logger;
  return { log, entries };
}

describe('parseGbError / isDailyQuotaExhausted', () => {
  it('extracts reason/message/status and flags a daily-quota body', () => {
    const info = parseGbError(JSON.stringify(QUOTA_BODY));
    expect(info.reason).toBe('dailyLimitExceeded');
    expect(info.gbStatus).toBe('RESOURCE_EXHAUSTED');
    expect(isDailyQuotaExhausted(info)).toBe(true);
  });
  it('does NOT flag a transient per-second rate-limit burst as daily exhaustion', () => {
    expect(isDailyQuotaExhausted({ reason: 'rateLimitExceeded' })).toBe(false);
    expect(isDailyQuotaExhausted({ reason: 'userRateLimitExceeded' })).toBe(false);
  });
  it('flags a legacy 403 dailyLimitExceeded and a bare RESOURCE_EXHAUSTED', () => {
    expect(isDailyQuotaExhausted({ reason: 'quotaExceeded' })).toBe(true);
    expect(isDailyQuotaExhausted({ gbStatus: 'RESOURCE_EXHAUSTED' })).toBe(true);
    expect(isDailyQuotaExhausted({ message: 'Queries per day limit reached' })).toBe(true);
  });
});

describe('GoogleBooksResolver non-200 honesty', () => {
  it('logs the HTTP status + Google reason and throws quota_exhausted on a daily-quota 429 (never a null no-match)', async () => {
    const { fetchImpl, calls } = statusFetch(429, QUOTA_BODY);
    const { log, entries } = captureLogger();
    const secretKey = 'SECRET-GB-KEY-abc123';
    const r = new GoogleBooksResolver({
      apiKey: secretKey,
      fetchImpl,
      log,
      sleepImpl: async () => {},
    });
    const err = await r
      .resolveVolume({ isbn: '9780316129084', title: 'Leviathan Wakes' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleBooksUpstreamError);
    expect((err as GoogleBooksUpstreamError).kind).toBe('quota_exhausted');
    expect((err as GoogleBooksUpstreamError).status).toBe(429);
    // The quota short-circuits immediately (no retry burned into a dead quota): exactly one request.
    expect(calls()).toBe(1);
    // Every non-200 is logged WITH the status, and the exhaustion gets its own clear error line.
    const nonOk = entries.find((e) => (e.obj as { status?: number }).status === 429);
    expect(nonOk).toBeDefined();
    expect(entries.some((e) => e.level === 'error' && /DAILY QUOTA/.test(e.msg))).toBe(true);
    // The API key is NEVER logged (not in the object, not in the query, not in a URL).
    expect(JSON.stringify(entries)).not.toContain(secretKey);
  });

  // #14 — the audio-ISBN robustness fix. A popular book's FIRST identifier is often an audiobook-edition
  // ISBN Google Books does not index (The Expanse's Nemesis Games 9781478903956, Leviathan Falls
  // 9781705024997); the reliable path for those is the guarded title fallback. The prior bug: a transient
  // 5xx on that ISBN leg THREW and skipped the title fallback, so a GB-title-indexed book stayed
  // permanently unresolved on any 503-weather pass. The ISBN leg is now best-effort + retry-free.
  it('falls THROUGH to the title fallback when the ISBN leg 503s (the audio-ISBN fix)', async () => {
    const isbnQ = 'isbn:9781478903956'; // a Macmillan-Audio ISBN GB can't answer
    const titleQ = 'intitle:Nemesis Games+inauthor:James S. A. Corey';
    let n = 0;
    const fetchImpl = (async (url: string | URL): Promise<Response> => {
      n += 1;
      const q = new URL(String(url)).searchParams.get('q') ?? '';
      if (q === isbnQ) return new Response(JSON.stringify({ error: { message: 'blip' } }), { status: 503 });
      if (q === titleQ)
        return new Response(
          JSON.stringify({ items: [vol('VOL_NG', 'Nemesis Games', ['James S. A. Corey'], '9780316334716')] }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl, sleepImpl: async () => {} });
    const out = await r.resolveVolume({
      isbn: '9781478903956',
      title: 'Nemesis Games',
      author: 'James S. A. Corey',
    });
    expect(out).toEqual({ volumeId: 'VOL_NG', isbn13: '9780316334716', via: 'title' });
    // ISBN leg tried ONCE (no retries burned on the doomed leg), then the title leg resolved: 2 calls total.
    expect(n).toBe(2);
  });

  it('surfaces upstream_error when BOTH the ISBN and title legs 503 (never a silent no-match)', async () => {
    const { fetchImpl, calls } = statusFetch(503, { error: { message: 'backend error' } });
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl, retries: 1, sleepImpl: async () => {} });
    const err = await r
      .resolveVolume({ isbn: '9780316129084', title: 'Leviathan Wakes' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleBooksUpstreamError);
    expect((err as GoogleBooksUpstreamError).kind).toBe('upstream_error');
    // ISBN leg: 1 call (retry-free). Title leg: 1 + 1 retry = 2. Total 3 — the fall-through happened.
    expect(calls()).toBe(3);
  });

  it('does NOT fall through to the title leg on a dead daily quota (the title leg would be dead too)', async () => {
    const { fetchImpl, calls } = statusFetch(429, QUOTA_BODY);
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl, sleepImpl: async () => {} });
    const err = await r
      .resolveVolume({ isbn: '9781478903956', title: 'Nemesis Games' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleBooksUpstreamError);
    expect((err as GoogleBooksUpstreamError).kind).toBe('quota_exhausted');
    // The ISBN leg latched the daily-quota breaker and re-threw — the title leg is never attempted.
    expect(calls()).toBe(1);
  });

  it('returns null for a legitimate 200 totalItems:0 — an honest no-match, distinct from an error', async () => {
    const { fetchImpl } = fakeFetch({}); // every query answers { items: [] }, status 200
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl });
    expect(
      await r.resolveVolume({ isbn: '9780316129084', title: 'No Such Book', author: 'Nobody' }),
    ).toBeNull();
  });

  it('latches the daily quota and short-circuits the REMAINING calls this pass with no further HTTP', async () => {
    const { fetchImpl, calls } = statusFetch(429, QUOTA_BODY);
    const { log, entries } = captureLogger();
    const r = new GoogleBooksResolver({ apiKey: 'k', fetchImpl, log, sleepImpl: async () => {} });
    // First call hits the quota (one request) and latches the breaker.
    await expect(r.resolveVolume({ isbn: '9780316129084', title: 'A' })).rejects.toBeInstanceOf(
      GoogleBooksUpstreamError,
    );
    expect(calls()).toBe(1);
    // Subsequent calls this pass short-circuit BEFORE any HTTP — no attempts burned into the dead quota.
    for (const title of ['B', 'C', 'D']) {
      const err = await r.resolveVolume({ isbn: '9780000000000', title }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoogleBooksUpstreamError);
      expect((err as GoogleBooksUpstreamError).kind).toBe('quota_exhausted');
    }
    expect(calls()).toBe(1); // still one — nothing else went to the network
    // And the clear exhaustion line is logged ONCE per window, not once per short-circuited call.
    expect(entries.filter((e) => e.level === 'error' && /DAILY QUOTA/.test(e.msg))).toHaveLength(1);
  });

  it('self-heals: the latch expires after the cooldown so the next pass re-probes', async () => {
    let call = 0;
    const fetchImpl = (async (): Promise<Response> => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify(QUOTA_BODY), { status: 429 });
      return new Response(
        JSON.stringify({
          items: [vol('VOL_HEAL', 'Leviathan Wakes', ['James S. A. Corey'], '9780316129084')],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    let now = 1_000_000;
    const r = new GoogleBooksResolver({
      apiKey: 'k',
      fetchImpl,
      sleepImpl: async () => {},
      nowImpl: () => now,
      quotaCooldownMs: 1000,
    });
    // Pass 1: quota exhausted, latched.
    await expect(
      r.resolveVolume({ isbn: '9780316129084', title: 'Leviathan Wakes' }),
    ).rejects.toBeInstanceOf(GoogleBooksUpstreamError);
    // Still within the cooldown → short-circuit, no HTTP.
    await expect(
      r.resolveVolume({ isbn: '9780316129084', title: 'Leviathan Wakes' }),
    ).rejects.toBeInstanceOf(GoogleBooksUpstreamError);
    expect(call).toBe(1);
    // Advance past the cooldown (the daily reset happened) → the next pass re-probes and resolves.
    now += 2000;
    const out = await r.resolveVolume({ isbn: '9780316129084', title: 'Leviathan Wakes' });
    expect(out).toEqual({ volumeId: 'VOL_HEAL', isbn13: '9780316129084', via: 'isbn' });
    expect(call).toBe(2);
  });
});
