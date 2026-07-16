import type { Recipe } from '../recipes/schema.js';

/** A unit of work a builder wants in the collection, keyed by identifier. */
export interface WorkItem {
  identifier: string;
}

export interface BuilderInfo {
  type: string;
  description: string;
  /** Human-readable shape of builder.ref (drives docs and future UI forms). */
  ref: string;
}

/**
 * M1 builder set (DESIGN-037 D-05): only static_ids, the tracer. It has no
 * external dependency: the ref IS the ordered identifier list, verbatim.
 * hardcover_series / nyt_list / wikidata_award are M2+.
 */
export const builderInfos: BuilderInfo[] = [
  {
    type: 'static_ids',
    description: 'An ordered identifier list inlined in the recipe. No external source.',
    ref: 'array of identifier strings (order is the collection order)',
  },
];

/** Resolve the recipe's builder to its ordered work list (deduplicated, first wins). */
export function resolveBuilder(recipe: Recipe): Promise<WorkItem[]> {
  switch (recipe.builder.type) {
    case 'static_ids': {
      const seen = new Set<string>();
      const works: WorkItem[] = [];
      for (const identifier of recipe.builder.ref) {
        if (seen.has(identifier)) continue;
        seen.add(identifier);
        works.push({ identifier });
      }
      return Promise.resolve(works);
    }
  }
}
