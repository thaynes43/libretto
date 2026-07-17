import { describe, expect, it } from 'vitest';
import { LazyLibrarianClient, LazyLibrarianError } from './lazylibrarian.js';

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
        Status: 'Open',
        AudioStatus: 'Skipped',
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
    });
    expect(books[1]!.bookId).toBe('42'); // numeric BookID stringified
    expect(books[1]!.isbn).toBeNull();
  });

  it('getAllBooks tolerates the { data: [...] } envelope', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: JSON.stringify({ data: [{ BookID: 'X', BookName: 'Y' }] }),
    }));
    const client = new LazyLibrarianClient(opts(fetchImpl));
    const books = await client.getAllBooks();
    expect(books).toEqual([
      { bookId: 'X', title: 'Y', isbn: null, ebookStatus: null, audioStatus: null },
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
