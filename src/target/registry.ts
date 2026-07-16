import type { AppConfig } from '../config.js';
import { FakeTarget, seedDemoLibrary } from './fake.js';
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
 * M1: real Kavita/ABS clients do not exist yet. With LIBRETTO_FAKE_TARGET=1 both
 * server kinds resolve to one shared in-memory FakeTarget; without it, resolving
 * any target fails honestly at use (never at boot — env is validated at use).
 */
export function createTargetRegistry(config: AppConfig): TargetRegistry {
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
  const configured = { kavita: config.kavita !== undefined, abs: config.abs !== undefined };
  return {
    for(server) {
      throw new TargetUnavailableError(
        `the real ${server} client ships in M2; set LIBRETTO_FAKE_TARGET=1 to drive the walking skeleton`,
      );
    },
    statuses: () => [
      {
        server: 'kavita',
        configured: configured.kavita,
        available: false,
        note: 'real client ships in M2',
      },
      {
        server: 'abs',
        configured: configured.abs,
        available: false,
        note: 'real client ships in M2',
      },
    ],
  };
}
