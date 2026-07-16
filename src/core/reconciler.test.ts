import { describe, expect, it } from 'vitest';
import { reconcileRecipe } from './reconciler.js';
import { buildCollectionDescription } from '../target/marker.js';
import { makeRecipe, makeSeededTarget, silentLogger } from '../testing/fixtures.js';

describe('reconcileRecipe (end-to-end against FakeTarget)', () => {
  it('creates a marked collection with ordered positions from the builder order', async () => {
    const target = makeSeededTarget();
    const recipe = makeRecipe({
      builder: { type: 'static_ids', ref: ['isbn:3', 'isbn:1', 'isbn:5'] },
    });

    const result = await reconcileRecipe(recipe, target, silentLogger);

    const [collection] = await target.listCollections('lib-1');
    expect(collection?.name).toBe('Test Recipe');
    expect(collection?.description).toContain('[libretto:test-recipe]');
    expect(collection?.itemIds).toEqual(['item-3', 'item-1', 'item-5']);
    expect(result.counts).toEqual({ matched: 3, written: 3, added: 3, removed: 0, missing: 0 });
    expect(result.missing).toEqual([]);
  });

  it('reports unmatched identifiers as missing[] and still writes the matches', async () => {
    const target = makeSeededTarget();
    const recipe = makeRecipe({
      builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:404', 'isbn:2'] },
    });

    const result = await reconcileRecipe(recipe, target, silentLogger);

    expect(result.missing).toEqual(['isbn:404']);
    expect(result.counts).toEqual({ matched: 2, written: 2, added: 2, removed: 0, missing: 1 });
    const [collection] = await target.listCollections('lib-1');
    expect(collection?.itemIds).toEqual(['item-1', 'item-2']);
  });

  it('append mode adds at the end and never removes', async () => {
    const target = makeSeededTarget();
    const first = makeRecipe({
      builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:2'] },
      variables: {
        syncMode: 'append',
        ordered: false,
        acquisitionEnabled: false,
        schedule: 'manual',
      },
    });
    await reconcileRecipe(first, target, silentLogger);

    // isbn:1 dropped from the recipe, isbn:3 arrives — append must keep item-1
    const second = makeRecipe({
      ...first,
      builder: { type: 'static_ids', ref: ['isbn:3', 'isbn:2'] },
    });
    const result = await reconcileRecipe(second, target, silentLogger);

    const [collection] = await target.listCollections('lib-1');
    expect(collection?.itemIds).toEqual(['item-1', 'item-2', 'item-3']);
    expect(result.counts).toEqual({ matched: 2, written: 3, added: 1, removed: 0, missing: 0 });
  });

  it('sync mode removes departed items and enforces ordered positions', async () => {
    const target = makeSeededTarget();
    const recipe = makeRecipe({
      builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:2', 'isbn:3'] },
    });
    await reconcileRecipe(recipe, target, silentLogger);

    const changed = makeRecipe({
      builder: { type: 'static_ids', ref: ['isbn:3', 'isbn:4', 'isbn:1'] },
    });
    const result = await reconcileRecipe(changed, target, silentLogger);

    const [collection] = await target.listCollections('lib-1');
    expect(collection?.itemIds).toEqual(['item-3', 'item-4', 'item-1']);
    expect(result.counts).toEqual({ matched: 3, written: 3, added: 1, removed: 1, missing: 0 });
  });

  it('unordered sync keeps the target relative order for retained items', async () => {
    const target = makeSeededTarget();
    target.seedCollection({
      libraryId: 'lib-1',
      name: 'Test Recipe',
      description: buildCollectionDescription('test-recipe'),
      tags: [],
      itemIds: ['item-2', 'item-1'],
    });
    const recipe = makeRecipe({
      builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:2', 'isbn:3'] },
      variables: {
        syncMode: 'sync',
        ordered: false,
        acquisitionEnabled: false,
        schedule: 'manual',
      },
    });

    await reconcileRecipe(recipe, target, silentLogger);

    const [collection] = await target.listCollections('lib-1');
    expect(collection?.itemIds).toEqual(['item-2', 'item-1', 'item-3']);
  });

  it('still owns a renamed collection via the marker (no duplicate created)', async () => {
    const target = makeSeededTarget();
    const recipe = makeRecipe({ builder: { type: 'static_ids', ref: ['isbn:1'] } });
    await reconcileRecipe(recipe, target, silentLogger);
    const [created] = await target.listCollections('lib-1');
    target.renameCollection(created!.id, 'A Human Renamed This');

    const changed = makeRecipe({ builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:2'] } });
    await reconcileRecipe(changed, target, silentLogger);

    const collections = await target.listCollections('lib-1');
    expect(collections).toHaveLength(1);
    expect(collections[0]?.name).toBe('A Human Renamed This'); // rename preserved
    expect(collections[0]?.itemIds).toEqual(['item-1', 'item-2']); // membership reconciled
  });

  it('never touches an unmarked same-name collection', async () => {
    const target = makeSeededTarget();
    const handCurated = target.seedCollection({
      libraryId: 'lib-1',
      name: 'Test Recipe', // same name as the recipe produces
      description: 'A hand-curated collection with no marker',
      tags: [],
      itemIds: ['item-5'],
    });
    const recipe = makeRecipe({ builder: { type: 'static_ids', ref: ['isbn:1'] } });

    await reconcileRecipe(recipe, target, silentLogger);

    const untouched = target.getCollection(handCurated.id);
    expect(untouched?.itemIds).toEqual(['item-5']);
    expect(untouched?.description).toBe('A hand-curated collection with no marker');
    // Libretto created its own marked collection alongside
    const collections = await target.listCollections('lib-1');
    expect(collections).toHaveLength(2);
    const owned = collections.find((c) => c.description.includes('[libretto:test-recipe]'));
    expect(owned?.itemIds).toEqual(['item-1']);
  });

  it('zero matches leaves an existing collection alone (warn, not wipe)', async () => {
    const target = makeSeededTarget();
    const recipe = makeRecipe({ builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:2'] } });
    await reconcileRecipe(recipe, target, silentLogger);

    const gone = makeRecipe({ builder: { type: 'static_ids', ref: ['isbn:404'] } });
    const result = await reconcileRecipe(gone, target, silentLogger);

    const [collection] = await target.listCollections('lib-1');
    expect(collection?.itemIds).toEqual(['item-1', 'item-2']); // untouched
    expect(result.counts).toEqual({ matched: 0, written: 2, added: 0, removed: 0, missing: 1 });
  });

  it('a no-op reconcile issues no target write', async () => {
    const target = makeSeededTarget();
    const recipe = makeRecipe({ builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:2'] } });
    await reconcileRecipe(recipe, target, silentLogger);

    let updates = 0;
    const original = target.updateCollection.bind(target);
    target.updateCollection = (id, patch) => {
      updates += 1;
      return original(id, patch);
    };
    await reconcileRecipe(recipe, target, silentLogger);
    expect(updates).toBe(0);
  });
});
