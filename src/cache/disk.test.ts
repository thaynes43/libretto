import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskCache } from './disk.js';
import { makeTempDir } from '../testing/fixtures.js';

describe('DiskCache', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    dir = path.join(tmp.dir, 'cache');
    cleanup = tmp.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('round-trips values within the TTL', async () => {
    const cache = new DiskCache(dir);
    await cache.set('key-a', { works: [1, 2] }, 60_000);
    expect(await cache.get('key-a')).toEqual({ works: [1, 2] });
  });

  it('expires entries after the TTL', async () => {
    let now = 1_000_000;
    const cache = new DiskCache(dir, () => now);
    await cache.set('key-a', 'value', 500);
    expect(await cache.get('key-a')).toBe('value');
    now += 501;
    expect(await cache.get('key-a')).toBeUndefined();
  });

  it('treats missing and corrupt files as misses', async () => {
    const cache = new DiskCache(dir);
    expect(await cache.get('never-set')).toBeUndefined();
    await cache.set('key-a', 'value', 60_000);
    const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
    await writeFile(path.join(dir, files[0]!), 'not json', 'utf8');
    expect(await cache.get('key-a')).toBeUndefined();
  });

  it('getOrSet computes once and serves from cache after', async () => {
    const cache = new DiskCache(dir);
    let computes = 0;
    const compute = () => {
      computes++;
      return Promise.resolve('computed');
    };
    expect(await cache.getOrSet('key', 60_000, compute)).toBe('computed');
    expect(await cache.getOrSet('key', 60_000, compute)).toBe('computed');
    expect(computes).toBe(1);
  });

  it('keys with the same hash prefix do not collide', async () => {
    const cache = new DiskCache(dir);
    await cache.set('key-1', 'one', 60_000);
    await cache.set('key-2', 'two', 60_000);
    expect(await cache.get('key-1')).toBe('one');
    expect(await cache.get('key-2')).toBe('two');
  });
});
