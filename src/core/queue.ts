import { randomUUID } from 'node:crypto';
import type { BuilderContext } from '../builders/index.js';
import type { Logger } from '../logger.js';
import type { Recipe } from '../recipes/schema.js';
import type { RecipeStore } from '../recipes/store.js';
import type { RecipeRunResult, RunStatus, RunStore } from '../runs/store.js';
import type { TargetRegistry } from '../target/registry.js';
import { reconcileRecipe } from './reconciler.js';

export interface RunQueueDeps {
  recipeStore: RecipeStore;
  runStore: RunStore;
  targets: TargetRegistry;
  builders: BuilderContext;
  log: Logger;
}

function newRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * Serialized worker queue (DESIGN-037 D-11): one run executes at a time, ever —
 * no concurrent writes to a target. Cron ticks and /api/apply both enqueue here.
 */
export class RunQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RunQueueDeps) {}

  /** Enqueue a run; resolves with the runId as soon as the record exists. */
  async enqueue(scope: 'all' | string, trigger: 'api' | 'cron'): Promise<string> {
    const runId = newRunId();
    await this.deps.runStore.insert({
      id: runId,
      scope,
      trigger,
      startedAt: new Date().toISOString(),
      status: 'running',
      recipes: [],
    });
    this.tail = this.tail.then(() => this.execute(runId, scope));
    return runId;
  }

  /** Resolves once every run enqueued so far has finished (tests, shutdown). */
  async onIdle(): Promise<void> {
    let tail;
    do {
      tail = this.tail;
      await tail;
    } while (tail !== this.tail);
  }

  private async execute(runId: string, scope: 'all' | string): Promise<void> {
    const { recipeStore, runStore, targets, builders, log } = this.deps;
    const results: RecipeRunResult[] = [];
    let scopeError: string | undefined;
    try {
      let recipes: Recipe[];
      if (scope === 'all') {
        recipes = (await recipeStore.list()).recipes.filter((recipe) => recipe.enabled);
      } else {
        const recipe = await recipeStore.get(scope);
        if (!recipe) throw new Error(`recipe ${scope} not found (or invalid) at run time`);
        recipes = recipe.enabled ? [recipe] : [];
      }
      for (const recipe of recipes) {
        try {
          const target = targets.for(recipe.targetLibrary.server);
          results.push(await reconcileRecipe(recipe, target, log, builders));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error({ recipeId: recipe.id, err: error }, 'recipe reconcile failed');
          results.push({
            recipeId: recipe.id,
            counts: { matched: 0, matchedByTitle: 0, written: 0, added: 0, removed: 0, missing: 0 },
            missing: [],
            error: message,
          });
        }
      }
    } catch (error) {
      scopeError = error instanceof Error ? error.message : String(error);
      log.error({ runId, scope, err: error }, 'run failed');
    }

    const status = runStatus(results, scopeError);
    await runStore.update(runId, {
      finishedAt: new Date().toISOString(),
      status,
      recipes: results,
    });
    log.info({ runId, scope, status }, 'run finished');
  }
}

function runStatus(results: RecipeRunResult[], scopeError: string | undefined): RunStatus {
  if (scopeError !== undefined || results.some((result) => result.error !== undefined)) {
    return 'error';
  }
  // Honesty over magic (D-08): zero matches or any missing item flags the run warn
  // (the reconciler itself guarantees a zero-match run leaves the collection alone).
  if (results.some((result) => result.counts.matched === 0 || result.counts.missing > 0)) {
    return 'warn';
  }
  return 'ok';
}
