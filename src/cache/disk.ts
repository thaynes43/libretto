import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
    await writeFile(this.fileFor(key), JSON.stringify(entry), 'utf8');
  }

  async delete(key: string): Promise<void> {
    await rm(this.fileFor(key), { force: true });
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
