import type { ServiceEndpoint } from '../config.js';
import { fetchJson, joinUrl } from '../http.js';
import { normalizeIdentifiers } from '../identifiers.js';
import type { Logger } from '../logger.js';
import type {
  CreateCollectionInput,
  TargetClient,
  TargetCollection,
  TargetItem,
  UpdateCollectionInput,
} from './types.js';

/**
 * Audiobookshelf target (DESIGN-037 D-06), verified against the audiobookshelf
 * source (server/controllers/CollectionController.js, LibraryController.js,
 * models/Book.js @ master, 2026-07):
 *
 * - Auth is a static Bearer token (`Authorization: Bearer <ABS_TOKEN>`); a user
 *   API token or an API key both work. No token refresh dance.
 * - Library items: GET /api/libraries/:id/items?limit&page (page is 0-based).
 *   The response is always the minified item shape, and CRUCIALLY the minified
 *   book metadata still carries `isbn` and `asin` (models/Book.js includes both
 *   in oldMetadataToJSONMinified) — so identifier matching needs no per-item
 *   fetches. Field paths: results[i].media.metadata.{title,isbn,asin}.
 * - MARKER SPIKE FINDING: ABS collections have a writable `description` field on
 *   both POST /api/collections and PATCH /api/collections/:id, echoed back by
 *   every read. The provenance marker lives there; no sidecar fallback needed.
 * - Collections are per-library and shared (no user ownership); `books[]` in
 *   reads is the ordered expanded membership (ordered by collectionBook.order).
 * - Ordering semantics: POST preserves the order of the submitted `books[]`
 *   (order = index + 1). PATCH with `books[]` REORDERS existing members only —
 *   it neither adds nor removes. Membership changes therefore go through
 *   POST /:id/batch/add and /:id/batch/remove ({ books: [libraryItemIds] }),
 *   followed by a PATCH of the full ordered array when order matters.
 * - ABS collections carry no tag/label field; CreateCollectionInput.tags is
 *   ignored here (variables.tag only reaches targets that support labels).
 */

interface AbsLibrary {
  id: string;
  name: string;
}

interface AbsLibraryItem {
  id: string;
  media?: {
    metadata?: {
      title?: string;
      isbn?: string | null;
      asin?: string | null;
      // Minified book metadata carries the flattened authorName ("A, B"); the
      // full shape has authors[].name. Both feed the D-04 title-fallback guard.
      authorName?: string | null;
      authors?: { name?: string | null }[];
    };
  };
}

interface AbsCollection {
  id: string;
  libraryId: string;
  name: string;
  description: string | null;
  books: { id: string }[];
}

const PAGE_SIZE = 500;

export class AbsTarget implements TargetClient {
  readonly server = 'abs';

  constructor(
    private readonly endpoint: ServiceEndpoint,
    private readonly log: Logger,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.endpoint.apiKey}` };
  }

  private get<T>(path: string): Promise<T> {
    return fetchJson<T>(joinUrl(this.endpoint.url, path), { headers: this.headers() });
  }

  private send<T>(method: string, path: string, body: unknown): Promise<T> {
    return fetchJson<T>(joinUrl(this.endpoint.url, path), {
      method,
      headers: this.headers(),
      body,
    });
  }

  async listLibraries(): Promise<{ id: string; name: string }[]> {
    const { libraries } = await this.get<{ libraries: AbsLibrary[] }>('/api/libraries');
    return libraries.map(({ id, name }) => ({ id, name }));
  }

  async listItems(libraryId: string): Promise<TargetItem[]> {
    const items: TargetItem[] = [];
    for (let page = 0; ; page++) {
      const { results, total } = await this.get<{ results: AbsLibraryItem[]; total: number }>(
        `/api/libraries/${encodeURIComponent(libraryId)}/items?limit=${PAGE_SIZE}&page=${page}`,
      );
      for (const item of results) {
        const metadata = item.media?.metadata ?? {};
        const authors = absAuthors(metadata);
        items.push({
          id: item.id,
          title: metadata.title ?? '',
          identifiers: normalizeIdentifiers([metadata.isbn, metadata.asin]),
          ...(authors.length > 0 ? { authors } : {}),
        });
      }
      if (results.length === 0 || items.length >= total) break;
    }
    this.log.debug({ libraryId, items: items.length }, 'abs: listed library items');
    return items;
  }

  async listCollections(libraryId: string): Promise<TargetCollection[]> {
    // GET /api/collections returns every collection the token's user can access;
    // filter to the requested library here (collections are per-library in ABS).
    const { collections } = await this.get<{ collections: AbsCollection[] }>('/api/collections');
    return collections
      .filter((collection) => collection.libraryId === libraryId)
      .map((collection) => this.toTargetCollection(collection));
  }

  async createCollection(input: CreateCollectionInput): Promise<TargetCollection> {
    // ABS collections are natively ordered; input.ordered needs no mapping and
    // input.tags has no home (no tag field on ABS collections).
    const created = await this.send<AbsCollection>('POST', '/api/collections', {
      libraryId: input.libraryId,
      name: input.name,
      description: input.description,
      books: input.itemIds,
    });
    return this.toTargetCollection(created);
  }

  async updateCollection(
    collectionId: string,
    patch: UpdateCollectionInput,
  ): Promise<TargetCollection> {
    const path = `/api/collections/${encodeURIComponent(collectionId)}`;
    const current = await this.get<AbsCollection>(path);
    const currentIds = current.books.map((book) => book.id);
    const desired = new Set(patch.itemIds);
    const has = new Set(currentIds);
    const toAdd = patch.itemIds.filter((id) => !has.has(id));
    const toRemove = currentIds.filter((id) => !desired.has(id));

    // PATCH books[] only reorders; membership changes go through the batch
    // endpoints first, then one PATCH writes the full order.
    let latest = current;
    if (toRemove.length > 0) {
      latest = await this.send<AbsCollection>('POST', `${path}/batch/remove`, {
        books: toRemove,
      });
    }
    if (toAdd.length > 0) {
      latest = await this.send<AbsCollection>('POST', `${path}/batch/add`, { books: toAdd });
    }
    const orderNow = latest.books.map((book) => book.id);
    if (!sameOrder(orderNow, patch.itemIds)) {
      latest = await this.send<AbsCollection>('PATCH', path, { books: patch.itemIds });
    }
    this.log.debug(
      { collectionId, added: toAdd.length, removed: toRemove.length },
      'abs: updated collection membership',
    );
    return this.toTargetCollection(latest);
  }

  private toTargetCollection(collection: AbsCollection): TargetCollection {
    return {
      id: collection.id,
      libraryId: collection.libraryId,
      name: collection.name,
      description: collection.description ?? '',
      tags: [],
      itemIds: collection.books.map((book) => book.id),
      kind: 'abs_collection',
    };
  }
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Author names from ABS book metadata: prefer authors[].name, fall back to the flattened authorName. */
function absAuthors(
  metadata: NonNullable<NonNullable<AbsLibraryItem['media']>['metadata']>,
): string[] {
  const structured = (metadata.authors ?? [])
    .map((author) => author.name?.trim())
    .filter((name): name is string => !!name && name.length > 0);
  if (structured.length > 0) return structured;
  return (metadata.authorName ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
