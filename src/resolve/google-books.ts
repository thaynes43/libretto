/**
 * ISBN-first Google Books resolver (the M3 resolve broker's engine).
 *
 * This is Libretto's OWN reliable ISBN -> Google-Books volume-id resolution, ported from the
 * haynesnetwork hardened resolver (packages/goodreads/src/google-books.ts, v0.70.1) so that the
 * acquisition leg no longer depends on LazyLibrarian's keyless, rate-throttled Google Books search
 * (`addBookByISBN`, which answers "No results" for most wants — the ~0 M3 resolution gap).
 *
 * The doctrine, verbatim from the donor resolver and the PLAN-059 pairing fix:
 *
 *   1. Try `isbn:<isbn>` FIRST — the most reliable key, exact, one call, immune to title fuzz.
 *   2. Fall back to `intitle:<title>+inauthor:<author>` ONLY when the ISBN leg misses (or there is
 *      no ISBN). The fuzzy leg is guarded so it can never resolve a WRONG work:
 *        - title-token COVERAGE guard (>= 60% of the queried title's distinctive tokens must be
 *          covered by the resolved volume's title), and
 *        - SURNAME author guard (a shared >=3-char name token) when both sides carry an author.
 *      A guard failure returns null (an honest gap), never a wrong-work volume id.
 *   3. Pre-colon fallback on a miss ("Dead Ever After: A Sookie Stackhouse Novel" -> "Dead Ever
 *      After") — colon subtitles are often edition dressing GB does not index under.
 *
 * The GB volume id it returns IS the LazyLibrarian addBook key (LL BookID is a GB volume id), so the
 * acquisition leg can drive `addBook(<volumeId>)` — the reliable ingestion path — instead of the
 * throttled `addBookByISBN`. The key is OPTIONAL: with no key against the real GB API, resolve returns
 * null and acquisition falls back to its prior addBookByISBN behavior (no regression).
 *
 * Observability + honesty (the 2026-07-20 quota-exhaustion fix): a non-200 from Google Books (429 daily
 * quota, 5xx backend bursts, 403) is NEVER conflated with a legitimate `200 totalItems:0` no-match. Every
 * non-200 is logged with its HTTP status and Google's error reason (never the API key/URL). A 429/5xx is a
 * RETRYABLE upstream error surfaced to the caller as {@link GoogleBooksUpstreamError}, distinct from a null
 * no-match. A daily-quota 429 (`RESOURCE_EXHAUSTED` / "Queries per day") additionally LATCHES a breaker-lite
 * cooldown on this resolver instance, so the remaining Google Books calls in the same pass short-circuit
 * without burning attempts into a dead quota; the latch self-heals after the cooldown so the next hourly
 * pass re-probes once the daily quota resets.
 */

import { pino } from 'pino';
import type { Logger } from '../logger.js';

/** Strip the TRAILING series parenthetical / bracket and LEADING file-title series prefixes for the
 * `intitle:` query — the file-derived titles Kavita/ABS expose ("Expanse 05 - Nemesis Games",
 * "Wheel of Time [09]: Winter's Heart") never index under the series prefix. Ported verbatim from the
 * donor `gbQueryTitle`; the coverage + author guards catch an over-strip, so a bad strip fails to null. */
export function gbQueryTitle(title: string): string {
  let stripped = title.replace(/\s*\([^()]*\)\s*$/, '').trim();
  stripped = stripped.replace(/\s*\[[^\][]*\]\s*$/, '').trim();
  stripped = stripped.replace(/^.*?(?:\[\d{1,3}\]|#\d{1,3})\s*[-–:]\s+(?=\S)/, '').trim();
  stripped = stripped.replace(/^.+?\s\d{1,3}\s*[-–]\s+(?=\S)/, '').trim();
  stripped = stripped.replace(/^\d{1,3}\s*[-–.]\s+(?=\S)/, '').trim();
  return stripped.length > 0 ? stripped : title;
}

/** Loose author agreement: the queried author and one resolved author must share a >=3-char token
 * ("Dean Koontz" vs "Simon Beckett" rejects; "C. Harris" vs "Charlaine Harris" accepts). */
export function gbAuthorsMatch(queryAuthor: string, resolvedAuthors: readonly string[]): boolean {
  const tokens = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3);
  const q = new Set(tokens(queryAuthor));
  if (q.size === 0) return true;
  return resolvedAuthors.some((a) => tokens(a).some((t) => q.has(t)));
}

const TITLE_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'by',
  'vol',
  'volume',
  'part',
  'book',
  'no',
  'edition',
]);

function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0 && !TITLE_STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/** Guard a TITLE-search resolve: the resolved volume's title must cover >= 60% of the queried
 * title's distinctive tokens, or the resolve is rejected as a different work. ISBN resolves skip this. */
export function gbResolveTitleMatches(
  queryTitle: string,
  resolvedTitle: string | undefined,
): boolean {
  if (!resolvedTitle) return false;
  const q = titleTokens(gbQueryTitle(queryTitle));
  if (q.length === 0) return true;
  const resolved = new Set(titleTokens(resolvedTitle));
  const covered = q.filter((t) => resolved.has(t)).length;
  return covered >= Math.max(1, Math.ceil(q.length * 0.6));
}

export interface GbResolveInput {
  isbn?: string | null;
  title: string;
  author?: string | null;
}

export interface GbVolume {
  /** The Google-Books volume id — the LazyLibrarian addBook key. */
  volumeId: string;
  /** The ISBN-13 GB reports for the resolved volume (or the anchor ISBN on an ISBN resolve). */
  isbn13: string | null;
  /** How the volume was resolved — surfaced in the run log / broker response for honesty. */
  via: 'isbn' | 'title';
}

interface Volume {
  id: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    industryIdentifiers?: { type?: string; identifier?: string }[];
  };
}

/** How a Google Books lookup failed upstream — distinct from a null no-match, surfaced for honesty. */
export type GbFailureKind = 'quota_exhausted' | 'upstream_error';

/**
 * A non-200 (or network/timeout) from Google Books that is NOT a legitimate no-match. Thrown by the
 * resolver so callers can tell "the daily quota is dead / the backend erred" apart from "GB honestly
 * has no such volume" (`200 totalItems:0` → null). `quota_exhausted` is the daily-quota latch trigger;
 * `upstream_error` is any other retryable/failed non-200 that persisted past the retries.
 */
export class GoogleBooksUpstreamError extends Error {
  constructor(
    readonly kind: GbFailureKind,
    /** The HTTP status (0 for a network/timeout failure with no response). */
    readonly status: number,
    /** Google's machine reason / status text, if any (never the API key). */
    readonly reason?: string,
  ) {
    super(`google books ${kind} (HTTP ${status}${reason ? `: ${reason}` : ''})`);
    this.name = 'GoogleBooksUpstreamError';
  }
}

interface GbErrorInfo {
  /** `error.errors[0].reason`, e.g. `dailyLimitExceeded` / `quotaExceeded` / `rateLimitExceeded`. */
  reason?: string;
  /** `error.message` — Google's human sentence (may name the reset, e.g. "Queries per day"). */
  message?: string;
  /** `error.status`, e.g. `RESOURCE_EXHAUSTED`. */
  gbStatus?: string;
}

/** Parse a Google Books error body ({ error: { message, status, errors:[{reason,message}] } }); best-effort. */
export function parseGbError(bodyText: string): GbErrorInfo {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: {
        message?: string;
        status?: string;
        errors?: { reason?: string; message?: string }[];
      };
    };
    const err = parsed.error;
    if (!err) return {};
    const info: GbErrorInfo = {};
    const reason = err.errors?.find((e) => e.reason)?.reason;
    if (reason) info.reason = reason;
    if (err.message) info.message = err.message;
    if (err.status) info.gbStatus = err.status;
    return info;
  } catch {
    return {};
  }
}

/**
 * Is this non-200 the DAILY quota being exhausted (the latch trigger), as opposed to a transient
 * per-second rate limit or a backend blip? Google signals daily exhaustion as reason
 * `dailyLimitExceeded`/`quotaExceeded`, status `RESOURCE_EXHAUSTED`, or a "Queries per day" message.
 * A `rateLimitExceeded`/`userRateLimitExceeded` burst is deliberately NOT treated as daily exhaustion
 * (it is transient — the retry/backoff handles it).
 */
export function isDailyQuotaExhausted(info: GbErrorInfo): boolean {
  const reason = (info.reason ?? '').toLowerCase();
  if (reason === 'dailylimitexceeded' || reason === 'quotaexceeded') return true;
  if ((info.gbStatus ?? '').toUpperCase() === 'RESOURCE_EXHAUSTED') return true;
  const message = (info.message ?? '').toLowerCase();
  return /quer(?:y|ies) per day|daily limit/.test(message);
}

export interface GoogleBooksResolverOptions {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  /** Per-attempt timeout (ms); default 15s. */
  timeoutMs?: number;
  /** Transient-failure retries (GB `backendFailed` bursts); default 2. */
  retries?: number;
  /** Base backoff (ms), grows linearly; default 400. */
  backoffMs?: number;
  /**
   * Breaker cooldown (ms) after a daily-quota 429: the remaining GB calls this window short-circuit
   * without a request. Default 15m — comfortably longer than one apply wave, shorter than the hourly
   * re-resolve so the next pass self-heals once Google's daily quota resets.
   */
  quotaCooldownMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable clock (ms since epoch) so the quota-latch window is testable. */
  nowImpl?: () => number;
  /** Where non-200 statuses and the quota-exhaustion line are logged (never the key/URL). */
  log?: Logger;
}

const DEFAULT_BASE_URL = 'https://www.googleapis.com/books/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 400;
const DEFAULT_QUOTA_COOLDOWN_MS = 15 * 60_000;
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SILENT_LOGGER: Logger = pino({ level: 'silent' });

/** ISBN-first Google Books resolver. `resolveVolume` returns null on no-key / no-match / guard-reject. */
export class GoogleBooksResolver {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly quotaCooldownMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly log: Logger;
  /** Epoch ms until which the daily quota is known-dead (breaker latch); 0 = not latched. */
  private quotaExhaustedUntil = 0;

  constructor(options: GoogleBooksResolverOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (options.apiKey) this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.quotaCooldownMs = options.quotaCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.nowImpl = options.nowImpl ?? Date.now;
    this.log = options.log ?? SILENT_LOGGER;
  }

  /** True while the daily-quota breaker is latched (remaining GB calls short-circuit this window). */
  private quotaLatched(): boolean {
    return this.quotaExhaustedUntil > this.nowImpl();
  }

  /** Latch the daily-quota breaker and log ONE clear line per exhaustion window (Google's reset hint if given). */
  private latchQuota(status: number, info: GbErrorInfo, retryAfterHeader: string | null): void {
    const now = this.nowImpl();
    const alreadyLatched = this.quotaExhaustedUntil > now;
    this.quotaExhaustedUntil = now + this.quotaCooldownMs;
    if (alreadyLatched) return;
    const retryAfterSeconds =
      retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
    this.log.error(
      {
        status,
        reason: info.reason ?? info.gbStatus,
        message: info.message,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        shortCircuitUntil: new Date(this.quotaExhaustedUntil).toISOString(),
      },
      'google books DAILY QUOTA exhausted — short-circuiting remaining Google Books calls this pass (self-heals after the daily reset)',
    );
  }

  /** True when this resolver can actually reach GB (a key is set, or a non-Google test base URL). */
  get enabled(): boolean {
    return Boolean(this.apiKey) || !this.baseUrl.startsWith('https://www.googleapis.com');
  }

  private async getJson(url: string, q: string, maxRetries = this.retries): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        if (attempt < maxRetries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        // Network/timeout past the retries: a retryable upstream failure, NOT a no-match — surface it.
        this.log.warn(
          { q, err: error },
          'google books request failed (network/timeout, retries exhausted)',
        );
        throw new GoogleBooksUpstreamError(
          'upstream_error',
          0,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        const info = parseGbError(await response.text().catch(() => ''));
        // Observability the incident lacked: log the status + Google's reason on EVERY non-200 (never the key/URL).
        this.log.warn(
          {
            status: response.status,
            ...(info.reason ? { reason: info.reason } : {}),
            ...(info.gbStatus ? { gbStatus: info.gbStatus } : {}),
            ...(info.message ? { message: info.message } : {}),
            q,
          },
          'google books non-200 response',
        );
        // A DAILY-quota 429/403: latch the breaker so the rest of this pass short-circuits, then surface.
        if (isDailyQuotaExhausted(info)) {
          this.latchQuota(response.status, info, response.headers.get('retry-after'));
          throw new GoogleBooksUpstreamError(
            'quota_exhausted',
            response.status,
            info.reason ?? info.gbStatus ?? info.message,
          );
        }
        // 429 burst / 5xx backend blips are transient — retry, then give up as a retryable upstream error.
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        // Any surviving non-200 is an upstream error, NEVER a legit `200 totalItems:0` no-match.
        throw new GoogleBooksUpstreamError(
          'upstream_error',
          response.status,
          info.reason ?? info.gbStatus ?? info.message,
        );
      }
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
  }

  private async query(q: string, maxRetries?: number): Promise<Volume[]> {
    const params = new URLSearchParams({ q, maxResults: '5', country: 'US' });
    if (this.apiKey) params.set('key', this.apiKey);
    const raw = await this.getJson(`${this.baseUrl}/volumes?${params.toString()}`, q, maxRetries);
    const items = (raw as { items?: unknown })?.items;
    return Array.isArray(items) ? (items as Volume[]) : [];
  }

  private static pickIsbn13(vol: Volume): string | null {
    const ids = vol.volumeInfo?.industryIdentifiers ?? [];
    return ids.find((i) => i.type === 'ISBN_13')?.identifier ?? null;
  }

  /**
   * Resolve to a GB volume id. `isbn:<isbn>` first, then a guarded `intitle:+inauthor:` fallback and a
   * pre-colon retry. Returns null with no key against the real GB API, or when nothing resolves / a
   * guard rejects the fuzzy leg — the caller keeps the want honestly un-added, never fabricates an id.
   */
  async resolveVolume(input: GbResolveInput): Promise<GbVolume | null> {
    if (!this.enabled) return null;
    if (this.quotaLatched()) {
      // Breaker-lite: the daily quota is known-dead this pass — short-circuit before spending a request.
      throw new GoogleBooksUpstreamError(
        'quota_exhausted',
        429,
        'daily quota latch (short-circuit; no request made)',
      );
    }
    if (input.isbn) {
      // The ISBN leg is BEST-EFFORT and cheap (no retries): a popular book's FIRST identifier is often an
      // audiobook-edition ISBN (e.g. The Expanse's "Nemesis Games" 9781478903956, "Leviathan Falls"
      // 9781705024997) that Google Books does not index, so this leg frequently misses — the reliable path
      // for those is the title fallback below. A transient 5xx/timeout on THIS leg must therefore NOT abort
      // the whole resolve (the prior bug: the throw skipped the title fallback, so a GB-title-indexed book
      // stayed permanently unresolved on any 503-weather pass). Fall through to the title fallback on any
      // ISBN-leg failure EXCEPT a dead daily quota (the title leg would be dead too — re-throw that).
      try {
        const [vol] = await this.query(`isbn:${input.isbn}`, 0);
        if (vol) {
          return {
            volumeId: vol.id,
            isbn13: GoogleBooksResolver.pickIsbn13(vol) ?? input.isbn,
            via: 'isbn',
          };
        }
      } catch (error) {
        if (error instanceof GoogleBooksUpstreamError && error.kind === 'quota_exhausted')
          throw error;
        this.log.debug(
          { isbn: input.isbn, err: error instanceof Error ? error.message : String(error) },
          'google books: ISBN leg failed transiently; falling through to the guarded title fallback',
        );
      }
    }
    const primary = await this.resolveByTitle(gbQueryTitle(input.title), input);
    if (primary) return primary;
    const preColon = input.title.split(':')[0]?.trim();
    if (preColon && preColon.length >= 3 && preColon !== input.title.trim()) {
      return this.resolveByTitle(gbQueryTitle(preColon), input);
    }
    return null;
  }

  private async resolveByTitle(
    queryTitle: string,
    input: GbResolveInput,
  ): Promise<GbVolume | null> {
    const authorPart = input.author ? `+inauthor:${input.author}` : '';
    const [vol] = await this.query(`intitle:${queryTitle}${authorPart}`);
    if (!vol) return null;
    const resolvedTitle = [vol.volumeInfo?.title, vol.volumeInfo?.subtitle]
      .filter(Boolean)
      .join(' ');
    if (!gbResolveTitleMatches(queryTitle, resolvedTitle || undefined)) return null;
    if (input.author && (vol.volumeInfo?.authors?.length ?? 0) > 0) {
      if (!gbAuthorsMatch(input.author, vol.volumeInfo?.authors ?? [])) return null;
    }
    return { volumeId: vol.id, isbn13: GoogleBooksResolver.pickIsbn13(vol), via: 'title' };
  }
}
