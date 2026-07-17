import { z } from 'zod';
import { Cron } from 'croner';

/**
 * The Recipe shape is the provider-parity contract noun from DESIGN-037 D-02, verbatim:
 * { id, targetLibrary, name, builder { type, ref }, variables
 *   { syncMode, ordered, acquisitionEnabled, tag, schedule }, enabled }
 *
 * Recipes are YAML files in CONFIG_DIR/recipes, one file per recipe, filename = id.
 * Libretto never rewrites them on its own; the only writer is the explicit API save.
 */

/** Recipe ids double as filenames, so keep them filesystem- and URL-safe. */
export const RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function isValidCronExpression(value: string): boolean {
  try {
    const probe = new Cron(value, { paused: true });
    probe.stop();
    return true;
  } catch {
    return false;
  }
}

const scheduleSchema = z.union([
  z.literal('manual'),
  z
    .string()
    .refine(isValidCronExpression, 'must be a valid cron expression or the string "manual"'),
]);

const targetLibrarySchema = z.strictObject({
  server: z.enum(['kavita', 'abs']),
  libraryId: z.string().min(1),
});

/**
 * Builder set (DESIGN-037 D-05): static_ids (the tracer — the ref IS the ordered
 * identifier list), hardcover_series (the ref is a Hardcover series id or slug;
 * works come back ordered by series position), and nyt_list (the ref is a NYT
 * list_name_encoded slug; works come back ordered by bestseller rank). The
 * provenance-derivation contract keeps the type string exactly `nyt_list`.
 * wikidata_award arrives later.
 */
const builderSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('static_ids'),
    ref: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    type: z.literal('hardcover_series'),
    ref: z.union([z.string().min(1), z.number().int().positive()]),
  }),
  z.strictObject({
    type: z.literal('nyt_list'),
    ref: z.string().min(1),
  }),
]);

const variablesSchema = z.strictObject({
  syncMode: z.enum(['append', 'sync']),
  ordered: z.boolean(),
  acquisitionEnabled: z.boolean().default(false),
  /**
   * D-04 conservative title fallback: when identifier matching leaves a work
   * unmatched, try a noise-stripped exact-title (+ author guard) match. Default
   * on; set false to pin a recipe to identifier-only matching. Title-matched
   * items are flagged in the run counts (matchedByTitle).
   */
  titleFallback: z.boolean().default(true),
  tag: z.string().min(1).optional(),
  schedule: scheduleSchema,
});

export const recipeSchema = z.strictObject({
  id: z.string().regex(RECIPE_ID_PATTERN, 'id must match ' + RECIPE_ID_PATTERN.source),
  targetLibrary: targetLibrarySchema,
  name: z.string().min(1),
  builder: builderSchema,
  variables: variablesSchema,
  enabled: z.boolean(),
});

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeInput = z.input<typeof recipeSchema>;

/** A single validation finding, shaped for the /api/validate issues[] response. */
export interface ValidationIssue {
  /** Recipe id (or filename stem) the issue belongs to, when known. */
  recipeId?: string;
  /** JSON-ish path into the recipe document, '' for document-level issues. */
  path: string;
  message: string;
}

export function zodIssuesToValidationIssues(
  error: z.ZodError,
  recipeId?: string,
): ValidationIssue[] {
  return error.issues.map((issue) => ({
    ...(recipeId === undefined ? {} : { recipeId }),
    path: issue.path.join('.'),
    message: issue.message,
  }));
}
