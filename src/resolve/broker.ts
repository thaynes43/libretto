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
  /**
   * The acquisition language check (issue #26): a volume it refuses is not a match. Absent ⇒ every language is
   * accepted (the `/api/resolve` service passes none).
   */
  acceptLanguage?: ((language: string | null) => boolean) | undefined;
}

export interface ResolveResult {
  /** The resolved Google-Books volume id — the LazyLibrarian addBook key. */
  volumeId: string;
  /** The resolved volume's ISBN-13 (or the anchor ISBN on an ISBN resolve). */
  isbn13: string | null;
  /** Which leg resolved it: the reliable ISBN key, or the guarded title fallback. */
  via: 'isbn' | 'title';
  /** The volume's language as Google Books reports it; absent when it names none. */
  language?: string;
}

/**
 * Why the broker returned what it did — the additive HONESTY signal (the 2026-07-20 fix):
 *   - `resolved`         — a volume was found (`resolved` is non-null).
 *   - `no_match`         — Google Books honestly has no such volume (`200 totalItems:0` / guard reject).
 *   - `quota_exhausted`  — the daily Google Books quota is spent; this was NOT attempted honestly.
 *   - `upstream_error`   — a 5xx / non-quota non-200 / network failure past the retries.
 *   - `wrong_language`   — the only volumes found are in a language `acceptLanguage` refuses (issue #26). Only a
 *                          caller that passes `acceptLanguage` (the acquisition leg) can see it.
 * `resolved` stays null for every non-`resolved` reason, so existing consumers (haynesnetwork's wants
 * pass reads `resolved:null` and self-heals hourly) are unaffected; the reason is purely additive.
 */
export type ResolveReason =
  'resolved' | 'no_match' | 'quota_exhausted' | 'upstream_error' | 'wrong_language';

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

/** Default no_match memory: 24 hours (owner ruling 2026-10-07, issue #34). */
export const DEFAULT_NO_MATCH_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard bound on remembered misses, so a caller feeding endless distinct wants cannot grow the map without limit. */
const MAX_NO_MATCH_ENTRIES = 5000;

export interface BrokerOptions {
  /** How long an honest `no_match` is remembered, ms. 0 disables the cache. Default 24h. */
  noMatchTtlMs?: number | undefined;
  /** Clock seam for tests. */
  nowImpl?: (() => number) | undefined;
}

/**
 * The cache key of a want: the same (isbn, title, author) the resolver queries with, folded so trivial spelling
 * differences (case, diacritics, punctuation, spacing) share one entry. Unlike `normalizeTitle` it keeps bracketed
 * text, because the resolver's volume guard reads "[09]" and "(Book 2)" and two volumes must never share a miss.
 */
function noMatchKey(isbn: string | null, title: string, author: string | null): string {
  const fold = (raw: string): string =>
    raw
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  return JSON.stringify([
    isbn ? isbn.replace(/[^0-9xX]/g, '').toUpperCase() : '',
    fold(title),
    author ? fold(author) : '',
  ]);
}

class GoogleBooksBroker implements ResolveBroker {
  /** key -> epoch ms the remembered miss expires. In-process only; a restart clears it. */
  private readonly noMatchUntil = new Map<string, number>();
  private cacheHits = 0;
  private readonly noMatchTtlMs: number;
  private readonly nowImpl: () => number;

  constructor(
    private readonly resolver: GoogleBooksResolver,
    private readonly log: Logger,
    options: BrokerOptions = {},
  ) {
    this.noMatchTtlMs = options.noMatchTtlMs ?? DEFAULT_NO_MATCH_TTL_MS;
    this.nowImpl = options.nowImpl ?? Date.now;
  }

  private rememberNoMatch(key: string): void {
    if (this.noMatchTtlMs <= 0) return;
    const now = this.nowImpl();
    // Prune on write: drop every expired entry, then the oldest if a flood of distinct wants still overfills it.
    for (const [k, until] of this.noMatchUntil) {
      if (until <= now) this.noMatchUntil.delete(k);
    }
    this.noMatchUntil.delete(key);
    this.noMatchUntil.set(key, now + this.noMatchTtlMs);
    while (this.noMatchUntil.size > MAX_NO_MATCH_ENTRIES) {
      const oldest = this.noMatchUntil.keys().next().value;
      if (oldest === undefined) break;
      this.noMatchUntil.delete(oldest);
    }
  }

  async resolve(input: ResolveInput): Promise<ResolveOutcome> {
    const isbn = input.isbn ?? isbnFromIdentifiers(input.identifiers);
    const author = input.authors && input.authors.length > 0 ? input.authors.join(' ') : null;
    const key = noMatchKey(isbn, input.title, author);
    if (this.noMatchTtlMs > 0) {
      const until = this.noMatchUntil.get(key);
      if (until !== undefined) {
        if (until > this.nowImpl()) {
          this.cacheHits += 1;
          // info, not debug: this line is how the quota saving is observed (zero Google Books requests were made).
          this.log.info(
            { title: input.title, cacheHits: this.cacheHits, cached: this.noMatchUntil.size },
            'resolve broker: no_match answered from cache (no Google Books request)',
          );
          return { resolved: null, reason: 'no_match' };
        }
        this.noMatchUntil.delete(key);
      }
    }
    try {
      const {
        volume: vol,
        refused,
        isbnLegFailed,
      } = await this.resolver.resolveVolumeDetail({
        isbn,
        title: input.title,
        author,
        ...(input.acceptLanguage ? { acceptLanguage: input.acceptLanguage } : {}),
      });
      if (vol) {
        this.log.debug(
          { title: input.title, volumeId: vol.volumeId, via: vol.via },
          'resolve broker: resolved to a Google-Books volume id',
        );
        return { resolved: vol, reason: 'resolved' };
      }
      // Only an edition in a refused language was found: nothing to add, and no ISBN fallback either.
      if (refused) return { resolved: null, reason: 'wrong_language' };
      // A genuine Google Books no-match (200 totalItems:0 / a guard reject) — honestly nothing to add. Only this
      // outcome is remembered, and not when the ISBN leg never answered (a transient failure is not a miss).
      if (!isbnLegFailed) this.rememberNoMatch(key);
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
export function brokerFromResolver(
  resolver: GoogleBooksResolver,
  log: Logger,
  options: BrokerOptions = {},
): ResolveBroker {
  return new GoogleBooksBroker(resolver, log, options);
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
  return new GoogleBooksBroker(resolver, log, { noMatchTtlMs: config.resolveNoMatchTtlMs });
}
