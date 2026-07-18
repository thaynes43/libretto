import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { GoogleBooksResolver } from './google-books.js';

/**
 * The resolve broker (M3 direction-a, PLAN-059): Libretto's reliable ISBN-first resolution of a wanted
 * book to a Google-Books volume id. It owns the logic Libretto-side so the acquisition leg no longer
 * leans on LazyLibrarian's throttled keyless Google Books search. Injected as a seam so the acquisition
 * planner and the /api/resolve endpoint stay testable offline (no live GB in CI).
 */
export interface ResolveInput {
  /** Normalized identifiers ("isbn:<13>", "asin:<10>") — the ISBN leg is preferred when present. */
  identifiers?: string[] | undefined;
  /** An explicit ISBN, if the caller has it outside the identifiers list. */
  isbn?: string | null | undefined;
  title: string;
  authors?: string[] | undefined;
}

export interface ResolveResult {
  /** The resolved Google-Books volume id — the LazyLibrarian addBook key. */
  volumeId: string;
  /** The resolved volume's ISBN-13 (or the anchor ISBN on an ISBN resolve). */
  isbn13: string | null;
  /** Which leg resolved it: the reliable ISBN key, or the guarded title fallback. */
  via: 'isbn' | 'title';
}

export interface ResolveBroker {
  resolve(input: ResolveInput): Promise<ResolveResult | null>;
}

/** Pull the first ISBN-13 out of an identifiers list ("isbn:9780316129084" -> "9780316129084"). */
export function isbnFromIdentifiers(identifiers: readonly string[] | undefined): string | null {
  const hit = identifiers?.find((id) => id.startsWith('isbn:'));
  return hit ? hit.slice('isbn:'.length) : null;
}

class GoogleBooksBroker implements ResolveBroker {
  constructor(
    private readonly resolver: GoogleBooksResolver,
    private readonly log: Logger,
  ) {}

  async resolve(input: ResolveInput): Promise<ResolveResult | null> {
    const isbn = input.isbn ?? isbnFromIdentifiers(input.identifiers);
    const author = input.authors && input.authors.length > 0 ? input.authors.join(' ') : null;
    try {
      const vol = await this.resolver.resolveVolume({ isbn, title: input.title, author });
      if (vol) {
        this.log.debug(
          { title: input.title, volumeId: vol.volumeId, via: vol.via },
          'resolve broker: resolved to a Google-Books volume id',
        );
      }
      return vol;
    } catch (error) {
      // The broker is best-effort: a GB failure is an honest null (the caller falls back), never a throw.
      this.log.warn(
        { title: input.title, err: error },
        'resolve broker: Google Books lookup failed',
      );
      return null;
    }
  }
}

/**
 * Wire the resolve broker from config. Returns undefined when GOOGLE_BOOKS_API_KEY is unset (against the
 * real GB API) — the acquisition leg then keeps its prior addBookByISBN behavior (no regression). A test
 * base URL enables the broker without a key so the resolver is drivable offline.
 */
export function createResolveBroker(config: AppConfig, log: Logger): ResolveBroker | undefined {
  const resolver = new GoogleBooksResolver({
    baseUrl: config.googleBooksUrl,
    apiKey: config.googleBooksApiKey,
  });
  if (!resolver.enabled) return undefined;
  log.info('resolve broker: Google Books configured; ISBN-first resolution armed for acquisition');
  return new GoogleBooksBroker(resolver, log);
}
