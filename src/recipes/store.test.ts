import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { RecipeStore } from './store.js';
import { makeRecipe, makeTempDir } from '../testing/fixtures.js';

describe('RecipeStore', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let store: RecipeStore;

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
    store = new RecipeStore(dir);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('round-trips save -> get -> list -> delete', async () => {
    const recipe = makeRecipe({ id: 'space-operas' });
    const saved = await store.save(recipe);
    expect(saved).toEqual({ recipe });

    // filename = id, YAML on disk
    const onDisk = await readFile(path.join(dir, 'space-operas.yml'), 'utf8');
    expect(onDisk).toContain('id: space-operas');

    expect(await store.get('space-operas')).toEqual(recipe);
    const listed = await store.list();
    expect(listed.recipes).toEqual([recipe]);
    expect(listed.issues).toEqual([]);

    expect(await store.delete('space-operas')).toBe(true);
    expect(await store.get('space-operas')).toBeUndefined();
    expect(await store.delete('space-operas')).toBe(false);
  });

  it('rejects an invalid recipe with issues and writes nothing', async () => {
    const result = await store.save({ id: 'bad', name: 'Bad' });
    expect('issues' in result && result.issues.length).toBeGreaterThan(0);
    expect((await store.list()).recipes).toEqual([]);
  });

  it('reports an unparseable YAML file as an issue without hiding neighbors', async () => {
    await store.save(makeRecipe({ id: 'good' }));
    await writeFile(path.join(dir, 'broken.yml'), '{{{ not yaml', 'utf8');
    const { recipes, issues } = await store.list();
    expect(recipes.map((r) => r.id)).toEqual(['good']);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ recipeId: 'broken' });
  });

  it('reports an id/filename mismatch as an issue', async () => {
    await writeFile(
      path.join(dir, 'wrong-name.yml'),
      stringify(makeRecipe({ id: 'other-id' })),
      'utf8',
    );
    const { recipes, issues } = await store.list();
    expect(recipes).toEqual([]);
    expect(issues[0]?.message).toMatch(/does not match its filename/);
  });

  it('rejects path-traversal ids', async () => {
    await expect(store.get('../escape')).rejects.toThrow(/invalid recipe id/);
    await expect(store.delete('../escape')).rejects.toThrow(/invalid recipe id/);
  });
});
