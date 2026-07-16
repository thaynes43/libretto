import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTargetRegistry } from './registry.js';
import { AbsTarget } from './abs.js';
import { FakeTarget } from './fake.js';
import { KavitaTarget } from './kavita.js';
import { TargetUnavailableError } from './types.js';
import { DiskCache } from '../cache/disk.js';
import { loadConfig } from '../config.js';
import { makeTempDir, silentLogger } from '../testing/fixtures.js';

describe('createTargetRegistry', () => {
  let cleanup: () => Promise<void>;
  let dir: string;
  let cache: DiskCache;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    dir = tmp.dir;
    cache = new DiskCache(path.join(dir, 'cache'));
  });

  afterEach(async () => {
    await cleanup();
  });

  function registryFromEnv(env: Record<string, string>) {
    const config = loadConfig({ CONFIG_DIR: dir, ...env } as NodeJS.ProcessEnv);
    return createTargetRegistry(config, silentLogger, cache);
  }

  it('LIBRETTO_FAKE_TARGET=1 serves the fake for both server kinds', () => {
    const registry = registryFromEnv({ LIBRETTO_FAKE_TARGET: '1' });
    expect(registry.for('kavita')).toBeInstanceOf(FakeTarget);
    expect(registry.for('abs')).toBe(registry.for('kavita'));
    expect(registry.statuses().every((status) => status.available)).toBe(true);
  });

  it('activates real clients when their env is present', () => {
    const registry = registryFromEnv({
      KAVITA_URL: 'http://kavita.local',
      KAVITA_API_KEY: 'k',
      ABS_URL: 'http://abs.local',
      ABS_TOKEN: 'a',
    });
    expect(registry.for('kavita')).toBeInstanceOf(KavitaTarget);
    expect(registry.for('abs')).toBeInstanceOf(AbsTarget);
    expect(registry.statuses()).toEqual([
      { server: 'kavita', configured: true, available: true, note: 'configured' },
      { server: 'abs', configured: true, available: true, note: 'configured' },
    ]);
  });

  it('fails honestly at use for an unconfigured target while the other still works', () => {
    const registry = registryFromEnv({ KAVITA_URL: 'http://kavita.local', KAVITA_API_KEY: 'k' });
    expect(registry.for('kavita')).toBeInstanceOf(KavitaTarget);
    expect(() => registry.for('abs')).toThrow(TargetUnavailableError);
    expect(() => registry.for('abs')).toThrow('set ABS_URL and ABS_TOKEN');
    const abs = registry.statuses().find((status) => status.server === 'abs')!;
    expect(abs.configured).toBe(false);
    expect(abs.available).toBe(false);
  });

  it('a partially set env (url without key) does not activate a client', () => {
    const registry = registryFromEnv({ KAVITA_URL: 'http://kavita.local' });
    expect(() => registry.for('kavita')).toThrow(TargetUnavailableError);
  });
});
