import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from './store.js';
import { makeTempDir } from '../testing/fixtures.js';

function makeRun(id: string): RunRecord {
  return {
    id,
    scope: 'all',
    trigger: 'api',
    startedAt: new Date().toISOString(),
    status: 'running',
    recipes: [],
  };
}

describe('RunStore', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let file: string;

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
    file = path.join(dir, 'state', 'runs.json');
  });

  afterEach(async () => {
    await cleanup();
  });

  it('returns [] when the file does not exist or is corrupt (losable state)', async () => {
    const store = new RunStore(file);
    expect(await store.list()).toEqual([]);
    await writeFile(path.join(dir, 'corrupt.json'), 'not json', 'utf8');
    expect(await new RunStore(path.join(dir, 'corrupt.json')).list()).toEqual([]);
  });

  it('keeps newest-first and rotates past the cap', async () => {
    const store = new RunStore(file, 50);
    for (let i = 1; i <= 55; i++) await store.insert(makeRun(`run-${i}`));
    const runs = await store.list();
    expect(runs).toHaveLength(50);
    expect(runs[0]?.id).toBe('run-55');
    expect(runs[49]?.id).toBe('run-6');
    // run-1..run-5 rotated out
    expect(await store.get('run-3')).toBeUndefined();
    // and the on-disk file agrees
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(50);
  });

  it('updates a run in place', async () => {
    const store = new RunStore(file);
    await store.insert(makeRun('run-a'));
    await store.update('run-a', { status: 'ok', finishedAt: '2026-01-01T00:00:00Z' });
    const run = await store.get('run-a');
    expect(run?.status).toBe('ok');
    expect(run?.finishedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('serializes concurrent inserts (no lost updates)', async () => {
    const store = new RunStore(file, 50);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.insert(makeRun(`run-${i}`))));
    expect(await store.list()).toHaveLength(20);
  });
});
