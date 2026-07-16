import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunQueue } from './queue.js';
import { RecipeStore } from '../recipes/store.js';
import { RunStore } from '../runs/store.js';
import {
  makeRecipe,
  makeSeededTarget,
  makeTempDir,
  registryFor,
  silentLogger,
} from '../testing/fixtures.js';

describe('RunQueue', () => {
  let cleanup: () => Promise<void>;
  let recipeStore: RecipeStore;
  let runStore: RunStore;
  let queue: RunQueue;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    recipeStore = new RecipeStore(path.join(tmp.dir, 'recipes'));
    runStore = new RunStore(path.join(tmp.dir, 'state', 'runs.json'));
    queue = new RunQueue({
      recipeStore,
      runStore,
      targets: registryFor(makeSeededTarget()),
      log: silentLogger,
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('runs all enabled recipes for scope=all and records per-recipe counts', async () => {
    await recipeStore.save(
      makeRecipe({ id: 'one', builder: { type: 'static_ids', ref: ['isbn:1'] } }),
    );
    await recipeStore.save(
      makeRecipe({ id: 'two', builder: { type: 'static_ids', ref: ['isbn:2'] } }),
    );
    await recipeStore.save(makeRecipe({ id: 'off', enabled: false }));

    const runId = await queue.enqueue('all', 'api');
    expect((await runStore.get(runId))?.status).toBe('running');
    await queue.onIdle();

    const run = await runStore.get(runId);
    expect(run?.status).toBe('ok');
    expect(run?.finishedAt).toBeDefined();
    expect(run?.recipes.map((r) => r.recipeId).sort()).toEqual(['one', 'two']);
    expect(run?.recipes[0]?.counts.matched).toBe(1);
  });

  it('flags missing identifiers as warn', async () => {
    await recipeStore.save(
      makeRecipe({ id: 'gaps', builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:404'] } }),
    );
    const runId = await queue.enqueue('gaps', 'api');
    await queue.onIdle();
    const run = await runStore.get(runId);
    expect(run?.status).toBe('warn');
    expect(run?.recipes[0]?.missing).toEqual(['isbn:404']);
  });

  it('records a recipe failure as error without killing the run record', async () => {
    await recipeStore.save(
      makeRecipe({
        id: 'bad-library',
        targetLibrary: { server: 'kavita', libraryId: 'nope' },
      }),
    );
    const runId = await queue.enqueue('bad-library', 'api');
    await queue.onIdle();
    const run = await runStore.get(runId);
    expect(run?.status).toBe('error');
    expect(run?.recipes[0]?.error).toMatch(/no library/);
  });

  it('serializes runs: two enqueues both complete, one at a time', async () => {
    await recipeStore.save(
      makeRecipe({ id: 'solo', builder: { type: 'static_ids', ref: ['isbn:1'] } }),
    );
    const [a, b] = await Promise.all([queue.enqueue('solo', 'api'), queue.enqueue('solo', 'api')]);
    await queue.onIdle();
    expect((await runStore.get(a))?.status).toBe('ok');
    expect((await runStore.get(b))?.status).toBe('ok');
  });
});
