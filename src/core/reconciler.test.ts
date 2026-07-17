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
    expect(result.counts).toEqual({
      matched: 3,
      matchedByTitle: 0,
      written: 3,
      added: 3,
      removed: 0,
      missing: 0,
    });
    expect(result.missing).toEqual([]);
  });

  it('reports unmatched identifiers as missing[] and still writes the matches', async () => {
    const target = makeSeededTarget();
    const recipe = makeRecipe({
      builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:404', 'isbn:2'] },
    });

    const result = await reconcileRecipe(recipe, target, silentLogger);

    expect(result.missing).toEqual(['isbn:404']);
    expect(result.counts).toEqual({
      matched: 2,
      matchedByTitle: 0,
      written: 2,
      added: 2,
      removed: 0,
      missing: 1,
    });
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
        titleFallback: true,
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
    expect(result.counts).toEqual({
      matched: 2,
      matchedByTitle: 0,
      written: 3,
      added: 1,
      removed: 0,
      missing: 0,
    });
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
    expect(result.counts).toEqual({
      matched: 3,
      matchedByTitle: 0,
      written: 3,
      added: 1,
      removed: 1,
      missing: 0,
    });
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
        titleFallback: true,
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
    expect(result.counts).toEqual({
      matched: 0,
      matchedByTitle: 0,
      written: 2,
      added: 0,
      removed: 0,
      missing: 1,
    });
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

describe('reconcileRecipe — D-04 conservative title fallback', () => {
  interface StubWork {
    identifiers: string[];
    label: string;
    title?: string;
    authors?: string[];
  }
  /** A builder context whose hardcover source returns the given crafted works. */
  const ctxFor = (works: StubWork[]) => ({
    hardcoverSeries: { seriesWorks: () => Promise.resolve(works) },
  });
  const hardcoverRecipe = (overrides = {}) =>
    makeRecipe({ builder: { type: 'hardcover_series', ref: 'stub' }, ...overrides });

  it('matches by title when identifiers miss, and flags it via matchedByTitle', async () => {
    // Kavita-like library: real series names, but the epubs expose NO ISBNs.
    const target = makeSeededTarget();
    target.seedLibrary({
      id: 'lib-1',
      name: 'Kavita',
      items: [
        { id: 's-1', title: "Harry Potter and the Philosopher's Stone", identifiers: [] },
        { id: 's-2', title: 'Harry Potter and the Chamber of Secrets', identifiers: [] },
        { id: 's-3', title: 'Harry Potter and the Prisoner of Azkaban', identifiers: [] },
      ],
    });
    const recipe = hardcoverRecipe();
    const works: StubWork[] = [
      // Hardcover carries ISBNs the Kavita side cannot expose -> identifier miss.
      {
        identifiers: ['isbn:9780747532699'],
        label: "Harry Potter and the Philosopher's Stone (#1 in Harry Potter)",
        title: "Harry Potter and the Philosopher's Stone",
      },
      {
        identifiers: ['isbn:9780747538493'],
        label: 'Harry Potter and the Chamber of Secrets (#2 in Harry Potter)',
        title: 'Harry Potter and the Chamber of Secrets',
      },
      // US title divergence: an HONEST miss, never forced with fuzz.
      {
        identifiers: ['isbn:9780439136365'],
        label: "Harry Potter and the Sorcerer's Stone (#1 in Harry Potter)",
        title: "Harry Potter and the Sorcerer's Stone",
      },
    ];

    const result = await reconcileRecipe(recipe, target, silentLogger, ctxFor(works));

    expect(result.counts.matched).toBe(2);
    expect(result.counts.matchedByTitle).toBe(2);
    expect(result.counts.missing).toBe(1);
    expect(result.missing).toEqual(["Harry Potter and the Sorcerer's Stone (#1 in Harry Potter)"]);
    const [collection] = await target.listCollections('lib-1');
    expect(collection?.itemIds).toEqual(['s-1', 's-2']);
  });

  it('prefers an identifier match and does not count it as a title match', async () => {
    const target = makeSeededTarget(); // items Book 1..5, isbn:1..5
    const recipe = hardcoverRecipe();
    const works: StubWork[] = [
      { identifiers: ['isbn:1'], label: 'Book 1', title: 'Book 1' }, // id hit
      { identifiers: ['isbn:zzz'], label: 'Book 2', title: 'Book 2' }, // title hit
    ];

    const result = await reconcileRecipe(recipe, target, silentLogger, ctxFor(works));

    expect(result.counts.matched).toBe(2);
    expect(result.counts.matchedByTitle).toBe(1);
    const [collection] = await target.listCollections('lib-1');
    expect(collection?.itemIds).toEqual(['item-1', 'item-2']);
  });

  it('honors titleFallback: false (identifier-only, the title hit becomes missing)', async () => {
    const target = makeSeededTarget();
    const recipe = hardcoverRecipe({
      variables: {
        syncMode: 'sync',
        ordered: true,
        acquisitionEnabled: false,
        titleFallback: false,
        schedule: 'manual',
      },
    });
    const works: StubWork[] = [
      { identifiers: ['isbn:1'], label: 'Book 1', title: 'Book 1' },
      { identifiers: ['isbn:zzz'], label: 'Book 2', title: 'Book 2' },
    ];

    const result = await reconcileRecipe(recipe, target, silentLogger, ctxFor(works));

    expect(result.counts.matched).toBe(1);
    expect(result.counts.matchedByTitle).toBe(0);
    expect(result.missing).toEqual(['Book 2']);
  });

  it('vetoes a title match when both sides name disjoint authors', async () => {
    const target = makeSeededTarget();
    target.seedLibrary({
      id: 'lib-1',
      name: 'ABS',
      items: [{ id: 'a-1', title: 'Dune', identifiers: [], authors: ['Kevin J. Anderson'] }],
    });
    const recipe = hardcoverRecipe();
    const works: StubWork[] = [
      { identifiers: ['isbn:zzz'], label: 'Dune', title: 'Dune', authors: ['Frank Herbert'] },
    ];

    const result = await reconcileRecipe(recipe, target, silentLogger, ctxFor(works));

    expect(result.counts.matched).toBe(0);
    expect(result.missing).toEqual(['Dune']);
  });

  it('refuses a library-side ambiguous title (two distinct items, same name)', async () => {
    const target = makeSeededTarget();
    target.seedLibrary({
      id: 'lib-1',
      name: 'Kavita',
      items: [
        { id: 'x-1', title: 'The Gathering', identifiers: [] },
        { id: 'x-2', title: 'The Gathering', identifiers: [] },
      ],
    });
    const recipe = hardcoverRecipe();
    const works: StubWork[] = [
      { identifiers: ['isbn:zzz'], label: 'The Gathering', title: 'The Gathering' },
    ];

    const result = await reconcileRecipe(recipe, target, silentLogger, ctxFor(works));

    expect(result.counts.matched).toBe(0);
    expect(result.missing).toEqual(['The Gathering']);
  });
});
