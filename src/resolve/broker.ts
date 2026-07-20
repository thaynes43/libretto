import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { GoogleBooksResolver, GoogleBooksUpstreamError } from './google-books.js';

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

/**
 * Why the broker returned what it did — the additive HONESTY signal (the 2026-07-20 fix):
 *   - `resolved`         — a volume was found (`resolved` is non-null).
 *   - `no_match`         — Google Books honestly has no such volume (`200 totalItems:0` / guard reject).
 *   - `quota_exhausted`  — the daily Google Books quota is spent; this was NOT attempted honestly.
 *   - `upstream_error`   — a 5xx / non-quota non-200 / network failure past the retries.
 * `resolved` stays null for every non-`resolved` reason, so existing consumers (haynesnetwork's wants
 * pass reads `resolved:null` and self-heals hourly) are unaffected; the reason is purely additive.
 */
export type ResolveReason = 'resolved' | 'no_match' | 'quota_exhausted' | 'upstream_error';

export interface ResolveOutcome {
  /** The resolved volume, or null for EVERY failure reason (no_match / quota_exhausted / upstream_error). */
  resolved: ResolveResult | null;
  /** The honesty reason (additive; does not change the null-on-failure contract). */
  reason: ResolveReason;
}

export interface ResolveBroker {
  resolve(input: ResolveInput): Promise<ResolveOutcome>;
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

  async resolve(input: ResolveInput): Promise<ResolveOutcome> {
    const isbn = input.isbn ?? isbnFromIdentifiers(input.identifiers);
    const author = input.authors && input.authors.length > 0 ? input.authors.join(' ') : null;
    try {
      const vol = await this.resolver.resolveVolume({ isbn, title: input.title, author });
      if (vol) {
        this.log.debug(
          { title: input.title, volumeId: vol.volumeId, via: vol.via },
          'resolve broker: resolved to a Google-Books volume id',
        );
        return { resolved: vol, reason: 'resolved' };
      }
      // A genuine Google Books no-match (200 totalItems:0 / a guard reject) — honestly nothing to add.
      return { resolved: null, reason: 'no_match' };
    } catch (error) {
      // The broker is best-effort: a GB failure is an honest null (the caller falls back), never a throw —
      // but the reason distinguishes a dead quota / upstream error from a real no-match (the honesty fix).
      if (error instanceof GoogleBooksUpstreamError && error.kind === 'quota_exhausted') {
        this.log.debug(
          { title: input.title, status: error.status },
          'resolve broker: skipped — Google Books daily quota exhausted this pass (not a no-match)',
        );
        return { resolved: null, reason: 'quota_exhausted' };
      }
      this.log.warn(
        { title: input.title, err: error },
        'resolve broker: Google Books lookup failed (upstream error, not a no-match)',
      );
      return { resolved: null, reason: 'upstream_error' };
    }
  }
}

/** Build a broker over an explicit resolver (test seam; production wires it via createResolveBroker). */
export function brokerFromResolver(resolver: GoogleBooksResolver, log: Logger): ResolveBroker {
  return new GoogleBooksBroker(resolver, log);
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
    log,
  });
  if (!resolver.enabled) return undefined;
  log.info('resolve broker: Google Books configured; ISBN-first resolution armed for acquisition');
  return new GoogleBooksBroker(resolver, log);
}
