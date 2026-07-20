import { describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../builders/index.js';
import { silentLogger } from '../testing/fixtures.js';
import { FakeLazyLibrarian, llBook } from '../testing/ll-stub.js';
import { acquireMissing, type AcquireContext } from './acquire.js';

const ctxFor = (
  client: FakeLazyLibrarian,
  overrides: Partial<AcquireContext> = {},
): AcquireContext => ({
  client,
  capPerRun: 10,
  intervalMs: 0,
  sleep: () => Promise.resolve(),
  ...overrides,
});

const work = (partial: Partial<WorkItem> & { label: string }): WorkItem => ({
  identifiers: [],
  ...partial,
});

describe('acquireMissing', () => {
  it('queues + searches an existing Skipped book (eBook for a Kavita recipe)', async () => {
    const ll = new FakeLazyLibrarian([
      llBook({ bookId: 'B1', title: 'Dune', isbn: '9780441172719', ebookStatus: 'Skipped' }),
    ]);
    const counts = await acquireMissing(
      'r',
      [work({ identifiers: ['isbn:9780441172719'], label: 'Dune', title: 'Dune' })],
      'ebook',
      ctxFor(ll),
      silentLogger,
    );
    expect(counts).toEqual({ queued: 1, added: 0, skipped: 0, errors: 0 });
    expect(ll.calls).toEqual([
      { cmd: 'queueBook', id: 'B1', format: 'ebook' },
      { cmd: 'searchBook', id: 'B1', format: 'ebook' },
    ]);
  });

  it('drives the AudioBook status for an ABS recipe (per-format)', async () => {
    const ll = new FakeLazyLibrarian([
      // eBook is Open (held), but the AudioBook is Skipped — an ABS recipe drives audio only.
      llBook({
        bookId: 'B1',
        title: 'Dune',
        isbn: '9780441172719',
        ebookStatus: 'Open',
        audioStatus: 'Skipped',
      }),
    ]);
    const counts = await acquireMissing(
      'r',
      [work({ identifiers: ['isbn:9780441172719'], label: 'Dune', title: 'Dune' })],
      'audiobook',
      ctxFor(ll),
      silentLogger,
    );
    expect(counts.queued).toBe(1);
    expect(ll.calls.map((c) => c.format)).toEqual(['audiobook', 'audiobook']);
  });

  it('skips a book already Wanted/Snatched/Have/Matched/Ignored/Open (idempotent re-run)', async () => {
    const statuses = ['Wanted', 'Snatched', 'Have', 'Matched', 'Ignored', 'Open'];
    const ll = new FakeLazyLibrarian(
      statuses.map((s, i) =>
        llBook({ bookId: `B${i}`, title: `T${i}`, isbn: `isbn${i}`, ebookStatus: s }),
      ),
    );
    const works = statuses.map((_, i) =>
      work({ identifiers: [`isbn:isbn${i}`], label: `T${i}`, title: `T${i}` }),
    );
    // Match on title (the fake isbns aren't valid ISBNs, so identifiers won't normalize to isbn: keys).
    const counts = await acquireMissing('r', works, 'ebook', ctxFor(ll), silentLogger);
    expect(counts).toEqual({ queued: 0, added: 0, skipped: 6, errors: 0 });
    expect(ll.calls).toEqual([]);
  });

  it('adds by ISBN when the work is not in LazyLibrarian', async () => {
    const ll = new FakeLazyLibrarian([]);
    const counts = await acquireMissing(
      'r',
      [work({ identifiers: ['isbn:9780441172719'], label: 'Dune', title: 'Dune' })],
      'ebook',
      ctxFor(ll),
      silentLogger,
    );
    expect(counts).toEqual({ queued: 0, added: 1, skipped: 0, errors: 0 });
    expect(ll.calls).toEqual([{ cmd: 'addBookByISBN', isbn: '9780441172719' }]);
  });

  it('treats a "No results" add ack as a soft skip, not an add (Google Books throttled)', async () => {
    const ll = new FakeLazyLibrarian([]);
    ll.isbnResults.set('9780441172719', 'No results for 9780441172719');
    const counts = await acquireMissing(
      'r',
      [work({ identifiers: ['isbn:9780441172719'], label: 'Dune', title: 'Dune' })],
      'ebook',
      ctxFor(ll),
      silentLogger,
    );
    expect(counts).toEqual({ queued: 0, added: 0, skipped: 1, errors: 0 });
  });

  it('skips an unknown work with no ISBN (ASIN-only) — findBook is unavailable', async () => {
    const ll = new FakeLazyLibrarian([]);
    const counts = await acquireMissing(
      'r',
      [work({ identifiers: ['asin:B0071IHYRW'], label: 'Audio Only', title: 'Audio Only' })],
      'audiobook',
      ctxFor(ll),
      silentLogger,
    );
    expect(counts).toEqual({ queued: 0, added: 0, skipped: 1, errors: 0 });
    expect(ll.calls).toEqual([]);
  });

  it('resolves by conservative title when the identifier misses', async () => {
    const ll = new FakeLazyLibrarian([
      llBook({ bookId: 'B1', title: 'Project Hail Mary', isbn: null, ebookStatus: 'Skipped' }),
    ]);
    const counts = await acquireMissing(
      'r',
      // Hardcover ISBN the LL row lacks -> identifier miss -> title fallback resolves it.
      [
        work({
          identifiers: ['isbn:9780593135204'],
          label: 'Project Hail Mary',
          title: 'Project Hail Mary',
        }),
      ],
      'ebook',
      ctxFor(ll),
      silentLogger,
    );
    expect(counts.queued).toBe(1);
    expect(ll.calls[0]).toEqual({ cmd: 'queueBook', id: 'B1', format: 'ebook' });
  });

  it('refuses an ambiguous title (two LL books same name) — never a wrong add', async () => {
    const ll = new FakeLazyLibrarian([
      llBook({ bookId: 'B1', title: 'The Gathering', ebookStatus: 'Skipped' }),
      llBook({ bookId: 'B2', title: 'The Gathering', ebookStatus: 'Skipped' }),
    ]);
    const counts = await acquireMissing(
      'r',
      [work({ identifiers: [], label: 'The Gathering', title: 'The Gathering' })],
      'ebook',
      ctxFor(ll),
      silentLogger,
    );
    // No isbn, title ambiguous -> unresolved -> skipped (no add of the wrong book).
    expect(counts).toEqual({ queued: 0, added: 0, skipped: 1, errors: 0 });
    expect(ll.calls).toEqual([]);
  });

  it('enforces the per-run cap, deferring the rest (only cap actions fire)', async () => {
    const ll = new FakeLazyLibrarian([]);
    const works = [1, 2, 3, 4, 5].map((n) =>
      work({ identifiers: [`isbn:978044117271${n}`], label: `B${n}`, title: `B${n}` }),
    );
    const counts = await acquireMissing(
      'r',
      works,
      'ebook',
      ctxFor(ll, { capPerRun: 2 }),
      silentLogger,
    );
    expect(counts.added).toBe(2);
    expect(counts.skipped).toBe(3); // deferred
    expect(ll.calls.filter((c) => c.cmd === 'addBookByISBN')).toHaveLength(2);
  });

  it('paces LL writes: sleeps intervalMs between actions but not before the first', async () => {
    const ll = new FakeLazyLibrarian([]);
    const sleep = vi.fn(() => Promise.resolve());
    const works = [1, 2, 3].map((n) =>
      work({ identifiers: [`isbn:978044117271${n}`], label: `B${n}`, title: `B${n}` }),
    );
    await acquireMissing('r', works, 'ebook', ctxFor(ll, { intervalMs: 500, sleep }), silentLogger);
    expect(sleep).toHaveBeenCalledTimes(2); // 3 actions -> 2 gaps
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('captures a getAllBooks failure as one error and does not throw', async () => {
    const ll = new FakeLazyLibrarian([]);
    ll.getAllBooksError = new Error('LL down');
    const counts = await acquireMissing(
      'r',
      [work({ identifiers: ['isbn:9780441172719'], label: 'Dune', title: 'Dune' })],
      'ebook',
      ctxFor(ll),
      silentLogger,
    );
    expect(counts).toEqual({ queued: 0, added: 0, skipped: 0, errors: 1 });
  });

  it('is a no-op with empty missing[] (no LL call at all)', async () => {
    const ll = new FakeLazyLibrarian([]);
    const getAll = vi.spyOn(ll, 'getAllBooks');
    const counts = await acquireMissing('r', [], 'ebook', ctxFor(ll), silentLogger);
    expect(counts).toEqual({ queued: 0, added: 0, skipped: 0, errors: 0 });
    expect(getAll).not.toHaveBeenCalled();
  });

  describe('with the resolve broker (M3 direction-a)', () => {
    it('resolves ISBN -> volume id and adds via addBook, NOT addBookByISBN', async () => {
      const ll = new FakeLazyLibrarian([]);
      const resolve = {
        resolve: vi.fn(() =>
          Promise.resolve({
            resolved: { volumeId: 'VOL_DUNE', isbn13: '9780441172719', via: 'isbn' as const },
            reason: 'resolved' as const,
          }),
        ),
      };
      const counts = await acquireMissing(
        'r',
        [work({ identifiers: ['isbn:9780441172719'], label: 'Dune', title: 'Dune' })],
        'ebook',
        ctxFor(ll, { resolve }),
        silentLogger,
      );
      expect(counts).toEqual({ queued: 0, added: 1, skipped: 0, errors: 0 });
      expect(ll.calls).toEqual([{ cmd: 'addBook', id: 'VOL_DUNE' }]);
      expect(resolve.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ isbn: '9780441172719', title: 'Dune' }),
      );
    });

    it('adds an ASIN-only want the broker resolves by title (was an honest skip before)', async () => {
      const ll = new FakeLazyLibrarian([]);
      const resolve = {
        resolve: vi.fn(() =>
          Promise.resolve({
            resolved: { volumeId: 'VOL_AO', isbn13: null, via: 'title' as const },
            reason: 'resolved' as const,
          }),
        ),
      };
      const counts = await acquireMissing(
        'r',
        [work({ identifiers: ['asin:B0071IHYRW'], label: 'Audio Only', title: 'Audio Only' })],
        'audiobook',
        ctxFor(ll, { resolve }),
        silentLogger,
      );
      expect(counts.added).toBe(1);
      expect(ll.calls).toEqual([{ cmd: 'addBook', id: 'VOL_AO' }]);
    });

    it('falls back to addBookByISBN when the broker resolves nothing but an ISBN exists', async () => {
      const ll = new FakeLazyLibrarian([]);
      const resolve = {
        resolve: vi.fn(() => Promise.resolve({ resolved: null, reason: 'no_match' as const })),
      };
      const counts = await acquireMissing(
        'r',
        [work({ identifiers: ['isbn:9780441172719'], label: 'Dune', title: 'Dune' })],
        'ebook',
        ctxFor(ll, { resolve }),
        silentLogger,
      );
      expect(counts.added).toBe(1);
      expect(ll.calls).toEqual([{ cmd: 'addBookByISBN', isbn: '9780441172719' }]);
    });

    it('skips (no LL write) when the broker resolves nothing and there is no ISBN', async () => {
      const ll = new FakeLazyLibrarian([]);
      const resolve = {
        resolve: vi.fn(() => Promise.resolve({ resolved: null, reason: 'no_match' as const })),
      };
      const counts = await acquireMissing(
        'r',
        [work({ identifiers: ['asin:B0071IHYRW'], label: 'Audio Only', title: 'Audio Only' })],
        'audiobook',
        ctxFor(ll, { resolve }),
        silentLogger,
      );
      expect(counts.skipped).toBe(1);
      expect(ll.calls).toEqual([]);
    });
  });
});
