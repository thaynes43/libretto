import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A cache file written this recently is never pruned (see DiskCache.prune). */
const PRUNE_GRACE_MS = 10 * 60 * 1000;

/**
 * TTL disk cache (DESIGN-037 D-03/D-04): CONFIG_DIR/cache holds identifier
 * resolution results — losable and rebuildable, a cache, not state. One JSON
 * file per key (the key is hashed into the filename, so keys can be URLs or
 * query payloads); expired entries are treated as absent and overwritten in
 * place. Corrupt files are treated as misses, never as errors.
 */
export class DiskCache {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private fileFor(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return path.join(this.dir, `${hash}.json`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await readFile(this.fileFor(key), 'utf8');
      const entry = JSON.parse(raw) as { key: string; expiresAt: number; value: T };
      if (entry.key !== key || entry.expiresAt <= this.now()) return undefined;
      return entry.value;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry = { key, expiresAt: this.now() + ttlMs, value };
    // Write then rename, so a reader (get, prune) never sees a half-written file.
    const file = this.fileFor(key);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(entry), 'utf8');
    await rename(temp, file);
  }

  async delete(key: string): Promise<void> {
    await rm(this.fileFor(key), { force: true });
  }

  /**
   * Delete every expired or unreadable entry, and temp files a crashed write left. A key that is no longer used (a
   * bumped cache version, a search query nobody repeats) leaves its file behind; this reclaims them. A file written in
   * the last `PRUNE_GRACE_MS` is kept whatever it holds: a run may have just refreshed it while prune was reading it.
   * At worst prune drops an entry a run refreshed in the instant between that check and the delete, which costs one
   * refetch. Returns how many files it removed.
   */
  async prune(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const temp = name.endsWith('.tmp');
      if (!temp && !name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      let expired = true;
      if (!temp) {
        try {
          const { expiresAt } = JSON.parse(await readFile(file, 'utf8')) as { expiresAt?: unknown };
          expired = typeof expiresAt !== 'number' || expiresAt <= this.now();
        } catch {
          expired = true;
        }
      }
      if (!expired) continue;
      try {
        if ((await stat(file)).mtimeMs > Date.now() - PRUNE_GRACE_MS) continue;
      } catch {
        continue; // already gone
      }
      await rm(file, { force: true });
      removed += 1;
    }
    return removed;
  }

  /** Read-through helper: cached value if fresh, else compute + store. */
  async getOrSet<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    await this.set(key, value, ttlMs);
    return value;
  }
}
