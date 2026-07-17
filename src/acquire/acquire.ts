import type { WorkItem } from '../builders/index.js';
import type { AppConfig } from '../config.js';
import { normalizeIdentifier } from '../identifiers.js';
import type { Logger } from '../logger.js';
import { TitleIndex } from '../matching/title.js';
import {
  createLazyLibrarianClient,
  type LazyLibrarianCommands,
  type LlBook,
  type LlFormat,
} from './lazylibrarian.js';

/**
 * The acquisition leg (DESIGN-037 M3): turn a recipe's `missing[]` into LazyLibrarian wants so the *arr
 * stack acquires them. This runs ONLY when a recipe carries `variables.acquisitionEnabled: true` and LL
 * is configured — the reconciler owns that gate. Libretto stays fully STATELESS: LazyLibrarian is the
 * acquisition ledger, so idempotency is recovered from LL every run (one `getAllBooks` call), never a
 * local table.
 *
 * The mechanism (verified against the real LL, build 40a389ea, 2026-07-17 — see lazylibrarian.ts):
 *
 *   1. Fetch `getAllBooks` ONCE per run → the idempotency map (by normalized ISBN and by title) AND the
 *      BookID source. This is the proven-cheap pattern (the deployed LL has no per-book status read).
 *   2. For each missing work, resolve it to an LL book — conservatively, exactly like the D-04 title
 *      fallback: normalized ISBN first, then noise-stripped title (+ author guard); AMBIGUITY IS SKIPPED,
 *      never a wrong add.
 *      - Already in LL and the wanted FORMAT is Wanted/Snatched/Open/Have/Matched/Ignored → SKIP (LL is
 *        already acquiring or holds it; re-runs never duplicate).
 *      - Already in LL but the FORMAT is Skipped or untracked → `queueBook` + `searchBook` for that
 *        format (the reliable, Google-Books-free drive). Kavita recipes acquire eBooks; ABS recipes
 *        acquire AudioBooks.
 *      - NOT in LL and the work has an ISBN → `addBookByISBN` (best-effort: LL resolves it on its own GB
 *        budget; a "No results" answer is a soft skip, retried next run once LL knows the book, at which
 *        point the Skipped-drive path above queues+searches it). No ISBN (ASIN-only) → skip with a reason
 *        (findBook is unusable in this deployment; Libretto must not add Google Books access).
 *
 * PACING (hard requirement): a per-run cap on acquisition ACTIONS (env LIBRETTO_ACQUISITION_CAP_PER_RUN)
 * and estate-wide politeness — LL write calls are spaced `intervalMs` apart. Resolution-only skips
 * (already handled, no ISBN) do NOT consume the cap; only real LL writes do.
 */

/** Per-recipe acquisition tallies, reported alongside the reconcile counts. */
export interface AcquisitionCounts {
  /** Works for which a format was queued + searched this run (an existing LL book driven to a hunt). */
  queued: number;
  /** Works newly added to LL by ISBN this run (pending queue+search on a later run once LL assigns an id). */
  added: number;
  /** Works intentionally not acted on: already being acquired/held, no ISBN, LL could not resolve, or capped. */
  skipped: number;
  /** Works whose LL call threw (network/HTTP). Best-effort — never fails the reconcile. */
  errors: number;
}

export interface AcquireContext {
  client: LazyLibrarianCommands;
  /** Max acquisition ACTIONS (queue-drives + adds) per run. */
  capPerRun: number;
  /** Spacing between LL write calls (estate politeness). */
  intervalMs: number;
  /** Injectable sleep so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * LL per-format statuses that mean "already being acquired or already held" — never re-drive these.
 * `skipped` (and an untracked/empty status) is the ONLY state we drive. This mirrors the haynesnetwork
 * Skipped-want sweep: `Ignored` is an owner ruling and `Matched` means LL thinks it holds a file —
 * neither may be re-queued.
 */
const HANDLED_STATUSES = new Set(['wanted', 'snatched', 'open', 'have', 'matched', 'ignored']);

/**
 * Wire the acquisition context from config: the LazyLibrarian client plus the pacing knobs. Returns
 * undefined when LAZYLIBRARIAN_URL / LAZYLIBRARIAN_API_KEY are unset — acquisition then no-ops even for
 * a recipe with acquisitionEnabled (the reconciler logs the gap), validated at use, not at boot.
 */
export function createAcquireContext(config: AppConfig, log: Logger): AcquireContext | undefined {
  const client = createLazyLibrarianClient(config.lazyLibrarian);
  if (!client) return undefined;
  log.info(
    { capPerRun: config.acquisitionCapPerRun, intervalMs: config.acquisitionIntervalMs },
    'acquisition: LazyLibrarian configured; acquisition leg armed for recipes with acquisitionEnabled',
  );
  return {
    client,
    capPerRun: config.acquisitionCapPerRun,
    intervalMs: config.acquisitionIntervalMs,
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function normalizedStatus(book: LlBook, format: LlFormat): string {
  const raw = format === 'audiobook' ? book.audioStatus : book.ebookStatus;
  return (raw ?? '').trim().toLowerCase();
}

/**
 * Drive acquisition for a recipe's missing works. Returns tallies; logs one line per work with a reason.
 * Never throws — a getAllBooks failure or per-work LL error is captured in `errors` and the run proceeds.
 */
export async function acquireMissing(
  recipeId: string,
  missing: WorkItem[],
  format: LlFormat,
  ctx: AcquireContext,
  log: Logger,
): Promise<AcquisitionCounts> {
  const counts: AcquisitionCounts = { queued: 0, added: 0, skipped: 0, errors: 0 };
  if (missing.length === 0) return counts;

  let books: LlBook[];
  try {
    books = await ctx.client.getAllBooks();
  } catch (error) {
    // The whole run's acquisition is a no-op this time; the reconcile itself already succeeded.
    log.error(
      { recipeId, err: error },
      'acquisition: getAllBooks failed; skipping acquisition this run',
    );
    counts.errors = 1;
    return counts;
  }

  // Idempotency + BookID maps (built once). ISBN is exact; title is the conservative D-04 fallback.
  const byIsbn = new Map<string, LlBook>();
  for (const book of books) {
    if (!book.isbn) continue;
    const key = normalizeIdentifier(book.isbn);
    if (!byIsbn.has(key)) byIsbn.set(key, book);
  }
  const byId = new Map(books.map((book) => [book.bookId, book] as const));
  const titleIndex = new TitleIndex(books.map((book) => ({ id: book.bookId, title: book.title })));
  const claimed = new Set<string>();

  const sleep = ctx.sleep ?? defaultSleep;
  let actions = 0;
  let acted = false;

  for (const work of missing) {
    // Resolve the missing work to an LL book: identifier-exact first, then conservative title fallback.
    let book: LlBook | undefined;
    for (const identifier of work.identifiers) {
      const hit = byIsbn.get(identifier);
      if (hit) {
        book = hit;
        break;
      }
    }
    if (!book) {
      const candidate = titleIndex.match(work.title, work.authors, claimed);
      if (candidate) book = byId.get(candidate.id);
    }

    // Decide the action WITHOUT consuming the cap, so resolution-only skips stay free.
    let action: { kind: 'drive'; book: LlBook } | { kind: 'add'; isbn: string } | undefined;
    if (book) {
      claimed.add(book.bookId);
      const status = normalizedStatus(book, format);
      if (status !== '' && HANDLED_STATUSES.has(status)) {
        counts.skipped += 1;
        log.info(
          { recipeId, work: work.label, bookId: book.bookId, format, status },
          'acquisition: already being acquired or held; skipping',
        );
        continue;
      }
      action = { kind: 'drive', book };
    } else {
      const isbnKey = work.identifiers.find((id) => id.startsWith('isbn:'));
      if (!isbnKey) {
        counts.skipped += 1;
        log.info(
          { recipeId, work: work.label, identifiers: work.identifiers },
          'acquisition: not in LazyLibrarian and no ISBN to resolve (findBook unavailable); skipping',
        );
        continue;
      }
      action = { kind: 'add', isbn: isbnKey.slice('isbn:'.length) };
    }

    // An LL write is due. Enforce the per-run cap and estate politeness.
    if (actions >= ctx.capPerRun) {
      counts.skipped += 1;
      log.info(
        { recipeId, work: work.label, cap: ctx.capPerRun },
        'acquisition: per-run cap reached; deferring to a later run',
      );
      continue;
    }
    if (acted) await sleep(ctx.intervalMs);
    acted = true;
    actions += 1;

    try {
      if (action.kind === 'drive') {
        await ctx.client.queueBook(action.book.bookId, format);
        await ctx.client.searchBook(action.book.bookId, format);
        counts.queued += 1;
        log.info(
          { recipeId, work: work.label, bookId: action.book.bookId, format },
          'acquisition: queued + searched (LazyLibrarian now wants it)',
        );
      } else {
        const ack = await ctx.client.addBookByISBN(action.isbn);
        if (/no results/i.test(ack)) {
          counts.skipped += 1;
          log.info(
            { recipeId, work: work.label, isbn: action.isbn, ack: ack.slice(0, 120) },
            'acquisition: LazyLibrarian could not resolve the ISBN this run (Google Books); will retry',
          );
        } else {
          counts.added += 1;
          log.info(
            { recipeId, work: work.label, isbn: action.isbn, ack: ack.slice(0, 120) },
            'acquisition: added to LazyLibrarian by ISBN; queue + search on a later run',
          );
        }
      }
    } catch (error) {
      counts.errors += 1;
      log.error(
        { recipeId, work: work.label, err: error },
        'acquisition: LazyLibrarian call failed',
      );
    }
  }

  return counts;
}
