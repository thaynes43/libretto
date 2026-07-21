import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AcquisitionCounts } from '../acquire/acquire.js';

/** Per-(recipe, target) outcome recorded into the run (DESIGN-037 D-02 Run counts + M3 acquisition). */
export interface RecipeRunResult {
  recipeId: string;
  /**
   * Which target this result belongs to (ADR-076 multi-target): a recipe yields one result per
   * target, so a run's `recipes[]` carries N entries for an N-target recipe. `missing` below are the
   * works missing FROM this target; `acquisition` (when present) drove this target's format.
   */
  target: { server: 'kavita' | 'abs'; libraryId: string };
  counts: {
    /** Work-list entries that matched a library item (by identifier or title). */
    matched: number;
    /**
     * Subset of `matched` resolved by the conservative D-04 title fallback rather
     * than an identifier — the "flagged" surface that keeps a title match
     * distinguishable from an identifier match. 0 when the fallback is off or
     * unused. `matched - matchedByTitle` is the identifier-matched count.
     */
    matchedByTitle: number;
    /** Collection membership size after the run (what is materialized in the target). */
    written: number;
    /** Items added to the collection this run. */
    added: number;
    /** Items removed from the collection this run (always 0 in append mode). */
    removed: number;
    /** Work-list entries no library item matched. */
    missing: number;
  };
  /** Identifiers the builder demanded that no library item matched (the missing[] shape). */
  missing: string[];
  /**
   * Acquisition tallies (DESIGN-037 M3). Present ONLY when the recipe ran the acquisition leg
   * (variables.acquisitionEnabled with LazyLibrarian configured); omitted otherwise so a
   * non-acquiring run's shape is unchanged. Kept a sibling of `counts` (not inside it) so the
   * reconcile-count contract stays stable.
   */
  acquisition?: AcquisitionCounts;
  error?: string;
}

export type RunStatus = 'running' | 'ok' | 'warn' | 'error';

export interface RunRecord {
  id: string;
  scope: 'all' | string;
  trigger: 'api' | 'cron';
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  recipes: RecipeRunResult[];
}

/**
 * Run history is a rotating JSON file on the config volume (state/runs.json),
 * newest first, capped at `keep` records. It is deliberately losable: deleting
 * it loses history, never correctness — ownership lives in the targets.
 */
export class RunStore {
  /** Serializes read-modify-write cycles; the process is the only writer. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly runsFile: string,
    private readonly keep = 50,
  ) {}

  async list(): Promise<RunRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.runsFile, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as RunRecord[]) : [];
    } catch {
      return []; // corrupt history is dropped, not fatal — it is losable state
    }
  }

  async get(id: string): Promise<RunRecord | undefined> {
    return (await this.list()).find((run) => run.id === id);
  }

  async insert(run: RunRecord): Promise<void> {
    await this.withLock(async () => {
      const runs = await this.list();
      runs.unshift(run);
      await this.write(runs.slice(0, this.keep));
    });
  }

  async update(id: string, patch: Partial<Omit<RunRecord, 'id'>>): Promise<void> {
    await this.withLock(async () => {
      const runs = await this.list();
      const index = runs.findIndex((run) => run.id === id);
      if (index === -1) return; // rotated out mid-run; nothing to update
      runs[index] = { ...runs[index]!, ...patch };
      await this.write(runs);
    });
  }

  private async write(runs: RunRecord[]): Promise<void> {
    await mkdir(path.dirname(this.runsFile), { recursive: true });
    const tmp = `${this.runsFile}.tmp`;
    await writeFile(tmp, JSON.stringify(runs, null, 2), 'utf8');
    await rename(tmp, this.runsFile);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }
}
