import { acquireMissing, type AcquireContext } from '../acquire/acquire.js';
import type { LlFormat } from '../acquire/lazylibrarian.js';
import { resolveBuilder, type BuilderContext, type WorkItem } from '../builders/index.js';
import { isSeriesGrain, type Recipe, type Target } from '../recipes/schema.js';
import type { RecipeRunResult } from '../runs/store.js';
import {
  buildCollectionDescription,
  provenanceMarker,
  recipeIdFromDescription,
  withUpdatedMarker,
} from '../target/marker.js';
import type { TargetRegistry } from '../target/registry.js';
import { TargetUnavailableError, type TargetClient } from '../target/types.js';
import type { Logger } from '../logger.js';
import { matchWorks } from './match.js';

/**
 * Reconcile a recipe against its targets (DESIGN-037 D-04/D-07/D-08 + ADR-076 multi-target):
 *
 *   builder -> ONE ordered work list -> for EACH target: match against its library by identifier
 *   (then the D-04 title fallback) -> recover the owned collection via the provenance marker ->
 *   diff -> write per syncMode -> report per-(recipe, target) counts + missing[].
 *
 * MULTI-TARGET (ADR-076): the SAME builder output is applied to every target the recipe declares,
 * each carrying the SAME marker `[libretto:<recipeId>|cat=<Category>]` (the shared merge key). The
 * per-target kind mapping is unchanged (Kavita ordered => reading list / unordered => collection;
 * ABS => collection). One recipe therefore yields ONE RecipeRunResult per target, each tagging its
 * target and its own missing[] (the works missing FROM that target).
 *
 * Ownership rules made structural (per target):
 *   - the owned collection is the one whose description carries this recipe's marker — renames do
 *     not break ownership; a collection without the marker is NEVER touched, same name or not;
 *   - append never removes; sync reconciles full membership and (when ordered) positions;
 *   - unmatched work goes to missing[] — nothing is fabricated.
 */

/** Which LazyLibrarian format a target acquires: Kavita -> eBooks, ABS -> AudioBooks (ADR-076 C-05). */
function formatFor(server: Target['server']): LlFormat {
  return server === 'abs' ? 'audiobook' : 'ebook';
}

/**
 * Reconcile ONE recipe against ONE resolved target client (the multi-target primitive). `works`
 * is the recipe's builder output, resolved once by the caller and shared across targets.
 */
export async function reconcileTarget(
  recipe: Recipe,
  targetLib: Target,
  target: TargetClient,
  works: WorkItem[],
  log: Logger,
  acquire?: AcquireContext,
): Promise<RecipeRunResult> {
  const { libraryId, server } = targetLib;
  const items = await target.listItems(libraryId);

  // Match grain (comics support): series-grain recipes (hardcover_comics) pair a whole Hardcover
  // series to one target series by conservative NAME equality; work-grain recipes pair each book by
  // identifier then the D-04 title fallback. Both go through the single shared matcher (core/match.ts)
  // the missing endpoint also uses, so a member counted `missing` here is exactly one it reports.
  const grain = isSeriesGrain(recipe.builder) ? 'series' : 'work';
  const { matchedIds, matchedSeen, matchedByTitle, missingWorks } = matchWorks(works, items, {
    titleFallback: recipe.variables.titleFallback,
    grain,
  });
  const missing = missingWorks.map((work) => work.label);
  if (matchedByTitle > 0) {
    log.info(
      { recipeId: recipe.id, server, matchedByTitle },
      grain === 'series'
        ? 'matched by conservative series-name equality'
        : 'matched by conservative title/author fallback (no identifier hit)',
    );
  }

  const collections = await target.listCollections(libraryId);
  const owned = collections.filter(
    (collection) => recipeIdFromDescription(collection.description) === recipe.id,
  );
  if (owned.length > 1) {
    log.warn(
      { recipeId: recipe.id, server, collectionIds: owned.map((c) => c.id) },
      'multiple collections carry this recipe marker; reconciling the first only',
    );
  }
  const collection = owned[0];

  let written: number;
  let added: number;
  let removed: number;

  if (matchedIds.length === 0) {
    // Zero-match honesty (D-08): never create an empty collection and never let a zero-match sync
    // wipe an existing one. The run is flagged warn; membership is left exactly as it was.
    log.warn({ recipeId: recipe.id, server }, 'zero matches; leaving the collection alone');
    written = collection?.itemIds.length ?? 0;
    added = 0;
    removed = 0;
  } else if (!collection) {
    const created = await target.createCollection({
      libraryId,
      name: recipe.name,
      // Marker carries the shared recipe id + the recipe-authored category (ADR-076 C-02).
      description: buildCollectionDescription(recipe.id, recipe.category),
      ...(recipe.variables.tag === undefined ? {} : { tags: [recipe.variables.tag] }),
      itemIds: matchedIds,
      ordered: recipe.variables.ordered,
    });
    log.info({ recipeId: recipe.id, server, collectionId: created.id }, 'created collection');
    written = created.itemIds.length;
    added = created.itemIds.length;
    removed = 0;
  } else {
    const current = collection.itemIds;
    const currentSet = new Set(current);
    let desired: string[];
    if (recipe.variables.syncMode === 'append') {
      // Append: adds only, never removes; new items positioned at the end.
      desired = [...current, ...matchedIds.filter((id) => !currentSet.has(id))];
      removed = 0;
    } else {
      // Sync: full membership reconcile. Ordered recipes also enforce source positions; unordered
      // ones keep the target's relative order for retained items and append new ones (order written
      // once, not maintained — D-07).
      if (recipe.variables.ordered) {
        desired = matchedIds;
      } else {
        const retained = current.filter((id) => matchedSeen.has(id));
        const retainedSet = new Set(retained);
        desired = [...retained, ...matchedIds.filter((id) => !retainedSet.has(id))];
      }
      removed = current.filter((id) => !matchedSeen.has(id)).length;
    }
    added = desired.filter((id) => !currentSet.has(id)).length;
    // Marker re-sync (ADR-076 C-02): if the recipe's category was set/changed on an
    // already-produced collection, re-write the marker token too (preserving surrounding prose).
    // A category-free, unchanged recipe never touches the description (historical behavior).
    const markerChanged = !collection.description.includes(
      provenanceMarker(recipe.id, recipe.category),
    );
    const membershipChanged = !sameOrder(desired, current);
    if (membershipChanged || markerChanged) {
      await target.updateCollection(collection.id, {
        itemIds: desired,
        ...(markerChanged
          ? { description: withUpdatedMarker(collection.description, recipe.id, recipe.category) }
          : {}),
      });
      log.info(
        { recipeId: recipe.id, server, collectionId: collection.id, added, removed, markerChanged },
        'updated collection',
      );
    }
    written = desired.length;
  }

  // Per-target acquisition leg (ADR-076 C-05): the missing[] FROM THIS target feeds LazyLibrarian
  // in this target's format (kavita -> eBook, abs -> AudioBook). Gated on variables.acquisitionEnabled
  // AND LazyLibrarian being configured. Confinement + pacing are UNCHANGED — see acquire/acquire.ts.
  let acquisition: RecipeRunResult['acquisition'];
  if (recipe.variables.acquisitionEnabled) {
    if (acquire) {
      acquisition = await acquireMissing(recipe.id, missingWorks, formatFor(server), acquire, log);
    } else {
      log.warn(
        { recipeId: recipe.id, server },
        'acquisitionEnabled but LazyLibrarian is not configured (set LAZYLIBRARIAN_URL and LAZYLIBRARIAN_API_KEY); acquisition skipped',
      );
    }
  }

  return {
    recipeId: recipe.id,
    target: { server, libraryId },
    counts: {
      matched: matchedIds.length,
      matchedByTitle,
      written,
      added,
      removed,
      missing: missing.length,
    },
    missing,
    ...(acquisition ? { acquisition } : {}),
  };
}

/**
 * Reconcile a recipe against ALL its targets via the registry (the queue's entry point, ADR-076).
 * Resolves the builder ONCE and applies it to each target, tolerating a per-target failure (a target
 * being unavailable never blanks the others). Returns one RecipeRunResult per target.
 */
export async function reconcileRecipeTargets(
  recipe: Recipe,
  targets: TargetRegistry,
  log: Logger,
  builderCtx: BuilderContext = {},
  acquire?: AcquireContext,
): Promise<RecipeRunResult[]> {
  let works: WorkItem[];
  try {
    works = await resolveBuilder(recipe.builder, builderCtx);
  } catch (error) {
    // A builder-wide failure (e.g. HARDCOVER_TOKEN unset, ref did not resolve) fails EVERY target;
    // report one error row per target so the run still carries the per-target shape.
    const message = error instanceof Error ? error.message : String(error);
    log.error({ recipeId: recipe.id, err: error }, 'builder resolution failed');
    return recipe.targets.map((targetLib) => errorResult(recipe.id, targetLib, message));
  }

  const results: RecipeRunResult[] = [];
  for (const targetLib of recipe.targets) {
    try {
      const target = targets.for(targetLib.server);
      results.push(await reconcileTarget(recipe, targetLib, target, works, log, acquire));
    } catch (error) {
      const message =
        error instanceof TargetUnavailableError || error instanceof Error
          ? error.message
          : String(error);
      log.error(
        { recipeId: recipe.id, server: targetLib.server, err: error },
        'recipe reconcile failed for target',
      );
      results.push(errorResult(recipe.id, targetLib, message));
    }
  }
  return results;
}

/**
 * Reconcile a recipe against ONE resolved target client (single-target convenience): resolves the
 * builder and reconciles the recipe's FIRST target against `target`. Kept for single-target callers
 * and focused tests; the queue drives all targets through reconcileRecipeTargets.
 */
export async function reconcileRecipe(
  recipe: Recipe,
  target: TargetClient,
  log: Logger,
  builderCtx: BuilderContext = {},
  acquire?: AcquireContext,
): Promise<RecipeRunResult> {
  const works = await resolveBuilder(recipe.builder, builderCtx);
  const targetLib = recipe.targets[0]!; // the schema guarantees at least one target
  return reconcileTarget(recipe, targetLib, target, works, log, acquire);
}

function errorResult(recipeId: string, targetLib: Target, message: string): RecipeRunResult {
  return {
    recipeId,
    target: { server: targetLib.server, libraryId: targetLib.libraryId },
    counts: { matched: 0, matchedByTitle: 0, written: 0, added: 0, removed: 0, missing: 0 },
    missing: [],
    error: message,
  };
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
