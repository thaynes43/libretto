import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import type { Recipe } from '../recipes/schema.js';
import { FakeTarget } from '../target/fake.js';
import type { TargetRegistry } from '../target/registry.js';
import type { TargetClient } from '../target/types.js';

export const silentLogger = pino({ level: 'silent' });

export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'libretto-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'test-recipe',
    targets: [{ server: 'kavita', libraryId: 'lib-1' }],
    name: 'Test Recipe',
    builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:2'] },
    variables: {
      syncMode: 'sync',
      ordered: true,
      acquisitionEnabled: false,
      titleFallback: true,
      schedule: 'manual',
    },
    enabled: true,
    ...overrides,
  };
}

/** A FakeTarget seeded with five items whose identifiers are isbn:1 .. isbn:5. */
export function makeSeededTarget(): FakeTarget {
  const target = new FakeTarget();
  target.seedLibrary({
    id: 'lib-1',
    name: 'Library One',
    items: [1, 2, 3, 4, 5].map((n) => ({
      id: `item-${n}`,
      title: `Book ${n}`,
      identifiers: [`isbn:${n}`],
    })),
  });
  return target;
}

export function registryFor(target: FakeTarget): TargetRegistry {
  return {
    for: () => target,
    statuses: () => [
      { server: 'kavita', configured: true, available: true, note: 'test fake' },
      { server: 'abs', configured: true, available: true, note: 'test fake' },
    ],
  };
}

/**
 * A registry that routes each server to a distinct client (multi-target tests): e.g. Kavita and ABS
 * to two different FakeTargets or two real clients over stub servers. A server with no client fails
 * honestly at use, exactly like the real registry.
 */
export function multiRegistry(
  clients: Partial<Record<'kavita' | 'abs', TargetClient>>,
): TargetRegistry {
  return {
    for: (server) => {
      const client = clients[server];
      if (!client) throw new Error(`${server} is not configured in this test registry`);
      return client;
    },
    statuses: () =>
      (['kavita', 'abs'] as const).map((server) => ({
        server,
        configured: clients[server] !== undefined,
        available: clients[server] !== undefined,
        note: 'test fake',
      })),
  };
}
