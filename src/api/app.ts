import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { builderInfos, type BuilderContext } from '../builders/index.js';
import type { AppConfig } from '../config.js';
import type { Scheduler } from '../core/scheduler.js';
import type { RunQueue } from '../core/queue.js';
import type { Logger } from '../logger.js';
import {
  builderSchema,
  recipeSchema,
  zodIssuesToValidationIssues,
  type ValidationIssue,
} from '../recipes/schema.js';
import type { RecipeStore } from '../recipes/store.js';
import type { RunStore } from '../runs/store.js';
import { recipeIdFromDescription } from '../target/marker.js';
import type { TargetRegistry } from '../target/registry.js';
import { TargetUnavailableError } from '../target/types.js';
import {
  BuilderUnavailableError,
  resolveBuilder,
  searchBuilder,
  UnknownBuilderError,
} from '../builders/index.js';
import { matchWorks, toMissingMember, toPreviewMember } from '../core/match.js';
import type { ResolveBroker } from '../resolve/broker.js';

export interface AppDeps {
  config: AppConfig;
  recipeStore: RecipeStore;
  runStore: RunStore;
  queue: RunQueue;
  scheduler: Scheduler;
  targets: TargetRegistry;
  builders: BuilderContext;
  /** ISBN-first resolve broker (M3 direction-a); undefined when GOOGLE_BOOKS_API_KEY is unset. */
  resolve: ResolveBroker | undefined;
  log: Logger;
}

const resolveSchema = z.strictObject({
  isbn: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  identifiers: z.array(z.string().min(1)).optional(),
});

/** Default + hard ceiling on typeahead search hits (the client debounces; we cap counts). */
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 25;
/** Default + hard ceiling on preview members (the app applies the per-user cap on top). */
const PREVIEW_DEFAULT_LIMIT = 100;
const PREVIEW_MAX_LIMIT = 100;

const previewSchema = z.strictObject({
  builder: builderSchema,
  limit: z.number().int().positive().max(PREVIEW_MAX_LIMIT).optional(),
});

/** Parse a bounded positive-int query param, falling back to `fallback`, clamped to `max`. */
function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
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
  const { config, recipeStore, runStore, queue, scheduler, targets, builders, resolve, log } = deps;
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

  // --- Member-level missing: the wanted-but-unheld member IDENTITIES for one recipe (title/author/
  // ISBN/identifier refs), so a consumer can mint one request row per missing book. Libretto knows each
  // recipe's FULL resolved membership (builder work list) and which are held (matched against the target
  // library by the SAME matcher the reconcile uses) — the difference is the missing[] reported here.
  api.get('/collections/:recipeId/missing', async (c) => {
    const recipeId = c.req.param('recipeId');
    const recipe = await recipeStore.get(recipeId).catch(() => undefined);
    if (!recipe) return c.json({ error: `recipe ${recipeId} not found` }, 404);

    let works;
    try {
      works = await resolveBuilder(recipe.builder, builders);
    } catch (error) {
      // The builder source is unavailable (e.g. HARDCOVER_TOKEN unset, or the ref did not resolve) —
      // report it honestly rather than pretend the whole membership is missing.
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }

    const { libraryId, server } = recipe.targetLibrary;
    try {
      const items = await targets.for(server).listItems(libraryId);
      const { matchedIds, missingWorks } = matchWorks(works, items, recipe.variables.titleFallback);
      return c.json({
        recipeId: recipe.id,
        server,
        libraryId,
        name: recipe.name,
        total: works.length,
        heldCount: matchedIds.length,
        missingCount: missingWorks.length,
        missing: missingWorks.map(toMissingMember),
      });
    } catch (error) {
      const message =
        error instanceof TargetUnavailableError || error instanceof Error
          ? error.message
          : String(error);
      return c.json({ error: message }, 502);
    }
  });

  // --- Resolve broker (M3 direction-a): resolve an ISBN|title+author to a Google-Books volume id
  // (the LazyLibrarian addBook key), ISBN-first with a guarded title fallback. Mutates NOTHING — a
  // reusable resolution service. 200 { resolved: null } is an honest no-match (not an error); 503 when
  // the broker is not configured (GOOGLE_BOOKS_API_KEY unset).
  api.post('/resolve', async (c) => {
    if (!resolve) {
      return c.json({ error: 'resolve broker not configured (set GOOGLE_BOOKS_API_KEY)' }, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    const parsed = resolveSchema.safeParse(body);
    if (
      !parsed.success ||
      (!parsed.data.title && !parsed.data.isbn && !parsed.data.identifiers?.length)
    ) {
      return c.json({ error: 'body must carry at least one of { isbn, title, identifiers }' }, 400);
    }
    const { isbn, title, author, identifiers } = parsed.data;
    const resolved = await resolve.resolve({
      ...(isbn === undefined ? {} : { isbn }),
      ...(identifiers === undefined ? {} : { identifiers }),
      ...(author === undefined ? {} : { authors: [author] }),
      title: title ?? '',
    });
    return c.json({ resolved });
  });

  // --- Search: typeahead for a builder's ref (M4 builder page). Find the series/list by
  // typing a name so a user never pastes a slug. `hardcover_series` proxies Hardcover's search
  // (bounded, cached); `nyt_list` filters the static well-known list names (no key, no external
  // call); `static_ids` has no searchable ref (empty). Unknown type -> 400; unconfigured source
  // -> 503. The client owns debounce; result counts are capped server-side.
  api.get('/search', async (c) => {
    const type = c.req.query('type');
    const q = c.req.query('q') ?? '';
    const limit = clampLimit(c.req.query('limit'), SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
    if (!type) return c.json({ error: 'query param "type" is required' }, 400);
    try {
      const { results, truncated } = await searchBuilder(type, q, limit, builders);
      return c.json({ type, query: q.trim(), results, truncated });
    } catch (error) {
      if (error instanceof UnknownBuilderError) return c.json({ error: error.message }, 400);
      if (error instanceof BuilderUnavailableError) return c.json({ error: error.message }, 503);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // --- Preview: the MEMBER-LEVEL identities a draft builder would resolve to (M4 builder page),
  // so the app can split held vs missing against its own mirrors BEFORE save. Resolves an UNSAVED
  // builder (no recipe id / target needed); mutates NOTHING. Bounded at PREVIEW_MAX_LIMIT members
  // with an honest `truncated` flag (the app applies the per-user size cap on top). A 0-member
  // container slug comes back total:0 honestly. 502 when the builder source is unavailable.
  api.post('/preview', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    const parsed = previewSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'body must be { builder: {...}, limit? }',
          issues: zodIssuesToValidationIssues(parsed.error),
        },
        400,
      );
    }
    const limit = parsed.data.limit ?? PREVIEW_DEFAULT_LIMIT;
    let works;
    try {
      works = await resolveBuilder(parsed.data.builder, builders);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
    return c.json({
      builder: parsed.data.builder,
      total: works.length,
      truncated: works.length > limit,
      members: works.slice(0, limit).map(toPreviewMember),
    });
  });

  // --- Discovery.
  api.get('/builders', (c) => c.json({ builders: builderInfos(builders) }));
  api.get('/targets', (c) => c.json({ targets: targets.statuses() }));

  app.route('/api', api);
  return app;
}
