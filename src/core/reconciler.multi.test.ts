import { describe, expect, it } from 'vitest';
import { reconcileRecipeTargets } from './reconciler.js';
import { FakeTarget } from '../target/fake.js';
import { buildCollectionDescription, categoryFromDescription } from '../target/marker.js';
import { makeRecipe, multiRegistry, silentLogger } from '../testing/fixtures.js';

/** A FakeTarget holding one library `libraryId` seeded with the given isbn ordinals. */
function fakeWith(libraryId: string, isbns: number[]): FakeTarget {
  const target = new FakeTarget();
  target.seedLibrary({
    id: libraryId,
    name: libraryId,
    items: isbns.map((n) => ({
      id: `${libraryId}-item-${n}`,
      title: `Book ${n}`,
      identifiers: [`isbn:${n}`],
    })),
  });
  return target;
}

/** A two-target recipe (Kavita library `kav`, ABS library `abs`) over the given static ref. */
const twoTargetRecipe = (
  ref: (string | { title: string; author: string })[],
  overrides: Partial<ReturnType<typeof makeRecipe>> = {},
) =>
  makeRecipe({
    targets: [
      { server: 'kavita', libraryId: 'kav' },
      { server: 'abs', libraryId: 'abs' },
    ],
    builder: { type: 'static_ids', ref },
    ...overrides,
  });

describe('reconcileRecipeTargets — two-target materialization (ADR-076)', () => {
  it('materializes ONE collection per target, both carrying the SAME marker (shared merge key)', async () => {
    const kavita = fakeWith('kav', [1, 2, 3]);
    const abs = fakeWith('abs', [1, 2, 3]);
    const recipe = twoTargetRecipe(['isbn:1', 'isbn:2', 'isbn:3']);

    const results = await reconcileRecipeTargets(
      recipe,
      multiRegistry({ kavita, abs }),
      silentLogger,
    );

    // One result per target, each tagging its target.
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.target)).toEqual([
      { server: 'kavita', libraryId: 'kav' },
      { server: 'abs', libraryId: 'abs' },
    ]);

    const [kavCol] = await kavita.listCollections('kav');
    const [absCol] = await abs.listCollections('abs');
    // Same recipe id in both markers — the merge key a downstream mirror keys the twins by.
    expect(kavCol?.description).toContain('[libretto:test-recipe]');
    expect(absCol?.description).toContain('[libretto:test-recipe]');
    expect(kavCol?.itemIds).toEqual(['kav-item-1', 'kav-item-2', 'kav-item-3']);
    expect(absCol?.itemIds).toEqual(['abs-item-1', 'abs-item-2', 'abs-item-3']);
  });

  it('splits missing[] per target (a work held in Kavita but absent from ABS)', async () => {
    const kavita = fakeWith('kav', [1, 2, 3]); // holds isbn:3
    const abs = fakeWith('abs', [1, 2]); // lacks isbn:3
    const recipe = twoTargetRecipe(['isbn:1', 'isbn:2', 'isbn:3']);

    const [kavResult, absResult] = await reconcileRecipeTargets(
      recipe,
      multiRegistry({ kavita, abs }),
      silentLogger,
    );

    expect(kavResult?.target.server).toBe('kavita');
    expect(kavResult?.missing).toEqual([]);
    expect(absResult?.target.server).toBe('abs');
    expect(absResult?.missing).toEqual(['isbn:3']); // missing FROM abs only
    expect(absResult?.counts.missing).toBe(1);
    const [absCol] = await abs.listCollections('abs');
    expect(absCol?.itemIds).toEqual(['abs-item-1', 'abs-item-2']); // the held ones still written
  });

  it('sync reconciles add/remove/reposition INDEPENDENTLY per target', async () => {
    const kavita = fakeWith('kav', [1, 2, 3]);
    const abs = fakeWith('abs', [1, 2]); // no isbn:3
    const registry = multiRegistry({ kavita, abs });
    await reconcileRecipeTargets(
      twoTargetRecipe(['isbn:1', 'isbn:2', 'isbn:3']),
      registry,
      silentLogger,
    );

    // Reorder + drop isbn:2, keep isbn:1, add isbn:3 (held only in kavita).
    await reconcileRecipeTargets(twoTargetRecipe(['isbn:3', 'isbn:1']), registry, silentLogger);

    const [kavCol] = await kavita.listCollections('kav');
    const [absCol] = await abs.listCollections('abs');
    // Kavita has isbn:3, so it repositions to [3, 1] and removes 2.
    expect(kavCol?.itemIds).toEqual(['kav-item-3', 'kav-item-1']);
    // ABS lacks isbn:3, so only isbn:1 remains (isbn:2 removed, isbn:3 missing).
    expect(absCol?.itemIds).toEqual(['abs-item-1']);
  });

  it('append never removes on either target', async () => {
    const kavita = fakeWith('kav', [1, 2, 3]);
    const abs = fakeWith('abs', [1, 2, 3]);
    const registry = multiRegistry({ kavita, abs });
    const append = {
      variables: {
        syncMode: 'append' as const,
        ordered: false,
        acquisitionEnabled: false,
        titleFallback: true,
        schedule: 'manual' as const,
      },
    };
    await reconcileRecipeTargets(
      twoTargetRecipe(['isbn:1', 'isbn:2'], append),
      registry,
      silentLogger,
    );

    // isbn:1 dropped from the recipe, isbn:3 arrives — append keeps item-1 on BOTH targets.
    await reconcileRecipeTargets(
      twoTargetRecipe(['isbn:3', 'isbn:2'], append),
      registry,
      silentLogger,
    );

    const [kavCol] = await kavita.listCollections('kav');
    const [absCol] = await abs.listCollections('abs');
    expect(kavCol?.itemIds).toEqual(['kav-item-1', 'kav-item-2', 'kav-item-3']);
    expect(absCol?.itemIds).toEqual(['abs-item-1', 'abs-item-2', 'abs-item-3']);
  });

  it('is stateless: a second identical run converges with NO target writes on either target', async () => {
    const kavita = fakeWith('kav', [1, 2, 3]);
    const abs = fakeWith('abs', [1, 2, 3]);
    const registry = multiRegistry({ kavita, abs });
    const recipe = twoTargetRecipe(['isbn:1', 'isbn:2', 'isbn:3']);
    await reconcileRecipeTargets(recipe, registry, silentLogger);

    let kavWrites = 0;
    let absWrites = 0;
    const kavOrig = kavita.updateCollection.bind(kavita);
    const absOrig = abs.updateCollection.bind(abs);
    kavita.updateCollection = (id, patch) => (kavWrites++, kavOrig(id, patch));
    abs.updateCollection = (id, patch) => (absWrites++, absOrig(id, patch));

    // Wiping run-state/cache changes nothing: ownership lives in the targets, so re-running converges.
    await reconcileRecipeTargets(recipe, registry, silentLogger);
    expect(kavWrites).toBe(0);
    expect(absWrites).toBe(0);
  });

  it('orphans per target: each produced collection stays marker-owned (recoverable) independently', async () => {
    const kavita = fakeWith('kav', [1, 2]);
    const abs = fakeWith('abs', [1, 2]);
    await reconcileRecipeTargets(
      twoTargetRecipe(['isbn:1', 'isbn:2']),
      multiRegistry({ kavita, abs }),
      silentLogger,
    );

    // Deleting the recipe file orphans (never deletes) the collections; each target still carries the
    // marker, so each orphans independently and is still recoverable as test-recipe's.
    const [kavCol] = await kavita.listCollections('kav');
    const [absCol] = await abs.listCollections('abs');
    expect(kavCol?.description).toContain('[libretto:test-recipe]');
    expect(absCol?.description).toContain('[libretto:test-recipe]');
  });

  it('a target being unavailable does not blank the other (per-target error isolation)', async () => {
    const kavita = fakeWith('kav', [1, 2]);
    // ABS routing throws (unconfigured), Kavita still reconciles.
    const registry = multiRegistry({ kavita });
    const [kavResult, absResult] = await reconcileRecipeTargets(
      twoTargetRecipe(['isbn:1', 'isbn:2']),
      registry,
      silentLogger,
    );
    expect(kavResult?.error).toBeUndefined();
    expect(kavResult?.counts.matched).toBe(2);
    expect(absResult?.target.server).toBe('abs');
    expect(absResult?.error).toMatch(/not configured/);
    const [kavCol] = await kavita.listCollections('kav');
    expect(kavCol?.itemIds).toEqual(['kav-item-1', 'kav-item-2']);
  });
});

describe('reconcileRecipeTargets — category marker (ADR-076 C-02)', () => {
  it('emits [libretto:<id>|cat=<Category>] on every target when category is set', async () => {
    const kavita = fakeWith('kav', [1, 2]);
    const abs = fakeWith('abs', [1, 2]);
    const recipe = twoTargetRecipe(['isbn:1', 'isbn:2'], { category: 'Authors' });

    await reconcileRecipeTargets(recipe, multiRegistry({ kavita, abs }), silentLogger);

    const [kavCol] = await kavita.listCollections('kav');
    const [absCol] = await abs.listCollections('abs');
    expect(kavCol?.description).toContain('[libretto:test-recipe|cat=Authors]');
    expect(absCol?.description).toContain('[libretto:test-recipe|cat=Authors]');
    expect(categoryFromDescription(kavCol?.description)).toBe('Authors');
    expect(categoryFromDescription(absCol?.description)).toBe('Authors');
  });

  it('re-syncs the marker on an already-produced collection when a category is added later', async () => {
    const kavita = fakeWith('kav', [1, 2]);
    const abs = fakeWith('abs', [1, 2]);
    const registry = multiRegistry({ kavita, abs });
    // First run: no category — plain marker on both.
    await reconcileRecipeTargets(twoTargetRecipe(['isbn:1', 'isbn:2']), registry, silentLogger);
    let [kavCol] = await kavita.listCollections('kav');
    expect(categoryFromDescription(kavCol?.description)).toBeUndefined();

    // Second run adds category: the reconciler re-writes the marker token (preserving prose).
    await reconcileRecipeTargets(
      twoTargetRecipe(['isbn:1', 'isbn:2'], { category: 'Authors' }),
      registry,
      silentLogger,
    );
    [kavCol] = await kavita.listCollections('kav');
    const [absCol] = await abs.listCollections('abs');
    expect(categoryFromDescription(kavCol?.description)).toBe('Authors');
    expect(categoryFromDescription(absCol?.description)).toBe('Authors');
    // The surrounding managed-by prose survives the token swap.
    expect(kavCol?.description).toContain('Managed by Libretto');
  });

  it('leaves a category-free recipe unchanged on re-run (no needless description write)', async () => {
    const kavita = fakeWith('kav', [1, 2]);
    const registry = multiRegistry({ kavita, abs: fakeWith('abs', [1, 2]) });
    const recipe = makeRecipe({
      targets: [{ server: 'kavita', libraryId: 'kav' }],
      builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:2'] },
    });
    await reconcileRecipeTargets(recipe, registry, silentLogger);
    let writes = 0;
    const orig = kavita.updateCollection.bind(kavita);
    kavita.updateCollection = (id, patch) => (writes++, orig(id, patch));
    await reconcileRecipeTargets(recipe, registry, silentLogger);
    expect(writes).toBe(0);
  });
});

describe('reconcileRecipeTargets — static { title, author } entries (ADR-076 C-07)', () => {
  it('matches curated { title, author } canon via the title fallback (flagged), missing the rest', async () => {
    // A Kavita-like library exposing NO ISBNs, series named like the canon titles.
    const kavita = new FakeTarget();
    kavita.seedLibrary({
      id: 'kav',
      name: 'Books',
      items: [
        { id: 's-foundation', title: 'Foundation', identifiers: [], authors: ['Isaac Asimov'] },
        { id: 's-caves', title: 'The Caves of Steel', identifiers: [], authors: ['Isaac Asimov'] },
      ],
    });
    const recipe = makeRecipe({
      targets: [{ server: 'kavita', libraryId: 'kav' }],
      category: 'Authors',
      builder: {
        type: 'static_ids',
        ref: [
          { title: 'Foundation', author: 'Isaac Asimov' },
          { title: 'The Caves of Steel', author: 'Isaac Asimov' },
          { title: 'Nightfall', author: 'Isaac Asimov' }, // not held -> missing
        ],
      },
      variables: {
        syncMode: 'sync',
        ordered: false,
        acquisitionEnabled: false,
        titleFallback: true,
        schedule: 'manual',
      },
    });

    const [result] = await reconcileRecipeTargets(recipe, multiRegistry({ kavita }), silentLogger);

    expect(result?.counts.matched).toBe(2);
    expect(result?.counts.matchedByTitle).toBe(2); // both resolved by title+author, not identifier
    expect(result?.missing).toEqual(['Nightfall by Isaac Asimov']);
    const [collection] = await kavita.listCollections('kav');
    expect(collection?.itemIds).toEqual(['s-foundation', 's-caves']);
    expect(collection?.description).toContain('[libretto:test-recipe|cat=Authors]');
  });

  it('vetoes a title/author match when the authors disagree (honest miss, no fabrication)', async () => {
    const kavita = new FakeTarget();
    kavita.seedLibrary({
      id: 'kav',
      name: 'Books',
      items: [{ id: 's-dune', title: 'Dune', identifiers: [], authors: ['Kevin J. Anderson'] }],
    });
    const recipe = makeRecipe({
      targets: [{ server: 'kavita', libraryId: 'kav' }],
      builder: { type: 'static_ids', ref: [{ title: 'Dune', author: 'Frank Herbert' }] },
      variables: {
        syncMode: 'sync',
        ordered: false,
        acquisitionEnabled: false,
        titleFallback: true,
        schedule: 'manual',
      },
    });

    const [result] = await reconcileRecipeTargets(recipe, multiRegistry({ kavita }), silentLogger);
    expect(result?.counts.matched).toBe(0);
    expect(result?.missing).toEqual(['Dune by Frank Herbert']);
  });
});

describe('buildCollectionDescription — category token', () => {
  it('includes cat= only when a category is given', () => {
    expect(buildCollectionDescription('r')).toContain('[libretto:r]');
    expect(buildCollectionDescription('r')).not.toContain('cat=');
    expect(buildCollectionDescription('r', 'Authors')).toContain('[libretto:r|cat=Authors]');
  });
});
