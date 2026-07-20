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
 * works come back ordered by series position, at BOOK/work grain), nyt_list (the
 * ref is a NYT list_name_encoded slug; works come back ordered by bestseller
 * rank), and hardcover_comics (the ref is an ARRAY of Hardcover series ids/slugs;
 * each resolves to ONE SERIES-grain unit matched by name — the comics grain, see
 * the matchGrain note below). The provenance-derivation contract keeps the type
 * string exactly `nyt_list`. wikidata_award arrives later.
 *
 * WHY A SEPARATE COMICS BUILDER (the proven gap, 2026-07-20): Kavita's membership
 * unit is the SERIES — it stores a whole comic ("Invincible", "Scott Pilgrim") as
 * ONE series holding its volumes as chapters. hardcover_series emits per-VOLUME
 * works ("Invincible, Vol. 1: Family Matters"), so matching a Hardcover work
 * against a Kavita series hits 0/N, and comics expose no scheme'd ISBNs so the
 * identifier path is dead too. hardcover_comics matches at SERIES grain instead:
 * the Hardcover series NAME against the Kavita series name (conservative,
 * noise-stripped, ambiguity-refusing — the same D-04 index). One-or-more series
 * per recipe build a Kavita COLLECTION of those series (an "Invincible Universe" =
 * Invincible + Guarding the Globe). Comics acquisition is out of scope (Kapowarr-
 * land), so acquisitionEnabled is a validation error on this builder (see below).
 */
export const builderSchema = z.discriminatedUnion('type', [
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
  z.strictObject({
    type: z.literal('hardcover_comics'),
    ref: z.array(z.union([z.string().min(1), z.number().int().positive()])).min(1),
  }),
]);

/** Builder types that match at SERIES grain (Hardcover series name -> target series). */
const SERIES_GRAIN_BUILDERS = new Set(['hardcover_comics']);

/** Whether a recipe's builder matches at series grain (comics) rather than work grain. */
export function isSeriesGrain(builder: Builder): boolean {
  return SERIES_GRAIN_BUILDERS.has(builder.type);
}

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

export const recipeSchema = z
  .strictObject({
    id: z.string().regex(RECIPE_ID_PATTERN, 'id must match ' + RECIPE_ID_PATTERN.source),
    targetLibrary: targetLibrarySchema,
    name: z.string().min(1),
    builder: builderSchema,
    variables: variablesSchema,
    enabled: z.boolean(),
  })
  .superRefine((recipe, ctx) => {
    // Comics recipes are GROUPING-ONLY: comics acquisition is Kapowarr-land and
    // explicitly out of Libretto's scope (the app excludes comics from force-
    // search). Fail fast rather than silently no-op, so the intent is honest.
    if (isSeriesGrain(recipe.builder) && recipe.variables.acquisitionEnabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['variables', 'acquisitionEnabled'],
        message:
          'comics recipes (hardcover_comics) cannot acquire — comics acquisition is out of scope; set acquisitionEnabled: false',
      });
    }
  });

export type Builder = z.infer<typeof builderSchema>;
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
