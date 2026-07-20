import { acquireMissing, type AcquireContext } from '../acquire/acquire.js';
import type { LlFormat } from '../acquire/lazylibrarian.js';
import { resolveBuilder, type BuilderContext } from '../builders/index.js';
import { isSeriesGrain, type Recipe } from '../recipes/schema.js';
import type { RecipeRunResult } from '../runs/store.js';
import { buildCollectionDescription, recipeIdFromDescription } from '../target/marker.js';
import type { TargetClient } from '../target/types.js';
import type { Logger } from '../logger.js';
import { matchWorks } from './match.js';

/**
 * Reconcile one recipe against its target (DESIGN-037 D-04/D-07/D-08, amended
 * stateless):
 *
 *   builder -> ordered work list -> match against library items by identifier ->
 *   recover the owned collection via the provenance marker -> diff -> write per
 *   syncMode -> report counts + missing[].
 *
 * Ownership rules made structural:
 *   - the owned collection is the one whose description carries this recipe's
 *     marker — renames do not break ownership;
 *   - a collection without the marker is NEVER touched, same name or not;
 *   - append never removes; sync reconciles full membership and (when ordered)
 *     positions;
 *   - unmatched work goes to missing[] — nothing is fabricated.
 */
export async function reconcileRecipe(
  recipe: Recipe,
  target: TargetClient,
  log: Logger,
  builderCtx: BuilderContext = {},
  acquire?: AcquireContext,
): Promise<RecipeRunResult> {
  const { libraryId } = recipe.targetLibrary;
  const works = await resolveBuilder(recipe.builder, builderCtx);
  const items = await target.listItems(libraryId);

  // Match grain (comics support): series-grain recipes (hardcover_comics) pair a whole Hardcover
  // series to one target series by conservative NAME equality; work-grain recipes pair each book by
  // identifier then the D-04 title fallback (default on, per-recipe opt-out via titleFallback). Both
  // go through the single shared matcher (core/match.ts) that the missing endpoint also uses, so a
  // member counted `missing` here is exactly one the endpoint reports.
  const grain = isSeriesGrain(recipe.builder) ? 'series' : 'work';
  const { matchedIds, matchedSeen, matchedByTitle, missingWorks } = matchWorks(works, items, {
    titleFallback: recipe.variables.titleFallback,
    grain,
  });
  const missing = missingWorks.map((work) => work.label);
  if (matchedByTitle > 0) {
    log.info(
      { recipeId: recipe.id, matchedByTitle },
      grain === 'series'
        ? 'matched by conservative series-name equality'
        : 'matched by conservative title fallback (no identifier hit)',
    );
  }

  const collections = await target.listCollections(libraryId);
  const owned = collections.filter(
    (collection) => recipeIdFromDescription(collection.description) === recipe.id,
  );
  if (owned.length > 1) {
    log.warn(
      { recipeId: recipe.id, collectionIds: owned.map((c) => c.id) },
      'multiple collections carry this recipe marker; reconciling the first only',
    );
  }
  const collection = owned[0];

  let written: number;
  let added: number;
  let removed: number;

  if (matchedIds.length === 0) {
    // Zero-match honesty (D-08): never create an empty collection and never let a
    // zero-match sync wipe an existing one. The run is flagged warn; membership is
    // left exactly as it was.
    log.warn({ recipeId: recipe.id }, 'zero matches; leaving the collection alone');
    written = collection?.itemIds.length ?? 0;
    added = 0;
    removed = 0;
  } else if (!collection) {
    const created = await target.createCollection({
      libraryId,
      name: recipe.name,
      description: buildCollectionDescription(recipe.id),
      ...(recipe.variables.tag === undefined ? {} : { tags: [recipe.variables.tag] }),
      itemIds: matchedIds,
      ordered: recipe.variables.ordered,
    });
    log.info({ recipeId: recipe.id, collectionId: created.id }, 'created collection');
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
      // Sync: full membership reconcile. Ordered recipes also enforce source
      // positions; unordered ones keep the target's relative order for retained
      // items and append new ones (order written once, not maintained — D-07).
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
    if (!sameOrder(desired, current)) {
      await target.updateCollection(collection.id, { itemIds: desired });
      log.info(
        { recipeId: recipe.id, collectionId: collection.id, added, removed },
        'updated collection membership',
      );
    }
    written = desired.length;
  }

  // M3 acquisition leg: wire missing[] into LazyLibrarian so the recipe ACQUIRES. Gated on the
  // recipe's variables.acquisitionEnabled (default false — the coordinator does the controlled
  // rollout) AND LazyLibrarian being configured. Kavita recipes acquire eBooks; ABS recipes
  // AudioBooks. Best-effort and stateless: it never fails the reconcile, and re-runs are idempotent
  // (LazyLibrarian is the ledger). See acquire/acquire.ts for the mechanism.
  let acquisition: RecipeRunResult['acquisition'];
  if (recipe.variables.acquisitionEnabled) {
    if (acquire) {
      const format: LlFormat = recipe.targetLibrary.server === 'abs' ? 'audiobook' : 'ebook';
      acquisition = await acquireMissing(recipe.id, missingWorks, format, acquire, log);
    } else {
      log.warn(
        { recipeId: recipe.id },
        'acquisitionEnabled but LazyLibrarian is not configured (set LAZYLIBRARIAN_URL and LAZYLIBRARIAN_API_KEY); acquisition skipped',
      );
    }
  }

  return {
    recipeId: recipe.id,
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

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
