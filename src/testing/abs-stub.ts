import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

/**
 * Stub Audiobookshelf server for fixture-backed tests. Response shapes are the
 * recorded ones from the audiobookshelf source (see src/target/abs.ts header):
 * minified library items with media.metadata.{title,isbn,asin}; collections in
 * old-JSON-expanded form with ordered books[]; PATCH books[] reorders only;
 * membership changes via /batch/add and /batch/remove.
 */

export interface AbsStubItem {
  id: string;
  title: string;
  isbn?: string | null;
  asin?: string | null;
}

interface AbsStubCollection {
  id: string;
  libraryId: string;
  name: string;
  description: string | null;
  bookIds: string[];
}

export class AbsStub {
  readonly app = new Hono();
  readonly requests: string[] = [];
  private readonly libraries = new Map<string, { name: string; items: AbsStubItem[] }>();
  private readonly collections = new Map<string, AbsStubCollection>();

  constructor(private readonly token: string) {
    this.app.use('*', async (c, next) => {
      this.requests.push(`${c.req.method} ${c.req.path}`);
      if (c.req.header('authorization') !== `Bearer ${this.token}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    });

    this.app.get('/api/libraries', (c) =>
      c.json({
        libraries: [...this.libraries.entries()].map(([id, lib]) => ({
          id,
          name: lib.name,
          mediaType: 'book',
        })),
      }),
    );

    this.app.get('/api/libraries/:id/items', (c) => {
      const library = this.libraries.get(c.req.param('id'));
      if (!library) return c.json({ error: 'Not found' }, 404);
      const limit = Number(c.req.query('limit') ?? 0) || library.items.length;
      const page = Number(c.req.query('page') ?? 0);
      const results = library.items
        .slice(page * limit, page * limit + limit)
        .map((item) => this.minifiedItem(item));
      return c.json({ results, total: library.items.length, limit, page });
    });

    this.app.get('/api/collections', (c) =>
      c.json({ collections: [...this.collections.values()].map((col) => this.expanded(col)) }),
    );

    this.app.post('/api/collections', async (c) => {
      const body = await c.req.json<{
        libraryId: string;
        name: string;
        description?: string;
        books: string[];
      }>();
      const collection: AbsStubCollection = {
        id: `col-${randomUUID().slice(0, 8)}`,
        libraryId: body.libraryId,
        name: body.name,
        description: body.description ?? null,
        bookIds: [...body.books],
      };
      this.collections.set(collection.id, collection);
      return c.json(this.expanded(collection));
    });

    this.app.get('/api/collections/:id', (c) => {
      const collection = this.collections.get(c.req.param('id'));
      if (!collection) return c.json({ error: 'Not found' }, 404);
      return c.json(this.expanded(collection));
    });

    this.app.patch('/api/collections/:id', async (c) => {
      const collection = this.collections.get(c.req.param('id'));
      if (!collection) return c.json({ error: 'Not found' }, 404);
      const body = await c.req.json<{ name?: string; description?: string; books?: string[] }>();
      if (body.name !== undefined) collection.name = body.name;
      if (body.description !== undefined) collection.description = body.description;
      if (Array.isArray(body.books)) {
        // Faithful to the source: PATCH books[] reorders EXISTING members only.
        const order = new Map(body.books.map((id, index) => [id, index]));
        collection.bookIds.sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1));
      }
      return c.json(this.expanded(collection));
    });

    this.app.post('/api/collections/:id/batch/add', async (c) => {
      const collection = this.collections.get(c.req.param('id'));
      if (!collection) return c.json({ error: 'Not found' }, 404);
      const { books } = await c.req.json<{ books: string[] }>();
      for (const id of books) {
        if (!collection.bookIds.includes(id)) collection.bookIds.push(id);
      }
      return c.json(this.expanded(collection));
    });

    this.app.post('/api/collections/:id/batch/remove', async (c) => {
      const collection = this.collections.get(c.req.param('id'));
      if (!collection) return c.json({ error: 'Not found' }, 404);
      const { books } = await c.req.json<{ books: string[] }>();
      collection.bookIds = collection.bookIds.filter((id) => !books.includes(id));
      return c.json(this.expanded(collection));
    });
  }

  seedLibrary(id: string, name: string, items: AbsStubItem[]): void {
    this.libraries.set(id, { name, items });
  }

  seedCollection(input: Omit<AbsStubCollection, 'id'> & { id?: string }): string {
    const id = input.id ?? `col-${randomUUID().slice(0, 8)}`;
    this.collections.set(id, { ...input, id, bookIds: [...input.bookIds] });
    return id;
  }

  getCollection(id: string): AbsStubCollection | undefined {
    const collection = this.collections.get(id);
    return collection && { ...collection, bookIds: [...collection.bookIds] };
  }

  private minifiedItem(item: AbsStubItem) {
    return {
      id: item.id,
      media: {
        metadata: {
          title: item.title,
          isbn: item.isbn ?? null,
          asin: item.asin ?? null,
        },
      },
    };
  }

  private expanded(collection: AbsStubCollection) {
    const items = [...this.libraries.values()].flatMap((lib) => lib.items);
    return {
      id: collection.id,
      libraryId: collection.libraryId,
      name: collection.name,
      description: collection.description,
      books: collection.bookIds.map((id) => {
        const item = items.find((candidate) => candidate.id === id);
        return item ? this.minifiedItem(item) : { id, media: { metadata: {} } };
      }),
    };
  }
}
