import type { DiskCache } from '../cache/disk.js';
import type { AppConfig } from '../config.js';
import { normalizeIdentifier } from '../identifiers.js';
import type { Logger } from '../logger.js';
import type { Recipe } from '../recipes/schema.js';
import { HardcoverSeriesSource } from './hardcover.js';

/**
 * A unit of work a builder wants in the collection. A work can be known by
 * several identifiers (an ISBN-13 and an ASIN for the same book); it matches a
 * library item when ANY of them matches (D-04 — still exact-string, never fuzz).
 * The label is what missing[] reports when nothing matches.
 */
export interface WorkItem {
  /** Normalized identifiers (see identifiers.ts), any-match, order = preference. */
  identifiers: string[];
  /** Human-readable handle for the missing report (title when known, else the id). */
  label: string;
  /**
   * Clean work title for the conservative D-04 title fallback (distinct from the
   * decorated `label`). Undefined when the builder has no title to offer (e.g.
   * static_ids), which simply means this work never participates in the fallback.
   */
  title?: string;
  /** Author names for the fallback's author guard, when the builder supplies them. */
  authors?: string[];
}

export interface BuilderInfo {
  type: string;
  description: string;
  /** Human-readable shape of builder.ref (drives docs and API consumers). */
  ref: string;
  /** Whether this Libretto instance can run the builder right now (env present). */
  available: boolean;
  note?: string;
}

/**
 * External-source dependencies builders resolve through. Absent entries mean the
 * corresponding env is not configured; using such a builder fails honestly at
 * run time, never at boot (validated at use, like target credentials).
 */
export interface BuilderContext {
  /** Hardcover series source (undefined until HARDCOVER_TOKEN is set). */
  hardcoverSeries?: { seriesWorks(ref: string): Promise<WorkItem[]> };
}

/** Wire the builder sources whose env is present (validated at use, not boot). */
export function createBuilderContext(
  config: AppConfig,
  cache: DiskCache,
  log: Logger,
): BuilderContext {
  const ctx: BuilderContext = {};
  if (config.hardcoverToken !== undefined) {
    ctx.hardcoverSeries = new HardcoverSeriesSource({ token: config.hardcoverToken, cache, log });
  }
  return ctx;
}

/** M2 builder set (DESIGN-037 D-05): static_ids (the tracer) + hardcover_series. */
export function builderInfos(ctx: BuilderContext): BuilderInfo[] {
  return [
    {
      type: 'static_ids',
      description: 'An ordered identifier list inlined in the recipe. No external source.',
      ref: 'array of identifier strings (order is the collection order)',
      available: true,
    },
    {
      type: 'hardcover_series',
      description:
        'All books of a Hardcover series, ordered by series position. Positions the library lacks become missing[].',
      ref: 'a Hardcover series id or slug',
      available: ctx.hardcoverSeries !== undefined,
      ...(ctx.hardcoverSeries === undefined ? { note: 'set HARDCOVER_TOKEN to enable' } : {}),
    },
  ];
}

/** Resolve the recipe's builder to its ordered work list (deduplicated, first wins). */
export async function resolveBuilder(recipe: Recipe, ctx: BuilderContext): Promise<WorkItem[]> {
  switch (recipe.builder.type) {
    case 'static_ids': {
      const seen = new Set<string>();
      const works: WorkItem[] = [];
      for (const raw of recipe.builder.ref) {
        const identifier = normalizeIdentifier(raw);
        if (seen.has(identifier)) continue;
        seen.add(identifier);
        works.push({ identifiers: [identifier], label: identifier });
      }
      return works;
    }
    case 'hardcover_series': {
      if (!ctx.hardcoverSeries) {
        throw new Error(
          'the hardcover_series builder needs HARDCOVER_TOKEN (validated at use, not at boot)',
        );
      }
      return ctx.hardcoverSeries.seriesWorks(String(recipe.builder.ref));
    }
  }
}
