/**
 * Provenance marker (DESIGN-037 D-08, amended stateless): ownership of produced
 * collections is not stored locally — it is recovered FROM the target. Libretto
 * embeds `[libretto:<recipeId>]` in the collection description when it creates a
 * collection, and on every run it re-finds its collection by scanning for that
 * marker. Names are never an ownership key: a renamed collection that still
 * carries the marker stays owned; a same-name collection without the marker is
 * never touched.
 */

const MARKER_RE = /\[libretto:([a-z0-9][a-z0-9_-]*)\]/;

export function provenanceMarker(recipeId: string): string {
  return `[libretto:${recipeId}]`;
}

export function recipeIdFromDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  return MARKER_RE.exec(description)?.[1];
}

export function buildCollectionDescription(recipeId: string): string {
  return `Managed by Libretto. Do not remove this marker: ${provenanceMarker(recipeId)}`;
}
