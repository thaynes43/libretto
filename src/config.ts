import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Libretto is fully stateless (Kometa-style): there is no database.
 *
 * Everything lives on the config volume:
 *   CONFIG_DIR/
 *     recipes/     one YAML file per recipe (filename = recipe id); written only on
 *                  explicit API save, never rewritten by Libretto on its own
 *     state/       runs.json, a rotating log of the last N runs (losable)
 *     cache/       TTL disk cache for identifier resolution (losable; unused in M1)
 *
 * Connection secrets are environment-only and are validated at use, not at boot:
 * a Libretto with no Kavita key still serves its API and reconciles fake targets.
 */
export interface ServiceEndpoint {
  url: string;
  apiKey: string;
}

export interface AppConfig {
  configDir: string;
  recipesDir: string;
  stateDir: string;
  runsFile: string;
  cacheDir: string;
  port: number;
  logLevel: string;
  /** API key required for everything under /api. Unset means the API is locked. */
  apiKey: string | undefined;
  /** LIBRETTO_FAKE_TARGET=1 serves an in-memory fake target so the skeleton runs standalone. */
  fakeTarget: boolean;
  kavita: ServiceEndpoint | undefined;
  abs: ServiceEndpoint | undefined;
  lazyLibrarian: ServiceEndpoint | undefined;
  hardcoverToken: string | undefined;
  nytApiKey: string | undefined;
  /** Max acquisition actions (LL adds + queue-drives) per recipe run (M3 pacing). */
  acquisitionCapPerRun: number;
  /** Spacing between LazyLibrarian write calls, ms (estate politeness). */
  acquisitionIntervalMs: number;
}

function endpoint(
  url: string | undefined,
  apiKey: string | undefined,
): ServiceEndpoint | undefined {
  if (!url || !apiKey) return undefined;
  return { url, apiKey };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configDir = path.resolve(env.CONFIG_DIR ?? '/config');
  const stateDir = path.join(configDir, 'state');
  return {
    configDir,
    recipesDir: path.join(configDir, 'recipes'),
    stateDir,
    runsFile: path.join(stateDir, 'runs.json'),
    cacheDir: path.join(configDir, 'cache'),
    port: Number(env.PORT ?? 8080),
    logLevel: env.LOG_LEVEL ?? 'info',
    apiKey: env.LIBRETTO_API_KEY || undefined,
    fakeTarget: env.LIBRETTO_FAKE_TARGET === '1' || env.LIBRETTO_FAKE_TARGET === 'true',
    kavita: endpoint(env.KAVITA_URL, env.KAVITA_API_KEY),
    abs: endpoint(env.ABS_URL, env.ABS_TOKEN),
    lazyLibrarian: endpoint(env.LAZYLIBRARIAN_URL, env.LAZYLIBRARIAN_API_KEY),
    hardcoverToken: env.HARDCOVER_TOKEN || undefined,
    nytApiKey: env.NYT_API_KEY || undefined,
    acquisitionCapPerRun: positiveInt(env.LIBRETTO_ACQUISITION_CAP_PER_RUN, 10),
    acquisitionIntervalMs: positiveInt(env.LIBRETTO_ACQUISITION_INTERVAL_MS, 3000),
  };
}

/** Parse a positive integer env var, falling back to `fallback` on unset/invalid/<=0 input. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Create the config-volume layout if it does not exist yet. */
export function ensureConfigDirs(config: AppConfig): void {
  for (const dir of [config.configDir, config.recipesDir, config.stateDir, config.cacheDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
