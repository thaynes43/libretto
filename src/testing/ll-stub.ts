import type { LazyLibrarianCommands, LlBook, LlFormat } from '../acquire/lazylibrarian.js';

/** One recorded LazyLibrarian write, for asserting the acquisition planner's call sequence. */
export interface LlCall {
  cmd: 'addBook' | 'addBookByISBN' | 'queueBook' | 'searchBook';
  id?: string;
  isbn?: string;
  format?: LlFormat;
}

/**
 * In-memory LazyLibrarian fake mirroring the real command shapes (getAllBooks + the four writes),
 * so the acquisition planner is tested offline. `getAllBooks` returns the seeded rows; the writes are
 * recorded in `calls`. `isbnResults` lets a test script addBookByISBN's ack per ISBN (default: a
 * success ack; set an entry to a "No results…" string to simulate LL's throttled Google Books lookup).
 */
export class FakeLazyLibrarian implements LazyLibrarianCommands {
  readonly calls: LlCall[] = [];
  isbnResults = new Map<string, string>();
  getAllBooksError: Error | undefined;

  constructor(private books: LlBook[] = []) {}

  seed(books: LlBook[]): void {
    this.books = books;
  }

  getAllBooks(): Promise<LlBook[]> {
    if (this.getAllBooksError) return Promise.reject(this.getAllBooksError);
    return Promise.resolve(this.books.map((book) => ({ ...book })));
  }

  addBook(id: string): Promise<string> {
    this.calls.push({ cmd: 'addBook', id });
    return Promise.resolve('true');
  }

  addBookByISBN(isbn: string): Promise<string> {
    this.calls.push({ cmd: 'addBookByISBN', isbn });
    return Promise.resolve(this.isbnResults.get(isbn) ?? 'added');
  }

  queueBook(id: string, format: LlFormat): Promise<string> {
    this.calls.push({ cmd: 'queueBook', id, format });
    return Promise.resolve('ok');
  }

  searchBook(id: string, format: LlFormat): Promise<string> {
    this.calls.push({ cmd: 'searchBook', id, format });
    return Promise.resolve('ok');
  }
}

/** Build an LlBook with sensible defaults for tests. */
export function llBook(partial: Partial<LlBook> & { bookId: string }): LlBook {
  return {
    title: '',
    isbn: null,
    ebookStatus: null,
    audioStatus: null,
    ...partial,
  };
}
