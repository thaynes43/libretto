import { describe, expect, it } from 'vitest';
import {
  LazyLibrarianClient,
  LazyLibrarianError,
  llFormatHeld,
  type LlBook,
} from './lazylibrarian.js';

/** A fetch stub that records the URLs it was called with and returns a scripted body. */
function stubFetch(handler: (url: string) => { status?: number; body: string }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const { status = 200, body } = handler(url);
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const opts = (fetchImpl: typeof fetch) => ({
  url: 'http://ll.local:5299',
  apiKey: 'secret-key',
  fetchImpl,
});

describe('LazyLibrarianClient', () => {
  it('builds the query-string command API with cmd + apikey + params', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: 'ok' }));
    const client = new LazyLibrarianClient(opts(fetchImpl));
    await client.queueBook('VOL123', 'ebook');
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe('/api');
    expect(url.searchParams.get('cmd')).toBe('queueBook');
    expect(url.searchParams.get('apikey')).toBe('secret-key');
    expect(url.searchParams.get('id')).toBe('VOL123');
    expect(url.searchParams.get('type')).toBe('eBook');
  });

  it('maps audiobook to the AudioBook DLTYPE on queue and search', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: 'ok' }));
    const client = new LazyLibrarianClient(opts(fetchImpl));
    await client.queueBook('V', 'audiobook');
    await client.searchBook('V', 'audiobook');
    expect(new URL(calls[0]!).searchParams.get('type')).toBe('AudioBook');
    expect(new URL(calls[1]!).searchParams.get('cmd')).toBe('searchBook');
    expect(new URL(calls[1]!).searchParams.get('type')).toBe('AudioBook');
  });

  it('addBookByISBN sends the isbn param and returns the raw ack (soft failure is not an error)', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: 'No results for 9780593135204<br>' }));
    const client = new LazyLibrarianClient(opts(fetchImpl));
    const ack = await client.addBookByISBN('9780593135204');
    expect(new URL(calls[0]!).searchParams.get('cmd')).toBe('addBookByISBN');
    expect(new URL(calls[0]!).searchParams.get('isbn')).toBe('9780593135204');
    expect(ack).toContain('No results');
  });

  it('getAllBooks parses a bare array into LlBook rows keyed by BookID', async () => {
    const rows = [
      {
        BookID: 'Lp0szgEACAAJ',
        BookName: 'Matilda',
        BookIsbn: '024155831X',
        BookLang: 'en',
        Status: 'Open',
        AudioStatus: 'Skipped',
        BookLibrary: '2026-07-21T19:42:59Z',
        AudioLibrary: null,
      },
      { BookID: 42, BookName: 'Numeric Id', BookIsbn: null, Status: 'Wanted', AudioStatus: null },
      { BookName: 'no id — dropped' },
    ];
    const { fetchImpl } = stubFetch(() => ({ body: JSON.stringify(rows) }));
    const client = new LazyLibrarianClient(opts(fetchImpl));
    const books = await client.getAllBooks();
    expect(books).toHaveLength(2); // the id-less row is dropped
    expect(books[0]).toEqual({
      bookId: 'Lp0szgEACAAJ',
      title: 'Matilda',
      isbn: '024155831X',
      ebookStatus: 'Open',
      audioStatus: 'Skipped',
      language: 'en',
      ebookLibrary: '2026-07-21T19:42:59Z',
      audioLibrary: null,
      ebookFile: null,
      audioFile: null,
    });
    expect(books[1]!.bookId).toBe('42'); // numeric BookID stringified
    expect(books[1]!.isbn).toBeNull();
  });

  it('getAllBooks carries the AuthorName LazyLibrarian joins in (thaynes43/haynesnetwork#771)', async () => {
    const rows = [
      { BookID: 'vkDiAAAAMAAJ', BookName: 'The Gray Dawn', AuthorName: 'Stewart Edward White' },
      { BookID: 'X', BookName: 'Y', AuthorName: '  ' },
    ];
    const { fetchImpl } = stubFetch(() => ({ body: JSON.stringify(rows) }));
    const books = await new LazyLibrarianClient(opts(fetchImpl)).getAllBooks();
    expect(books[0]!.author).toBe('Stewart Edward White');
    expect(books[1]).not.toHaveProperty('author');
  });

  it('getAllBooks tolerates the { data: [...] } envelope', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: JSON.stringify({ data: [{ BookID: 'X', BookName: 'Y' }] }),
    }));
    const client = new LazyLibrarianClient(opts(fetchImpl));
    const books = await client.getAllBooks();
    expect(books).toEqual([
      {
        bookId: 'X',
        title: 'Y',
        isbn: null,
        ebookStatus: null,
        audioStatus: null,
        language: null,
        ebookLibrary: null,
        audioLibrary: null,
        ebookFile: null,
        audioFile: null,
      },
    ]);
  });

  it('getAllBooks returns [] for a plain-text error body (Unknown command)', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: 'Unknown command: getAllBooks' }));
    const client = new LazyLibrarianClient(opts(fetchImpl));
    expect(await client.getAllBooks()).toEqual([]);
  });

  it('throws LazyLibrarianError with a REDACTED url on a non-2xx response', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 500, body: 'boom' }));
    const client = new LazyLibrarianClient(opts(fetchImpl));
    await expect(client.addBook('V')).rejects.toBeInstanceOf(LazyLibrarianError);
    await expect(client.addBook('V')).rejects.toThrow(/apikey=REDACTED/);
    await expect(client.addBook('V')).rejects.not.toThrow(/secret-key/);
  });
});

describe('llFormatHeld (issue #26)', () => {
  const row = (partial: Partial<LlBook>): LlBook => ({
    bookId: 'B',
    title: 'T',
    isbn: null,
    ebookStatus: 'Skipped',
    audioStatus: 'Skipped',
    ...partial,
  });

  it('reads Open and Have as held, whatever the case', () => {
    expect(llFormatHeld(row({ ebookStatus: 'Open' }), 'ebook')).toBe(true);
    expect(llFormatHeld(row({ audioStatus: 'have' }), 'audiobook')).toBe(true);
    expect(llFormatHeld(row({ ebookStatus: 'Wanted' }), 'ebook')).toBe(false);
  });

  it('reads an import date or a file as held although the status says Skipped (The Last Hero)', () => {
    const lastHero = row({ ebookLibrary: '2026-07-21T19:42:59Z', audioFile: '/books/x.m4b' });
    expect(llFormatHeld(lastHero, 'ebook')).toBe(true);
    expect(llFormatHeld(lastHero, 'audiobook')).toBe(true);
  });

  it('keeps the formats apart and ignores blank or None values', () => {
    expect(llFormatHeld(row({ audioLibrary: '2026-07-21T11:03:00Z' }), 'ebook')).toBe(false);
    expect(llFormatHeld(row({ ebookLibrary: ' ', ebookFile: 'None' }), 'ebook')).toBe(false);
    expect(llFormatHeld(row({ ebookLibrary: null, ebookFile: null }), 'ebook')).toBe(false);
  });
});
