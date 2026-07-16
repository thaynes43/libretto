import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import {
  RECIPE_ID_PATTERN,
  recipeSchema,
  zodIssuesToValidationIssues,
  type Recipe,
  type ValidationIssue,
} from './schema.js';

/**
 * File-backed recipe store: one YAML file per recipe under CONFIG_DIR/recipes,
 * filename = `${id}.yml`. No self-rewrite ever — the only write paths are the
 * explicit API save (PUT) and delete (DELETE), both of which validate first.
 */
export class RecipeStore {
  constructor(private readonly recipesDir: string) {}

  private fileFor(id: string): string {
    return path.join(this.recipesDir, `${id}.yml`);
  }

  private static assertValidId(id: string): void {
    if (!RECIPE_ID_PATTERN.test(id)) {
      throw new Error(`invalid recipe id: ${JSON.stringify(id)}`);
    }
  }

  /**
   * Read every recipe file. Valid recipes are returned; unparseable or invalid
   * files become issues instead of crashing the set (a bad file must not take
   * down its neighbors).
   */
  async list(): Promise<{ recipes: Recipe[]; issues: ValidationIssue[] }> {
    let entries: string[];
    try {
      entries = await readdir(this.recipesDir);
    } catch {
      return { recipes: [], issues: [] };
    }
    const recipes: Recipe[] = [];
    const issues: ValidationIssue[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
      const stem = entry.replace(/\.ya?ml$/, '');
      const result = await this.load(path.join(this.recipesDir, entry), stem);
      if ('recipe' in result) recipes.push(result.recipe);
      else issues.push(...result.issues);
    }
    return { recipes, issues };
  }

  async get(id: string): Promise<Recipe | undefined> {
    RecipeStore.assertValidId(id);
    const result = await this.load(this.fileFor(id), id);
    return 'recipe' in result ? result.recipe : undefined;
  }

  /** Explicit save: validates, then writes atomically (tmp file + rename). */
  async save(input: unknown): Promise<{ recipe: Recipe } | { issues: ValidationIssue[] }> {
    const parsed = recipeSchema.safeParse(input);
    if (!parsed.success) return { issues: zodIssuesToValidationIssues(parsed.error) };
    const recipe = parsed.data;
    await mkdir(this.recipesDir, { recursive: true });
    const file = this.fileFor(recipe.id);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, stringify(recipe), 'utf8');
    await rename(tmp, file);
    return { recipe };
  }

  /** Deletes the recipe file. The produced collection is orphaned, never touched. */
  async delete(id: string): Promise<boolean> {
    RecipeStore.assertValidId(id);
    try {
      await rm(this.fileFor(id));
      return true;
    } catch {
      return false;
    }
  }

  private async load(
    file: string,
    expectedId: string,
  ): Promise<{ recipe: Recipe } | { issues: ValidationIssue[] }> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return { issues: [] }; // missing file: not an issue, just absent
    }
    let doc: unknown;
    try {
      doc = parse(raw);
    } catch (error) {
      return {
        issues: [
          {
            recipeId: expectedId,
            path: '',
            message: `not parseable as YAML: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
    const parsed = recipeSchema.safeParse(doc);
    if (!parsed.success) {
      return { issues: zodIssuesToValidationIssues(parsed.error, expectedId) };
    }
    if (parsed.data.id !== expectedId) {
      return {
        issues: [
          {
            recipeId: expectedId,
            path: 'id',
            message: `recipe id ${JSON.stringify(parsed.data.id)} does not match its filename (expected ${JSON.stringify(expectedId)})`,
          },
        ],
      };
    }
    return { recipe: parsed.data };
  }
}
