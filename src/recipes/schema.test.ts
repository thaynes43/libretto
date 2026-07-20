import { describe, expect, it } from 'vitest';
import { recipeSchema } from './schema.js';
import { makeRecipe } from '../testing/fixtures.js';

describe('recipeSchema', () => {
  it('accepts a valid recipe', () => {
    const parsed = recipeSchema.safeParse(makeRecipe());
    expect(parsed.success).toBe(true);
  });

  it('defaults acquisitionEnabled to false', () => {
    const recipe = makeRecipe();
    const { acquisitionEnabled: _dropped, ...variables } = recipe.variables;
    const parsed = recipeSchema.parse({ ...recipe, variables });
    expect(parsed.variables.acquisitionEnabled).toBe(false);
  });

  it('accepts a cron schedule', () => {
    const recipe = makeRecipe();
    recipe.variables.schedule = '0 3 * * *';
    expect(recipeSchema.safeParse(recipe).success).toBe(true);
  });

  it.each([
    ['bad id', { id: 'Not A Valid Id!' }],
    ['unknown server', { targetLibrary: { server: 'plex', libraryId: 'lib-1' } }],
    ['empty name', { name: '' }],
    ['unknown builder type', { builder: { type: 'goodreads_shelf', ref: 'series-1' } }],
    ['empty hardcover series ref', { builder: { type: 'hardcover_series', ref: '' } }],
    ['empty nyt list ref', { builder: { type: 'nyt_list', ref: '' } }],
    ['empty static id list', { builder: { type: 'static_ids', ref: [] } }],
  ])('rejects %s', (_label, override) => {
    const parsed = recipeSchema.safeParse({ ...makeRecipe(), ...override });
    expect(parsed.success).toBe(false);
  });

  it('accepts a nyt_list builder with a list_name_encoded ref', () => {
    const recipe = { ...makeRecipe(), builder: { type: 'nyt_list', ref: 'hardcover-fiction' } };
    expect(recipeSchema.safeParse(recipe).success).toBe(true);
  });

  it('accepts a hardcover_comics builder with a series-ref array (ids and/or slugs)', () => {
    const recipe = {
      ...makeRecipe(),
      builder: { type: 'hardcover_comics', ref: [14911, 'guarding-the-globe'] },
    };
    expect(recipeSchema.safeParse(recipe).success).toBe(true);
  });

  it('rejects an empty hardcover_comics ref array', () => {
    const recipe = { ...makeRecipe(), builder: { type: 'hardcover_comics', ref: [] } };
    expect(recipeSchema.safeParse(recipe).success).toBe(false);
  });

  it('rejects acquisitionEnabled on a comics recipe (grouping-only, out of scope)', () => {
    const base = makeRecipe();
    const recipe = {
      ...base,
      builder: { type: 'hardcover_comics', ref: ['invincible'] },
      variables: { ...base.variables, acquisitionEnabled: true },
    };
    const parsed = recipeSchema.safeParse(recipe);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path.join('.') === 'variables.acquisitionEnabled'),
      ).toBe(true);
    }
  });

  it('accepts a comics recipe when acquisitionEnabled is false', () => {
    const base = makeRecipe();
    const recipe = {
      ...base,
      builder: { type: 'hardcover_comics', ref: ['invincible'] },
      variables: { ...base.variables, acquisitionEnabled: false },
    };
    expect(recipeSchema.safeParse(recipe).success).toBe(true);
  });

  it('rejects a bad cron schedule', () => {
    const recipe = makeRecipe();
    recipe.variables.schedule = 'every full moon';
    expect(recipeSchema.safeParse(recipe).success).toBe(false);
  });

  it('rejects bad syncMode', () => {
    const recipe = makeRecipe();
    // @ts-expect-error deliberately invalid
    recipe.variables.syncMode = 'merge';
    expect(recipeSchema.safeParse(recipe).success).toBe(false);
  });

  it('rejects unknown keys (strict contract)', () => {
    const parsed = recipeSchema.safeParse({ ...makeRecipe(), surprise: true });
    expect(parsed.success).toBe(false);
  });
});
