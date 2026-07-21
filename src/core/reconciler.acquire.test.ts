import { describe, expect, it } from 'vitest';
import type { AcquireContext } from '../acquire/acquire.js';
import { makeRecipe, makeSeededTarget, silentLogger } from '../testing/fixtures.js';
import { FakeLazyLibrarian, llBook } from '../testing/ll-stub.js';
import { reconcileRecipe } from './reconciler.js';

/** A hardcover builder context returning crafted works, mirroring reconciler.test.ts. */
const ctxFor = (
  works: { identifiers: string[]; label: string; title?: string; authors?: string[] }[],
) => ({ hardcoverSeries: { seriesWorks: () => Promise.resolve(works) } });

const acquireCtx = (client: FakeLazyLibrarian): AcquireContext => ({
  client,
  capPerRun: 10,
  intervalMs: 0,
  sleep: () => Promise.resolve(),
});

const acquiringRecipe = (server: 'kavita' | 'abs' = 'kavita') =>
  makeRecipe({
    targets: [{ server, libraryId: 'lib-1' }],
    builder: { type: 'hardcover_series', ref: 'stub' },
    variables: {
      syncMode: 'sync',
      ordered: true,
      acquisitionEnabled: true,
      titleFallback: true,
      schedule: 'manual',
    },
  });

describe('reconcileRecipe — M3 acquisition wiring', () => {
  it('feeds missing[] into LazyLibrarian and reports acquisition counts', async () => {
    const target = makeSeededTarget(); // items isbn:1..5
    const ll = new FakeLazyLibrarian([
      llBook({
        bookId: 'B404',
        title: 'The Missing One',
        isbn: '9780441172719',
        ebookStatus: 'Skipped',
      }),
    ]);
    const works = [
      { identifiers: ['isbn:1'], label: 'Book 1', title: 'Book 1' }, // matches library -> not missing
      { identifiers: ['isbn:9780441172719'], label: 'The Missing One', title: 'The Missing One' }, // missing -> acquire
    ];

    const result = await reconcileRecipe(
      acquiringRecipe(),
      target,
      silentLogger,
      ctxFor(works),
      acquireCtx(ll),
    );

    expect(result.counts.missing).toBe(1);
    expect(result.acquisition).toEqual({ queued: 1, added: 0, skipped: 0, errors: 0 });
    expect(ll.calls).toEqual([
      { cmd: 'queueBook', id: 'B404', format: 'ebook' },
      { cmd: 'searchBook', id: 'B404', format: 'ebook' },
    ]);
  });

  it('acquires AudioBooks for an ABS recipe', async () => {
    const target = makeSeededTarget();
    const ll = new FakeLazyLibrarian([
      llBook({
        bookId: 'B404',
        title: 'The Missing One',
        isbn: '9780441172719',
        audioStatus: 'Skipped',
      }),
    ]);
    const works = [
      { identifiers: ['isbn:9780441172719'], label: 'The Missing One', title: 'The Missing One' },
    ];
    const result = await reconcileRecipe(
      acquiringRecipe('abs'),
      target,
      silentLogger,
      ctxFor(works),
      acquireCtx(ll),
    );
    expect(result.acquisition?.queued).toBe(1);
    expect(ll.calls.every((c) => c.format === 'audiobook')).toBe(true);
  });

  it('does NOT acquire when acquisitionEnabled is false (no acquisition field, no LL calls)', async () => {
    const target = makeSeededTarget();
    const ll = new FakeLazyLibrarian([]);
    const recipe = makeRecipe({
      builder: { type: 'hardcover_series', ref: 'stub' },
    }); // default variables -> acquisitionEnabled false
    const works = [{ identifiers: ['isbn:404'], label: 'Nope', title: 'Nope' }];

    const result = await reconcileRecipe(
      recipe,
      target,
      silentLogger,
      ctxFor(works),
      acquireCtx(ll),
    );

    expect(result.acquisition).toBeUndefined();
    expect(ll.calls).toEqual([]);
  });

  it('warns (does not throw) when acquisitionEnabled but LazyLibrarian is not configured', async () => {
    const target = makeSeededTarget();
    const works = [{ identifiers: ['isbn:404'], label: 'Nope', title: 'Nope' }];
    // No AcquireContext passed -> the LL-not-configured branch.
    const result = await reconcileRecipe(acquiringRecipe(), target, silentLogger, ctxFor(works));
    expect(result.acquisition).toBeUndefined();
    expect(result.counts.missing).toBe(1);
  });
});
