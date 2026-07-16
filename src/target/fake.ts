import type {
  CreateCollectionInput,
  TargetClient,
  TargetCollection,
  TargetItem,
  UpdateCollectionInput,
} from './types.js';

interface FakeLibrary {
  id: string;
  name: string;
  items: TargetItem[];
}

/**
 * In-memory, marker-aware target with ordered collection membership. Used by the
 * test suite and by LIBRETTO_FAKE_TARGET=1 dev mode so the walking skeleton is
 * drivable end-to-end without a real Kavita or Audiobookshelf.
 */
export class FakeTarget implements TargetClient {
  readonly server = 'fake';
  private readonly libraries = new Map<string, FakeLibrary>();
  private readonly collections = new Map<string, TargetCollection>();
  private nextCollectionId = 1;

  seedLibrary(library: FakeLibrary): void {
    this.libraries.set(library.id, {
      ...library,
      items: library.items.map((item) => ({ ...item, identifiers: [...item.identifiers] })),
    });
  }

  /** Test helper: plant a collection as if a human (or another tool) created it. */
  seedCollection(collection: Omit<TargetCollection, 'id'> & { id?: string }): TargetCollection {
    const id = collection.id ?? `fake-collection-${this.nextCollectionId++}`;
    const stored: TargetCollection = { ...collection, id, itemIds: [...collection.itemIds] };
    this.collections.set(id, stored);
    return clone(stored);
  }

  /** Test helper: rename a collection out-of-band (ownership must survive this). */
  renameCollection(collectionId: string, name: string): void {
    const collection = this.mustGetCollection(collectionId);
    collection.name = name;
  }

  listLibraries(): Promise<{ id: string; name: string }[]> {
    return Promise.resolve([...this.libraries.values()].map(({ id, name }) => ({ id, name })));
  }

  listItems(libraryId: string): Promise<TargetItem[]> {
    const library = this.libraries.get(libraryId);
    if (!library) return Promise.reject(new Error(`fake target has no library ${libraryId}`));
    return Promise.resolve(library.items.map((item) => ({ ...item })));
  }

  listCollections(libraryId: string): Promise<TargetCollection[]> {
    return Promise.resolve(
      [...this.collections.values()]
        .filter((collection) => collection.libraryId === libraryId)
        .map(clone),
    );
  }

  createCollection(input: CreateCollectionInput): Promise<TargetCollection> {
    if (!this.libraries.has(input.libraryId)) {
      return Promise.reject(new Error(`fake target has no library ${input.libraryId}`));
    }
    const stored: TargetCollection = {
      id: `fake-collection-${this.nextCollectionId++}`,
      libraryId: input.libraryId,
      name: input.name,
      description: input.description,
      tags: [...(input.tags ?? [])],
      itemIds: [...input.itemIds],
    };
    this.collections.set(stored.id, stored);
    return Promise.resolve(clone(stored));
  }

  updateCollection(collectionId: string, patch: UpdateCollectionInput): Promise<TargetCollection> {
    const collection = this.mustGetCollection(collectionId);
    collection.itemIds = [...patch.itemIds];
    return Promise.resolve(clone(collection));
  }

  /** Test helper: raw read of a stored collection. */
  getCollection(collectionId: string): TargetCollection | undefined {
    const collection = this.collections.get(collectionId);
    return collection && clone(collection);
  }

  private mustGetCollection(collectionId: string): TargetCollection {
    const collection = this.collections.get(collectionId);
    if (!collection) throw new Error(`fake target has no collection ${collectionId}`);
    return collection;
  }
}

function clone(collection: TargetCollection): TargetCollection {
  return { ...collection, tags: [...collection.tags], itemIds: [...collection.itemIds] };
}

/** The library LIBRETTO_FAKE_TARGET=1 dev mode boots with (matches examples/recipes). */
export function seedDemoLibrary(target: FakeTarget): void {
  target.seedLibrary({
    id: 'fake-library-1',
    name: 'Fake Library',
    items: [
      { id: 'item-1', title: 'Leviathan Wakes', identifiers: ['isbn:9780316129084'] },
      { id: 'item-2', title: "Caliban's War", identifiers: ['isbn:9780316129060'] },
      { id: 'item-3', title: "Abaddon's Gate", identifiers: ['isbn:9780316129077'] },
      { id: 'item-4', title: 'Project Hail Mary', identifiers: ['isbn:9780593135204'] },
      { id: 'item-5', title: 'The Martian', identifiers: ['isbn:9780553418026'] },
    ],
  });
}
