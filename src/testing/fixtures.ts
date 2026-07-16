import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import type { Recipe } from '../recipes/schema.js';
import { FakeTarget } from '../target/fake.js';
import type { TargetRegistry } from '../target/registry.js';

export const silentLogger = pino({ level: 'silent' });

export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'libretto-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'test-recipe',
    targetLibrary: { server: 'kavita', libraryId: 'lib-1' },
    name: 'Test Recipe',
    builder: { type: 'static_ids', ref: ['isbn:1', 'isbn:2'] },
    variables: {
      syncMode: 'sync',
      ordered: true,
      acquisitionEnabled: false,
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
