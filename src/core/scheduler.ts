import { Cron } from 'croner';
import type { Logger } from '../logger.js';
import type { RecipeStore } from '../recipes/store.js';
import type { RunQueue } from './queue.js';

/**
 * In-process cron (DESIGN-037 D-11): each enabled recipe with a cron schedule gets
 * a croner job that enqueues an apply for that recipe; 'manual' recipes only run
 * via POST /api/apply. Runs serialize through the RunQueue regardless of trigger.
 * Missed ticks on restart are skipped, not replayed — recipes are reconcilers.
 */
export class Scheduler {
  private jobs: Cron[] = [];

  constructor(
    private readonly recipeStore: RecipeStore,
    private readonly queue: RunQueue,
    private readonly log: Logger,
  ) {}

  /** Rebuild all cron jobs from the recipe files (called at boot and after CRUD). */
  async reload(): Promise<void> {
    this.stop();
    const { recipes } = await this.recipeStore.list();
    for (const recipe of recipes) {
      if (!recipe.enabled || recipe.variables.schedule === 'manual') continue;
      const recipeId = recipe.id;
      const job = new Cron(recipe.variables.schedule, { name: recipeId, protect: true }, () => {
        void this.queue
          .enqueue(recipeId, 'cron')
          .catch((error: unknown) =>
            this.log.error({ recipeId, err: error }, 'failed to enqueue scheduled run'),
          );
      });
      this.jobs.push(job);
      this.log.info(
        { recipeId, schedule: recipe.variables.schedule },
        'scheduled recipe reconcile',
      );
    }
  }

  stop(): void {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
  }
}
