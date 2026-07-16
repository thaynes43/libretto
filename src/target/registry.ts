import type { DiskCache } from '../cache/disk.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { AbsTarget } from './abs.js';
import { FakeTarget, seedDemoLibrary } from './fake.js';
import { KavitaTarget } from './kavita.js';
import { TargetUnavailableError, type TargetClient } from './types.js';

export interface TargetStatus {
  server: 'kavita' | 'abs';
  configured: boolean;
  available: boolean;
  note: string;
}

export interface TargetRegistry {
  /** Resolve the client for a recipe's targetLibrary.server. Throws TargetUnavailableError. */
  for(server: 'kavita' | 'abs'): TargetClient;
  /** Enumeration for GET /api/targets. */
  statuses(): TargetStatus[];
}

/**
 * Real targets activate when their env is present (KAVITA_URL + KAVITA_API_KEY,
 * ABS_URL + ABS_TOKEN); credentials are validated at use, not at boot — a
 * Libretto with only Kavita configured still serves ABS recipes an honest
 * TargetUnavailableError at run time. LIBRETTO_FAKE_TARGET=1 overrides both
 * kinds with one shared in-memory FakeTarget (tests and the demo quick start).
 */
export function createTargetRegistry(
  config: AppConfig,
  log: Logger,
  cache: DiskCache,
): TargetRegistry {
  if (config.fakeTarget) {
    const fake = new FakeTarget();
    seedDemoLibrary(fake);
    return {
      for: () => fake,
      statuses: () => [
        { server: 'kavita', configured: true, available: true, note: 'fake target (dev mode)' },
        { server: 'abs', configured: true, available: true, note: 'fake target (dev mode)' },
      ],
    };
  }

  const kavita = config.kavita && new KavitaTarget(config.kavita, log, cache);
  const abs = config.abs && new AbsTarget(config.abs, log);
  const clients: Record<'kavita' | 'abs', TargetClient | undefined> = { kavita, abs };
  const envHint: Record<'kavita' | 'abs', string> = {
    kavita: 'set KAVITA_URL and KAVITA_API_KEY',
    abs: 'set ABS_URL and ABS_TOKEN',
  };

  return {
    for(server) {
      const client = clients[server];
      if (!client) {
        throw new TargetUnavailableError(`${server} is not configured; ${envHint[server]}`);
      }
      return client;
    },
    statuses: () =>
      (['kavita', 'abs'] as const).map((server) => {
        const configured = clients[server] !== undefined;
        return {
          server,
          configured,
          available: configured,
          note: configured ? 'configured' : `not configured; ${envHint[server]}`,
        };
      }),
  };
}
