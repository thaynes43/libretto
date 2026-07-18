import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import { loadConfig } from '../config.js';
import { RunQueue } from '../core/queue.js';
import { Scheduler } from '../core/scheduler.js';
import { RecipeStore } from '../recipes/store.js';
import { RunStore, type RunRecord } from '../runs/store.js';
import {
  makeRecipe,
  makeSeededTarget,
  makeTempDir,
  registryFor,
  silentLogger,
} from '../testing/fixtures.js';

const KEY = 'test-api-key';
const auth = { authorization: `Bearer ${KEY}` };
const jsonHeaders = { ...auth, 'content-type': 'application/json' };

describe('API', () => {
  let app: Hono;
  let cleanup: () => Promise<void>;
  let queue: RunQueue;
  let scheduler: Scheduler;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    const config = loadConfig({
      CONFIG_DIR: tmp.dir,
      LIBRETTO_API_KEY: KEY,
    } as NodeJS.ProcessEnv);
    const recipeStore = new RecipeStore(config.recipesDir);
    const runStore = new RunStore(config.runsFile);
    const targets = registryFor(makeSeededTarget());
    queue = new RunQueue({ recipeStore, runStore, targets, builders: {}, log: silentLogger });
    scheduler = new Scheduler(recipeStore, queue, silentLogger);
    app = createApp({
      config,
      recipeStore,
      runStore,
      queue,
      scheduler,
      targets,
      builders: {},
      resolve: undefined,
      log: silentLogger,
    });
  });

  afterEach(async () => {
    scheduler.stop();
    await cleanup();
  });

  describe('auth', () => {
    it('serves /health without a key', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', service: 'libretto' });
    });

    it('rejects /api requests without a key', async () => {
      const res = await app.request('/api/recipes');
      expect(res.status).toBe(401);
    });

    it('rejects a wrong key', async () => {
      const res = await app.request('/api/recipes', {
        headers: { authorization: 'Bearer wrong' },
      });
      expect(res.status).toBe(401);
    });

    it('locks the whole API when no key is configured', async () => {
      const tmp = await makeTempDir();
      const config = loadConfig({ CONFIG_DIR: tmp.dir } as NodeJS.ProcessEnv);
      const recipeStore = new RecipeStore(config.recipesDir);
      const runStore = new RunStore(config.runsFile);
      const targets = registryFor(makeSeededTarget());
      const q = new RunQueue({ recipeStore, runStore, targets, builders: {}, log: silentLogger });
      const s = new Scheduler(recipeStore, q, silentLogger);
      const lockedApp = createApp({
        config,
        recipeStore,
        runStore,
        queue: q,
        scheduler: s,
        targets,
        builders: {},
        resolve: undefined,
        log: silentLogger,
      });
      const res = await lockedApp.request('/api/recipes', { headers: auth });
      expect(res.status).toBe(401);
      s.stop();
      await tmp.cleanup();
    });
  });

  describe('recipes CRUD', () => {
    it('PUT validates and saves, GET reads back, DELETE removes', async () => {
      const recipe = makeRecipe({ id: 'crud-recipe' });
      const { id: _id, ...body } = recipe;

      const put = await app.request('/api/recipes/crud-recipe', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ recipe });

      const get = await app.request('/api/recipes/crud-recipe', { headers: auth });
      expect(get.status).toBe(200);
      expect(await get.json()).toEqual({ recipe });

      const list = await app.request('/api/recipes', { headers: auth });
      expect(((await list.json()) as { recipes: unknown[] }).recipes).toHaveLength(1);

      const del = await app.request('/api/recipes/crud-recipe', {
        method: 'DELETE',
        headers: auth,
      });
      expect(del.status).toBe(204);
      const after = await app.request('/api/recipes/crud-recipe', { headers: auth });
      expect(after.status).toBe(404);
    });

    it('PUT rejects an invalid recipe with issues[] and a 400', async () => {
      const res = await app.request('/api/recipes/bad-recipe', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ name: 'incomplete' }),
      });
      expect(res.status).toBe(400);
      const { issues } = (await res.json()) as { issues: unknown[] };
      expect(issues.length).toBeGreaterThan(0);
    });

    it('PUT rejects a body id that contradicts the URL id', async () => {
      const { id: _id, ...body } = makeRecipe();
      const res = await app.request('/api/recipes/url-id', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ ...body, id: 'other-id' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('validate', () => {
    it('validates a single recipe draft', async () => {
      const good = await app.request('/api/validate', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ recipe: makeRecipe() }),
      });
      expect(await good.json()).toEqual({ valid: true, issues: [] });

      const bad = await app.request('/api/validate', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ recipe: { id: 'nope' } }),
      });
      const badBody = (await bad.json()) as { valid: boolean; issues: unknown[] };
      expect(badBody.valid).toBe(false);
      expect(badBody.issues.length).toBeGreaterThan(0);
    });

    it('validates the full set from disk with { all: true }', async () => {
      const res = await app.request('/api/validate', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ all: true }),
      });
      expect(await res.json()).toEqual({ valid: true, issues: [] });
    });
  });

  describe('apply and runs', () => {
    it('applies a recipe end-to-end and exposes the run + produced collection', async () => {
      const recipe = makeRecipe({
        id: 'wire-recipe',
        builder: { type: 'static_ids', ref: ['isbn:2', 'isbn:1', 'isbn:404'] },
      });
      const { id: _id, ...body } = recipe;
      await app.request('/api/recipes/wire-recipe', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });

      const apply = await app.request('/api/apply', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ scope: 'wire-recipe' }),
      });
      expect(apply.status).toBe(202);
      const { runId } = (await apply.json()) as { runId: string };
      expect(runId).toBeTruthy();
      await queue.onIdle();

      const runRes = await app.request(`/api/runs/${runId}`, { headers: auth });
      const { run } = (await runRes.json()) as { run: RunRecord };
      expect(run.status).toBe('warn'); // isbn:404 is missing
      expect(run.recipes[0]?.counts).toEqual({
        matched: 2,
        matchedByTitle: 0,
        written: 2,
        added: 2,
        removed: 0,
        missing: 1,
      });
      expect(run.recipes[0]?.missing).toEqual(['isbn:404']);

      const listRes = await app.request('/api/runs', { headers: auth });
      expect(((await listRes.json()) as { runs: unknown[] }).runs).toHaveLength(1);

      const collectionsRes = await app.request('/api/collections', { headers: auth });
      const { collections, issues } = (await collectionsRes.json()) as {
        collections: Record<string, unknown>[];
        issues: unknown[];
      };
      expect(issues).toEqual([]);
      expect(collections).toHaveLength(1);
      expect(collections[0]).toMatchObject({
        recipeId: 'wire-recipe',
        itemCount: 2,
        itemIds: ['item-2', 'item-1'],
      });
    });

    it('404s an apply for a missing recipe and 409s a disabled one', async () => {
      const missing = await app.request('/api/apply', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ scope: 'ghost' }),
      });
      expect(missing.status).toBe(404);

      const recipe = makeRecipe({ id: 'sleepy', enabled: false });
      const { id: _id, ...body } = recipe;
      await app.request('/api/recipes/sleepy', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      const disabled = await app.request('/api/apply', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ scope: 'sleepy' }),
      });
      expect(disabled.status).toBe(409);
    });

    it('404s an unknown run id', async () => {
      const res = await app.request('/api/runs/nope', { headers: auth });
      expect(res.status).toBe(404);
    });
  });

  describe('member-level missing', () => {
    it('reports the wanted-but-unheld member identities for a recipe', async () => {
      const recipe = makeRecipe({
        id: 'missing-recipe',
        builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:3', 'isbn:99'] },
      });
      const { id: _id, ...body } = recipe;
      await app.request('/api/recipes/missing-recipe', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });

      const res = await app.request('/api/collections/missing-recipe/missing', { headers: auth });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        recipeId: string;
        total: number;
        heldCount: number;
        missingCount: number;
        missing: { label: string; isbn: string | null; identifiers: string[] }[];
      };
      expect(payload.recipeId).toBe('missing-recipe');
      expect(payload.total).toBe(3);
      expect(payload.heldCount).toBe(2); // isbn:1, isbn:3 seeded in the fake library
      expect(payload.missingCount).toBe(1);
      expect(payload.missing).toEqual([
        { label: 'isbn:99', title: null, authors: [], isbn: '99', identifiers: ['isbn:99'] },
      ]);
    });

    it('404s an unknown recipe id', async () => {
      const res = await app.request('/api/collections/nope/missing', { headers: auth });
      expect(res.status).toBe(404);
    });
  });

  describe('resolve broker', () => {
    it('503s when the broker is not configured', async () => {
      const res = await app.request('/api/resolve', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ isbn: '9780441172719', title: 'Dune' }),
      });
      expect(res.status).toBe(503);
    });

    it('resolves an ISBN to a volume id when the broker is wired', async () => {
      const tmp = await makeTempDir();
      const config = loadConfig({
        CONFIG_DIR: tmp.dir,
        LIBRETTO_API_KEY: KEY,
      } as NodeJS.ProcessEnv);
      const recipeStore = new RecipeStore(config.recipesDir);
      const runStore = new RunStore(config.runsFile);
      const targets = registryFor(makeSeededTarget());
      const q = new RunQueue({ recipeStore, runStore, targets, builders: {}, log: silentLogger });
      const s = new Scheduler(recipeStore, q, silentLogger);
      const brokerApp = createApp({
        config,
        recipeStore,
        runStore,
        queue: q,
        scheduler: s,
        targets,
        builders: {},
        resolve: {
          resolve: () =>
            Promise.resolve({
              volumeId: 'VOL_DUNE',
              isbn13: '9780441172719',
              via: 'isbn' as const,
            }),
        },
        log: silentLogger,
      });
      const res = await brokerApp.request('/api/resolve', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ isbn: '9780441172719', title: 'Dune' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resolved: { volumeId: 'VOL_DUNE', isbn13: '9780441172719', via: 'isbn' },
      });
      s.stop();
      await tmp.cleanup();
    });
  });

  describe('discovery', () => {
    it('enumerates builders and targets', async () => {
      const builders = await app.request('/api/builders', { headers: auth });
      const { builders: builderList } = (await builders.json()) as {
        builders: { type: string }[];
      };
      expect(builderList.map((b) => b.type)).toEqual([
        'static_ids',
        'hardcover_series',
        'nyt_list',
      ]);
      const targetsRes = await app.request('/api/targets', { headers: auth });
      expect(((await targetsRes.json()) as { targets: unknown[] }).targets).toHaveLength(2);
    });
  });
});
