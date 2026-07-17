/**
 * TargetClient: the write-target seam (DESIGN-037 D-06/D-07, amended stateless).
 *
 * A target is a server that holds libraries of items (Kavita series, ABS library
 * items) and named collections of those items. Libretto writes collections into
 * targets and recovers ownership from them via the provenance marker embedded in
 * the collection description (see marker.ts) — there is no local ownership table.
 *

 * M2 ships the real Kavita and Audiobookshelf clients next to the fake. See
 * kavita.ts and abs.ts for the marker-home spike findings (whether each target's
 * description field is API-writable).
 */

export interface TargetItem {
  /** Target-side item id (Kavita series id, ABS library item id). */
  id: string;
  title: string;
  /**
   * Identifiers this item is known by (ISBNs, ASINs, source ids). Opaque strings
   * in M1; matching is exact-string. The identifier chain of D-04 arrives with
   * the real builders.
   */
  identifiers: string[];
  /**
   * Author names, when the target exposes them, for the conservative D-04 title
   * fallback's author guard. Undefined/empty means the fallback leans on
   * full-title equality alone (Kavita series carry no author today; ABS does).
   */
  authors?: string[];
}

export interface TargetCollection {
  /** Target-side collection id. Ownership keys on the description marker, never this name. */
  id: string;
  libraryId: string;
  name: string;
  description: string;
  tags: string[];
  /** Ordered membership: target item ids in collection order. */
  itemIds: string[];
  /**
   * What the target materialized this as (DESIGN-037 D-07): Kavita maps ordered
   * recipes to reading lists and unordered ones to collections; ABS and the fake
   * have a single natively-ordered kind.
   */
  kind: string;
}

export interface CreateCollectionInput {
  libraryId: string;
  name: string;
  /** Must carry the provenance marker for the collection to be recoverable as owned. */
  description: string;
  tags?: string[];
  itemIds: string[];
  /**
   * The recipe's ordered flag (D-07). Targets with two container kinds pick by
   * it (Kavita: ordered ⇒ reading list, unordered ⇒ collection); single-kind
   * targets may ignore it.
   */
  ordered: boolean;
}

export interface UpdateCollectionInput {
  /** Full ordered membership to write (replace semantics). */
  itemIds: string[];
}

export interface TargetClient {
  readonly server: string;
  listLibraries(): Promise<{ id: string; name: string }[]>;
  listItems(libraryId: string): Promise<TargetItem[]>;
  listCollections(libraryId: string): Promise<TargetCollection[]>;
  createCollection(input: CreateCollectionInput): Promise<TargetCollection>;
  updateCollection(collectionId: string, patch: UpdateCollectionInput): Promise<TargetCollection>;
}

/** Thrown when a recipe addresses a target that is not configured or not yet implemented. */
export class TargetUnavailableError extends Error {}
