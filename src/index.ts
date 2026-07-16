import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { createBuilderContext } from './builders/index.js';
import { DiskCache } from './cache/disk.js';
import { ensureConfigDirs, loadConfig } from './config.js';
import { RunQueue } from './core/queue.js';
import { Scheduler } from './core/scheduler.js';
import { createLogger } from './logger.js';
import { RecipeStore } from './recipes/store.js';
import { RunStore } from './runs/store.js';
import { createTargetRegistry } from './target/registry.js';

const config = loadConfig();
const log = createLogger(config.logLevel);
ensureConfigDirs(config);

const recipeStore = new RecipeStore(config.recipesDir);
const runStore = new RunStore(config.runsFile);
const cache = new DiskCache(config.cacheDir);
const targets = createTargetRegistry(config, log, cache);
const builders = createBuilderContext(config, cache, log);
const queue = new RunQueue({ recipeStore, runStore, targets, builders, log });
const scheduler = new Scheduler(recipeStore, queue, log);
await scheduler.reload();

if (config.fakeTarget) {
  log.warn('LIBRETTO_FAKE_TARGET=1: serving the in-memory fake target (dev mode)');
}
if (config.apiKey === undefined) {
  log.warn('LIBRETTO_API_KEY is not set: every /api request will be rejected with 401');
}

const app = createApp({ config, recipeStore, runStore, queue, scheduler, targets, builders, log });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info({ port: info.port, configDir: config.configDir }, 'libretto listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down');
    scheduler.stop();
    server.close();
    void queue.onIdle().then(() => process.exit(0));
  });
}
