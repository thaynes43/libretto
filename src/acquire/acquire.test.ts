import { describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../builders/index.js';
import { silentLogger } from '../testing/fixtures.js';
import { FakeLazyLibrarian, llBook } from '../testing/ll-stub.js';
import { acquireMissing, type AcquireContext } from './acquire.js';
import { languagePolicy } from './language.js';

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

  describe('author credits guard the title fallback (thaynes43/haynesnetwork#771)', () => {
    // "Gray Dawn" is Walter Mosley's (Easy Rawlins #17); LazyLibrarian holds Stewart Edward White's "The Gray Dawn".
    const grayDawn = work({
      identifiers: ['isbn:9780316573238'],
      label: 'Gray Dawn (#17 in Easy Rawlins)',
      title: 'Gray Dawn',
      credits: ['Walter Mosley'],
    });

    it('never drives another author’s book that shares the title', async () => {
      const ll = new FakeLazyLibrarian([
        llBook({
          bookId: 'vkDiAAAAMAAJ',
          title: 'The Gray Dawn',
          author: 'Stewart Edward White',
          ebookStatus: 'Skipped',
        }),
      ]);
      const resolve = {
        resolve: vi.fn(() => Promise.resolve({ resolved: null, reason: 'no_match' as const })),
      };
      await acquireMissing('r', [grayDawn], 'ebook', ctxFor(ll, { resolve }), silentLogger);
      expect(ll.calls.filter((c) => c.cmd === 'queueBook' || c.cmd === 'searchBook')).toEqual([]);
      // Not in LazyLibrarian as Mosley's book, so it is resolved, and the resolve is told the author.
      expect(resolve.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Gray Dawn', authors: ['Walter Mosley'] }),
      );
    });

    it('still drives the member’s own book, and a book with no author is judged on its title', async () => {
      const ll = new FakeLazyLibrarian([
        llBook({
          bookId: 'MOSLEY',
          title: 'Gray Dawn',
          author: 'Walter Mosley',
          ebookStatus: 'Skipped',
        }),
        llBook({ bookId: 'ANON', title: 'Charcoal Joe', ebookStatus: 'Skipped' }),
      ]);
      const counts = await acquireMissing(
        'r',
        [
          grayDawn,
          work({ label: 'Charcoal Joe', title: 'Charcoal Joe', credits: ['Walter Mosley'] }),
        ],
        'ebook',
        ctxFor(ll),
        silentLogger,
      );
      expect(counts.queued).toBe(2);
      expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.id)).toEqual([
        'MOSLEY',
        'ANON',
      ]);
    });

    it('two LazyLibrarian rows under one title stay ambiguous, even when their authors agree', async () => {
      const ll = new FakeLazyLibrarian([
        llBook({
          bookId: 'A1',
          title: 'Gray Dawn',
          author: 'Walter Mosley',
          ebookStatus: 'Skipped',
        }),
        llBook({ bookId: 'B2', title: 'Gray Dawn', author: 'Walter Mosley', ebookStatus: 'Have' }),
      ]);
      await acquireMissing('r', [grayDawn], 'ebook', ctxFor(ll), silentLogger);
      expect(ll.calls.filter((c) => c.cmd === 'queueBook' || c.cmd === 'searchBook')).toEqual([]);
    });

    it('once the member’s own book is added beside another author’s, the title finds it (no re-add loop)', async () => {
      const ll = new FakeLazyLibrarian([
        llBook({
          bookId: 'vkDiAAAAMAAJ',
          title: 'The Gray Dawn',
          author: 'Stewart Edward White',
          ebookStatus: 'Open',
        }),
        // The row the first run added: no ISBN that matches a Hardcover edition.
        llBook({
          bookId: 'GkU_EQAAQBAJ',
          title: 'Gray Dawn',
          author: 'Walter Mosley',
          ebookStatus: 'Skipped',
        }),
      ]);
      const resolve = { resolve: vi.fn() };
      const counts = await acquireMissing(
        'r',
        [grayDawn],
        'ebook',
        ctxFor(ll, { resolve }),
        silentLogger,
      );
      expect(counts.queued).toBe(1);
      expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.id)).toEqual([
        'GkU_EQAAQBAJ',
      ]);
      expect(resolve.resolve).not.toHaveBeenCalled();
    });

    it('the resolve gets the first credit only (one inauthor: query)', async () => {
      const ll = new FakeLazyLibrarian([]);
      const resolve = {
        resolve: vi.fn(() => Promise.resolve({ resolved: null, reason: 'no_match' as const })),
      };
      await acquireMissing(
        'r',
        [
          work({
            label: 'Good Omens',
            title: 'Good Omens',
            credits: ['Terry Pratchett', 'Neil Gaiman'],
          }),
        ],
        'ebook',
        ctxFor(ll, { resolve }),
        silentLogger,
      );
      expect(resolve.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ authors: ['Terry Pratchett'] }),
      );
    });
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

describe('acquireMissing: language and held checks (issue #26)', () => {
  const english = languagePolicy(['en']);
  // "Troll Bridge": the Hardcover member carries the French edition's ISBN (2841721396 → 9782841721399).
  const trollBridge = work({
    label: 'Troll Bridge',
    title: 'Troll Bridge',
    identifiers: ['isbn:9782841721399'],
    authors: ['Terry Pratchett'],
  });
  const dramDeTroll = llBook({
    bookId: 'J_DajwEACAAJ',
    title: 'Drame de troll',
    isbn: '2841721396',
    author: 'Terry Pratchett',
    language: 'fr',
    ebookStatus: 'Skipped',
    audioStatus: 'Skipped',
  });

  it('never drives a row in a language not acquired, even on an exact ISBN hit', async () => {
    const ll = new FakeLazyLibrarian([dramDeTroll]);
    const counts = await acquireMissing(
      'discworld',
      [trollBridge],
      'ebook',
      ctxFor(ll, { languages: english }),
      silentLogger,
    );
    // The only ISBN names the French edition, and there is no broker: nothing to add either.
    expect(counts).toEqual({ queued: 0, added: 0, skipped: 1, errors: 0 });
    expect(ll.calls).toEqual([]);
  });

  it('drives the English row the title finds once the French ISBN hit is set aside', async () => {
    const ll = new FakeLazyLibrarian([
      dramDeTroll,
      llBook({
        bookId: 'EN1',
        title: 'Troll Bridge',
        author: 'Terry Pratchett',
        language: 'en',
        ebookStatus: 'Skipped',
      }),
    ]);
    const counts = await acquireMissing(
      'discworld',
      [trollBridge],
      'ebook',
      ctxFor(ll, { languages: english }),
      silentLogger,
    );
    expect(counts.queued).toBe(1);
    expect(ll.calls.map((c) => c.id)).toEqual(['EN1', 'EN1']);
  });

  it('sets a same-titled row in another language aside on the title fallback', async () => {
    const ll = new FakeLazyLibrarian([
      llBook({ bookId: 'DE1', title: 'Dune', language: 'de', ebookStatus: 'Skipped' }),
    ]);
    const counts = await acquireMissing(
      'r',
      [work({ label: 'Dune', title: 'Dune' })],
      'ebook',
      ctxFor(ll, { languages: english }),
      silentLogger,
    );
    expect(counts.skipped).toBe(1);
    expect(ll.calls).toEqual([]);
  });

  it('drives a row whose language is unknown, and one in an English spelling', async () => {
    const ll = new FakeLazyLibrarian([
      llBook({ bookId: 'U1', title: 'A', language: 'Unknown', ebookStatus: 'Skipped' }),
      llBook({ bookId: 'U2', title: 'B', language: null, ebookStatus: 'Skipped' }),
      llBook({ bookId: 'E1', title: 'C', language: 'en-GB', ebookStatus: 'Skipped' }),
    ]);
    const counts = await acquireMissing(
      'r',
      ['A', 'B', 'C'].map((title) => work({ label: title, title })),
      'ebook',
      ctxFor(ll, { languages: english }),
      silentLogger,
    );
    expect(counts.queued).toBe(3);
  });

  it('drives any language when no language policy is set', async () => {
    const ll = new FakeLazyLibrarian([dramDeTroll]);
    const counts = await acquireMissing('r', [trollBridge], 'ebook', ctxFor(ll), silentLogger);
    expect(counts.queued).toBe(1);
  });

  it('hands the broker the check and the identifiers without the other-language ISBN', async () => {
    const ll = new FakeLazyLibrarian([dramDeTroll]);
    const resolve = {
      resolve: vi.fn(() => Promise.resolve({ resolved: null, reason: 'no_match' as const })),
    };
    const member = { ...trollBridge, identifiers: ['isbn:9782841721399', 'isbn:9780552154185'] };
    await acquireMissing(
      'discworld',
      [member],
      'ebook',
      ctxFor(ll, { languages: english, resolve }),
      silentLogger,
    );
    expect(resolve.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        identifiers: ['isbn:9780552154185'],
        isbn: '9780552154185',
        acceptLanguage: expect.any(Function),
      }),
    );
    const [[input]] = resolve.resolve.mock.calls as unknown as [
      [{ acceptLanguage: (language: string | null) => boolean }],
    ];
    expect(input.acceptLanguage('fr')).toBe(false);
    expect(input.acceptLanguage('en')).toBe(true);
    // No match: the English ISBN falls back to addBookByISBN as before.
    expect(ll.calls).toEqual([{ cmd: 'addBookByISBN', isbn: '9780552154185' }]);
  });

  it('adds nothing when the broker finds only an edition in a language not acquired', async () => {
    const ll = new FakeLazyLibrarian([]);
    const resolve = {
      resolve: vi.fn(() => Promise.resolve({ resolved: null, reason: 'wrong_language' as const })),
    };
    const counts = await acquireMissing(
      'r',
      [work({ label: 'Dune', title: 'Dune', identifiers: ['isbn:9780441172719'] })],
      'ebook',
      ctxFor(ll, { languages: english, resolve }),
      silentLogger,
    );
    expect(counts).toEqual({ queued: 0, added: 0, skipped: 1, errors: 0 });
    expect(ll.calls).toEqual([]); // no addBookByISBN fallback
  });

  it('never re-queues a format LazyLibrarian holds a file for while its status reads Skipped', async () => {
    // "The Last Hero" (YqfWwAEACAAJ): Skipped in both formats, both imported 2026-07-21.
    const lastHero = llBook({
      bookId: 'YqfWwAEACAAJ',
      title: 'The Last Hero',
      isbn: '0060507772',
      language: 'en',
      ebookStatus: 'Skipped',
      audioStatus: 'Skipped',
      ebookLibrary: '2026-07-21T19:42:59Z',
      audioLibrary: '2026-07-21T11:03:00Z',
    });
    const member = work({
      label: 'The Last Hero',
      title: 'The Last Hero',
      identifiers: ['isbn:9780060507770'],
    });
    for (const format of ['ebook', 'audiobook'] as const) {
      const ll = new FakeLazyLibrarian([lastHero]);
      const counts = await acquireMissing(
        'discworld',
        [member],
        format,
        ctxFor(ll, { languages: english }),
        silentLogger,
      );
      expect(counts).toEqual({ queued: 0, added: 0, skipped: 1, errors: 0 });
      expect(ll.calls).toEqual([]);
    }
  });

  it('still drives the other format when only one is held', async () => {
    const ll = new FakeLazyLibrarian([
      llBook({
        bookId: 'B1',
        title: 'Dune',
        ebookStatus: 'Skipped',
        audioStatus: 'Skipped',
        ebookLibrary: '2026-07-21T19:42:59Z',
      }),
    ]);
    const counts = await acquireMissing(
      'r',
      [work({ label: 'Dune', title: 'Dune' })],
      'audiobook',
      ctxFor(ll),
      silentLogger,
    );
    expect(counts.queued).toBe(1);
    expect(ll.calls.map((c) => c.format)).toEqual(['audiobook', 'audiobook']);
  });
});
