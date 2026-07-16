import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { builderInfos, type BuilderContext } from '../builders/index.js';
import type { AppConfig } from '../config.js';
import type { Scheduler } from '../core/scheduler.js';
import type { RunQueue } from '../core/queue.js';
import type { Logger } from '../logger.js';
import {
  recipeSchema,
  zodIssuesToValidationIssues,
  type ValidationIssue,
} from '../recipes/schema.js';
import type { RecipeStore } from '../recipes/store.js';
import type { RunStore } from '../runs/store.js';
import { recipeIdFromDescription } from '../target/marker.js';
import type { TargetRegistry } from '../target/registry.js';
import { TargetUnavailableError } from '../target/types.js';

export interface AppDeps {
  config: AppConfig;
  recipeStore: RecipeStore;
  runStore: RunStore;
  queue: RunQueue;
  scheduler: Scheduler;
  targets: TargetRegistry;
  builders: BuilderContext;
  log: Logger;
}

const applySchema = z.strictObject({
  scope: z.union([z.literal('all'), z.string().min(1)]),
});

const validateRequestSchema = z.union([
  z.strictObject({ all: z.literal(true) }),
  z.strictObject({ recipe: z.unknown() }),
]);

function keysMatch(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * REST surface (DESIGN-037 D-10, amended stateless): the five contract nouns —
 * recipes CRUD, validate, apply/runs, produced collections, missing[] (inside run
 * records in M1) — plus builders/targets discovery and an open /health.
 */
export function createApp(deps: AppDeps): Hono {
  const { config, recipeStore, runStore, queue, scheduler, targets, builders, log } = deps;
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok', service: 'libretto' }));

  const api = new Hono();

  api.use('*', async (c, next) => {
    if (config.apiKey === undefined) {
      return c.json(
        { error: 'LIBRETTO_API_KEY is not configured; the API is locked until it is set' },
        401,
      );
    }
    const header = c.req.header('authorization');
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!keysMatch(presented, config.apiKey)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  // --- Recipes: file-backed CRUD; PUT is the explicit save (the ONLY recipe writer).
  api.get('/recipes', async (c) => {
    const { recipes, issues } = await recipeStore.list();
    return c.json({ recipes, issues });
  });

  api.get('/recipes/:id', async (c) => {
    const recipe = await recipeStore.get(c.req.param('id')).catch(() => undefined);
    if (!recipe) {
      return c.json(
        { error: 'recipe not found (a present but invalid file is reported by GET /api/recipes)' },
        404,
      );
    }
    return c.json({ recipe });
  });

  api.put('/recipes/:id', async (c) => {
    const id = c.req.param('id');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'request body must be a recipe object' }, 400);
    }
    const candidate = { id, ...body } as Record<string, unknown>;
    if (candidate.id !== id) {
      return c.json(
        { issues: [{ recipeId: id, path: 'id', message: 'recipe id must match the URL id' }] },
        400,
      );
    }
    const result = await recipeStore.save(candidate);
    if ('issues' in result) return c.json({ issues: result.issues }, 400);
    await scheduler.reload();
    log.info({ recipeId: id }, 'recipe saved');
    return c.json({ recipe: result.recipe });
  });

  api.delete('/recipes/:id', async (c) => {
    const id = c.req.param('id');
    let deleted: boolean;
    try {
      deleted = await recipeStore.delete(id);
    } catch {
      return c.json({ error: 'invalid recipe id' }, 400);
    }
    if (!deleted) return c.json({ error: 'recipe not found' }, 404);
    await scheduler.reload();
    log.info({ recipeId: id }, 'recipe deleted; produced collection orphaned in the target');
    return c.body(null, 204);
  });

  // --- Validate: schema checks only in M1, mutating nothing.
  api.post('/validate', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    const request = validateRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json({ error: 'body must be { recipe: {...} } or { all: true }' }, 400);
    }
    let issues: ValidationIssue[];
    if ('all' in request.data) {
      issues = (await recipeStore.list()).issues;
    } else {
      const parsed = recipeSchema.safeParse(request.data.recipe);
      issues = parsed.success ? [] : zodIssuesToValidationIssues(parsed.error);
    }
    return c.json({ valid: issues.length === 0, issues });
  });

  // --- Apply + runs.
  api.post('/apply', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    const parsed = applySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'body must be { scope: "all" | "<recipeId>" }' }, 400);
    }
    const { scope } = parsed.data;
    if (scope !== 'all') {
      const recipe = await recipeStore.get(scope).catch(() => undefined);
      if (!recipe) return c.json({ error: `recipe ${scope} not found` }, 404);
      if (!recipe.enabled) return c.json({ error: `recipe ${scope} is disabled` }, 409);
    }
    const runId = await queue.enqueue(scope, 'api');
    return c.json({ runId }, 202);
  });

  api.get('/runs', async (c) => c.json({ runs: await runStore.list() }));

  api.get('/runs/:id', async (c) => {
    const run = await runStore.get(c.req.param('id'));
    if (!run) return c.json({ error: 'run not found (history keeps the last 50 runs)' }, 404);
    return c.json({ run });
  });

  // --- Produced collections: read back FROM the targets via the provenance marker.
  api.get('/collections', async (c) => {
    const { recipes } = await recipeStore.list();
    const scanned = new Set<string>();
    const collections: unknown[] = [];
    const issues: { server: string; libraryId: string; message: string }[] = [];
    for (const recipe of recipes) {
      const { server, libraryId } = recipe.targetLibrary;
      const key = `${server}:${libraryId}`;
      if (scanned.has(key)) continue;
      scanned.add(key);
      try {
        const target = targets.for(server);
        for (const collection of await target.listCollections(libraryId)) {
          const recipeId = recipeIdFromDescription(collection.description);
          if (recipeId === undefined) continue; // unmarked: not ours, not reported
          collections.push({
            server,
            libraryId,
            recipeId,
            targetCollectionId: collection.id,
            name: collection.name,
            itemCount: collection.itemIds.length,
            itemIds: collection.itemIds,
          });
        }
      } catch (error) {
        const message =
          error instanceof TargetUnavailableError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        issues.push({ server, libraryId, message });
      }
    }
    return c.json({ collections, issues });
  });

  // --- Discovery.
  api.get('/builders', (c) => c.json({ builders: builderInfos(builders) }));
  api.get('/targets', (c) => c.json({ targets: targets.statuses() }));

  app.route('/api', api);
  return app;
}
