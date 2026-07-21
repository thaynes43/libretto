/**
 * Provenance marker (DESIGN-037 D-08, amended stateless): ownership of produced
 * collections is not stored locally — it is recovered FROM the target. Libretto
 * embeds `[libretto:<recipeId>]` in the collection description when it creates a
 * collection, and on every run it re-finds its collection by scanning for that
 * marker. Names are never an ownership key: a renamed collection that still
 * carries the marker stays owned; a same-name collection without the marker is
 * never touched.
 *
 * MULTI-TARGET + CATEGORY (ADR-076 C-02): a multi-target recipe writes the SAME
 * marker into EVERY target's produced collection (the shared recipe id is the merge
 * key a downstream mirror keys the twins by). The marker MAY carry an optional
 * category — `[libretto:<recipeId>|cat=<Category>]` — when the recipe sets one; the
 * `cat=` token lets a mirror categorize the collection at sync. It is plain marker
 * text, nothing consumer-specific.
 */

// Group 1 = recipe id; group 2 = optional category (any run of non-`]` chars after `cat=`).
// The category value is kept free of `[`, `]`, `|` at the schema layer, so it can never split
// or terminate the marker early.
const MARKER_RE = /\[libretto:([a-z0-9][a-z0-9_-]*)(?:\|cat=([^\]]+))?\]/;

/** The bare `[libretto:<id>]` or `[libretto:<id>|cat=<category>]` token. */
export function provenanceMarker(recipeId: string, category?: string): string {
  return category === undefined
    ? `[libretto:${recipeId}]`
    : `[libretto:${recipeId}|cat=${category}]`;
}

export function recipeIdFromDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  return MARKER_RE.exec(description)?.[1];
}

/** The recipe-authored category carried in the marker's `cat=` token, if any (ADR-076 C-02). */
export function categoryFromDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  return MARKER_RE.exec(description)?.[2];
}

export function buildCollectionDescription(recipeId: string, category?: string): string {
  return `Managed by Libretto. Do not remove this marker: ${provenanceMarker(recipeId, category)}`;
}

/**
 * Re-sync just the marker token inside an existing description to the recipe's current id +
 * category, preserving any surrounding human-edited prose. Used when a recipe's category changes
 * (or is added on an already-produced collection): the collection stays owned, only its `cat=`
 * token updates. Falls back to the canonical description when no marker is present (never the case
 * for an owned collection, but kept total).
 */
export function withUpdatedMarker(
  description: string,
  recipeId: string,
  category?: string,
): string {
  const desired = provenanceMarker(recipeId, category);
  return MARKER_RE.test(description)
    ? description.replace(MARKER_RE, desired)
    : buildCollectionDescription(recipeId, category);
}
