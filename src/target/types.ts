/**
 * TargetClient: the write-target seam (DESIGN-037 D-06/D-07, amended stateless).
 *
 * A target is a server that holds libraries of items (Kavita series, ABS library
 * items) and named collections of those items. Libretto writes collections into
 * targets and recovers ownership from them via the provenance marker embedded in
 * the collection description (see marker.ts) — there is no local ownership table.
 *
 * M1 ships only the in-memory FakeTarget. Real Kavita and Audiobookshelf clients
 * are M2; whether Kavita descriptions are writable enough to carry the marker is
 * an open M1 spike (DESIGN-037 research flag).
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
}

export interface CreateCollectionInput {
  libraryId: string;
  name: string;
  /** Must carry the provenance marker for the collection to be recoverable as owned. */
  description: string;
  tags?: string[];
  itemIds: string[];
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
