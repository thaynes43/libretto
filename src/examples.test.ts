import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { recipeSchema } from './recipes/schema.js';

/**
 * Every shipped example recipe must be a valid recipe (a user copies these). This guards the whole
 * examples/ tree: the back-compat single-target `targetLibrary` recipes AND the multi-target
 * `targets[]` Authors program — so a schema change can never silently break a shipped example.
 */
const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));
const files = readdirSync(examplesDir, { recursive: true })
  .map(String)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

describe('example recipes', () => {
  it('finds the shipped examples', () => {
    expect(files.length).toBeGreaterThanOrEqual(25); // 4 core + 21 authors
  });

  it.each(files)('%s validates against recipeSchema', (name) => {
    const raw = readFileSync(`${examplesDir}/${name}`, 'utf8');
    const parsed = recipeSchema.safeParse(parse(raw));
    if (!parsed.success) {
      throw new Error(`${name}: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    // Filename stem must equal the recipe id (the store's on-disk contract).
    const stem = name.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
    expect(parsed.data.id).toBe(stem);
  });

  it('the Authors program is 21 recipes, each two-target static_ids canon with category Authors', () => {
    const authors = files.filter((name) => name.startsWith('authors/'));
    expect(authors).toHaveLength(21);
    for (const name of authors) {
      const recipe = recipeSchema.parse(parse(readFileSync(`${examplesDir}/${name}`, 'utf8')));
      expect(recipe.category).toBe('Authors');
      expect(recipe.builder.type).toBe('static_ids');
      expect(recipe.variables.ordered).toBe(false);
      expect(recipe.variables.acquisitionEnabled).toBe(true);
      expect(recipe.targets.map((t) => t.server).sort()).toEqual(['abs', 'kavita']);
      // Every canon entry is a { title, author } pair (rides the title_author fallback).
      const ref = recipe.builder.type === 'static_ids' ? recipe.builder.ref : [];
      expect(ref.length).toBeGreaterThan(0);
      expect(
        ref.every((entry) => typeof entry === 'object' && 'title' in entry && 'author' in entry),
      ).toBe(true);
    }
  });
});
