import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunQueue } from './queue.js';
import { DiskCache } from '../cache/disk.js';
import { RecipeStore } from '../recipes/store.js';
import { RunStore } from '../runs/store.js';
import { AbsTarget } from '../target/abs.js';
import { KavitaTarget } from '../target/kavita.js';
import { categoryFromDescription, recipeIdFromDescription } from '../target/marker.js';
import { AbsStub } from '../testing/abs-stub.js';
import { KavitaStub } from '../testing/kavita-stub.js';
import { startStubServer } from '../testing/http.js';
import { makeTempDir, multiRegistry, silentLogger } from '../testing/fixtures.js';

/**
 * End-to-end smoke (temp config dir + real clients over stub Kavita/ABS): a two-target recipe saved
 * through the RecipeStore, applied by the RunQueue, materializes ONE collection into EACH server —
 * both carrying the SAME `[libretto:<id>|cat=<Category>]` marker (the shared merge key). This is the
 * multi-target path exercised through the real KavitaTarget/AbsTarget clients, not the FakeTarget.
 */
describe('multi-target smoke: two-target recipe into stubbed Kavita + ABS', () => {
  let cleanup: () => Promise<void>;
  let closeKavita: () => Promise<void>;
  let closeAbs: () => Promise<void>;
  let recipeStore: RecipeStore;
  let runStore: RunStore;
  let queue: RunQueue;
  let kavitaTarget: KavitaTarget;
  let absTarget: AbsTarget;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;

    const kavitaStub = new KavitaStub('kavita-key');
    kavitaStub.seedLibrary(2, 'Books');
    kavitaStub.seedSeries({
      id: 101,
      name: 'Leviathan Wakes',
      libraryId: 2,
      pages: 500,
      chapterIsbns: ['9780316129084'],
    });
    kavitaStub.seedSeries({
      id: 102,
      name: "Caliban's War",
      libraryId: 2,
      pages: 500,
      chapterIsbns: ['9780316129060'],
    });

    const absStub = new AbsStub('abs-token');
    absStub.seedLibrary('abs-lib', 'Audiobooks', [
      { id: 'a-1', title: 'Leviathan Wakes', isbn: '9780316129084' },
      { id: 'a-2', title: "Caliban's War", isbn: '9780316129060' },
    ]);

    const kavitaServer = await startStubServer(kavitaStub.app);
    const absServer = await startStubServer(absStub.app);
    closeKavita = kavitaServer.close;
    closeAbs = absServer.close;

    const cache = new DiskCache(path.join(tmp.dir, 'cache'));
    kavitaTarget = new KavitaTarget(
      { url: kavitaServer.url, apiKey: 'kavita-key' },
      silentLogger,
      cache,
    );
    absTarget = new AbsTarget({ url: absServer.url, apiKey: 'abs-token' }, silentLogger);

    recipeStore = new RecipeStore(path.join(tmp.dir, 'recipes'));
    runStore = new RunStore(path.join(tmp.dir, 'state', 'runs.json'));
    queue = new RunQueue({
      recipeStore,
      runStore,
      targets: multiRegistry({ kavita: kavitaTarget, abs: absTarget }),
      builders: {},
      log: silentLogger,
    });
  });

  afterEach(async () => {
    await closeKavita();
    await closeAbs();
    await cleanup();
  });

  it('reconciles into both servers with the shared marker + category', async () => {
    const saved = await recipeStore.save({
      id: 'expanse-both',
      targets: [
        { server: 'kavita', libraryId: '2' },
        { server: 'abs', libraryId: 'abs-lib' },
      ],
      name: 'The Expanse',
      category: 'Sci-Fi',
      builder: { type: 'static_ids', ref: ['isbn:9780316129084', 'isbn:9780316129060'] },
      variables: { syncMode: 'sync', ordered: false, schedule: 'manual' },
      enabled: true,
    });
    // The saved recipe normalized to the canonical targets[] shape.
    expect('recipe' in saved && saved.recipe.targets).toHaveLength(2);

    const runId = await queue.enqueue('expanse-both', 'api');
    await queue.onIdle();

    // One per-target result apiece, both for the same recipe id.
    const run = await runStore.get(runId);
    expect(run?.recipes).toHaveLength(2);
    expect(run?.recipes.map((r) => r.target.server).sort()).toEqual(['abs', 'kavita']);
    expect(run?.recipes.every((r) => r.recipeId === 'expanse-both')).toBe(true);
    expect(run?.recipes.every((r) => r.counts.matched === 2)).toBe(true);

    // Both servers now hold a collection owned by the SAME recipe id, both carrying the category.
    const kavOwned = (await kavitaTarget.listCollections('2')).find(
      (c) => recipeIdFromDescription(c.description) === 'expanse-both',
    );
    const absOwned = (await absTarget.listCollections('abs-lib')).find(
      (c) => recipeIdFromDescription(c.description) === 'expanse-both',
    );
    expect(kavOwned).toBeDefined();
    expect(absOwned).toBeDefined();
    expect(categoryFromDescription(kavOwned!.description)).toBe('Sci-Fi');
    expect(categoryFromDescription(absOwned!.description)).toBe('Sci-Fi');
    expect(kavOwned!.itemIds).toHaveLength(2); // both series matched by ISBN
    expect(absOwned!.itemIds).toEqual(['a-1', 'a-2']); // both items matched by ISBN
  });
});
