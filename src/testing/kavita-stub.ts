import { Hono } from 'hono';

/**
 * Stub Kavita server for fixture-backed tests. Response shapes are the recorded
 * ones from the Kavita source, v0.8.9.1 (see src/target/kavita.ts header):
 * plugin auth issues a JWT-ish token; /api/Series/all-v2 returns a bare
 * SeriesDto[] with pagination metadata in a `Pagination` response header;
 * ISBNs live on chapters under /api/Series/volumes; collections and reading
 * lists are separate id spaces with separate mutation verbs.
 *
 * The stub serves at most `seriesPageCap` series per page regardless of the
 * requested PageSize (a server-side cap), which is what exercises the client's
 * Pagination-header paging loop.
 */

export interface KavitaStubSeries {
  id: number;
  name: string;
  libraryId: number;
  pages: number;
  /** Chapter ISBNs, possibly empty/null entries (EPUB3 scheme gaps). */
  chapterIsbns: (string | null)[];
}

interface KavitaStubCollection {
  id: number;
  title: string;
  summary: string | null;
  promoted: boolean;
  seriesIds: number[];
}

interface KavitaStubReadingList {
  id: number;
  title: string;
  summary: string | null;
  promoted: boolean;
  items: { id: number; seriesId: number }[];
}

export class KavitaStub {
  readonly app = new Hono();
  readonly requests: string[] = [];
  authCount = 0;
  seriesPageCap = 2;
  private tokenCounter = 0;
  private validTokens = new Set<string>();
  private libraries: { id: number; name: string }[] = [];
  private series: KavitaStubSeries[] = [];
  private collections = new Map<number, KavitaStubCollection>();
  private readingLists = new Map<number, KavitaStubReadingList>();
  private nextId = 1000;

  constructor(private readonly apiKey: string) {
    this.app.post('/api/Plugin/authenticate', (c) => {
      if (c.req.query('apiKey') !== this.apiKey || !c.req.query('pluginName')) {
        return c.json({ message: 'Unauthorized' }, 401);
      }
      this.authCount++;
      const token = `jwt-${++this.tokenCounter}`;
      this.validTokens.add(token);
      return c.json({ username: 'libretto', token, refreshToken: 'r', apiKey: this.apiKey });
    });

    this.app.use('/api/*', async (c, next) => {
      if (c.req.path === '/api/Plugin/authenticate') return next();
      this.requests.push(`${c.req.method} ${c.req.path}`);
      const header = c.req.header('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!this.validTokens.has(token)) return c.json({ message: 'Unauthorized' }, 401);
      await next();
    });

    this.app.get('/api/Library/libraries', (c) =>
      c.json(this.libraries.map((library) => ({ ...library, type: 2 }))),
    );

    this.app.post('/api/Series/all-v2', async (c) => {
      const body = await c.req.json<{
        statements: { field: number; comparison: number; value: string }[];
      }>();
      const libraryStatement = body.statements.find((statement) => statement.field === 19);
      const matching = this.series.filter(
        (one) =>
          libraryStatement === undefined || one.libraryId === Number(libraryStatement.value),
      );
      const page = Number(c.req.query('PageNumber') ?? 1);
      const slice = matching.slice((page - 1) * this.seriesPageCap, page * this.seriesPageCap);
      c.header(
        'Pagination',
        JSON.stringify({
          currentPage: page,
          itemsPerPage: this.seriesPageCap,
          totalItems: matching.length,
          totalPages: Math.max(1, Math.ceil(matching.length / this.seriesPageCap)),
        }),
      );
      return c.json(slice.map(({ id, name, libraryId, pages }) => ({ id, name, libraryId, pages })));
    });

    this.app.get('/api/Series/volumes', (c) => {
      const one = this.series.find((s) => s.id === Number(c.req.query('seriesId')));
      if (!one) return c.json([], 200);
      return c.json([{ id: one.id * 10, chapters: one.chapterIsbns.map((isbn) => ({ isbn })) }]);
    });

    this.app.get('/api/Series/series-by-collection', (c) => {
      const collection = this.collections.get(Number(c.req.query('collectionId')));
      if (!collection) return c.json([]);
      return c.json(
        collection.seriesIds.map((id) => {
          const one = this.series.find((s) => s.id === id);
          return { id, name: one?.name ?? '', libraryId: one?.libraryId ?? 0, pages: one?.pages ?? 0 };
        }),
      );
    });

    // --- collections ---
    this.app.get('/api/Collection', (c) =>
      c.json([...this.collections.values()].map((col) => this.collectionDto(col))),
    );

    this.app.post('/api/Collection/update-for-series', async (c) => {
      const body = await c.req.json<{
        collectionTagId: number;
        collectionTagTitle: string;
        seriesIds: number[];
      }>();
      let collection =
        body.collectionTagId === 0 ? undefined : this.collections.get(body.collectionTagId);
      if (!collection) {
        collection = {
          id: this.nextId++,
          title: body.collectionTagTitle,
          summary: null,
          promoted: false,
          seriesIds: [],
        };
        this.collections.set(collection.id, collection);
      }
      for (const id of body.seriesIds) {
        if (!collection.seriesIds.includes(id)) collection.seriesIds.push(id);
      }
      return c.body(null, 200);
    });

    this.app.post('/api/Collection/update', async (c) => {
      const dto = await c.req.json<{ id: number; title: string; summary?: string | null; promoted?: boolean }>();
      const collection = this.collections.get(dto.id);
      if (!collection) return c.json({ message: 'not found' }, 400);
      if (!dto.title) return c.json({ message: 'title required' }, 400);
      collection.title = dto.title;
      collection.summary = (dto.summary ?? '').trim();
      // Faithful: promoted only applies with the Promote role — the stub's
      // plugin user has it.
      if (dto.promoted !== undefined) collection.promoted = dto.promoted;
      return c.body(null, 200);
    });

    this.app.post('/api/Collection/update-series', async (c) => {
      const body = await c.req.json<{ tag: { id: number }; seriesIdsToRemove: number[] }>();
      const collection = this.collections.get(body.tag.id);
      if (!collection) return c.json({ message: 'not found' }, 400);
      collection.seriesIds = collection.seriesIds.filter(
        (id) => !body.seriesIdsToRemove.includes(id),
      );
      // Faithful: an emptied collection is deleted by Kavita.
      if (collection.seriesIds.length === 0) this.collections.delete(collection.id);
      return c.body(null, 200);
    });

    // --- reading lists ---
    this.app.post('/api/ReadingList/lists', (c) =>
      c.json([...this.readingLists.values()].map((list) => this.readingListDto(list))),
    );

    this.app.post('/api/ReadingList/create', async (c) => {
      const { title } = await c.req.json<{ title: string }>();
      const list: KavitaStubReadingList = {
        id: this.nextId++,
        title,
        summary: null,
        promoted: false,
        items: [],
      };
      this.readingLists.set(list.id, list);
      return c.json(this.readingListDto(list));
    });

    this.app.post('/api/ReadingList/update', async (c) => {
      const body = await c.req.json<{
        readingListId: number;
        title?: string;
        summary?: string | null;
        promoted?: boolean;
      }>();
      const list = this.readingLists.get(body.readingListId);
      if (!list) return c.json({ message: 'not found' }, 400);
      if (body.title !== undefined) list.title = body.title;
      if (body.summary !== undefined) list.summary = body.summary;
      if (body.promoted !== undefined) list.promoted = body.promoted;
      return c.body(null, 200);
    });

    this.app.post('/api/ReadingList/update-by-series', async (c) => {
      const body = await c.req.json<{ readingListId: number; seriesId: number }>();
      const list = this.readingLists.get(body.readingListId);
      const series = this.series.find((one) => one.id === body.seriesId);
      if (!list || !series) return c.json({ message: 'not found' }, 400);
      for (let chapter = 0; chapter < series.chapterIsbns.length; chapter++) {
        list.items.push({ id: this.nextId++, seriesId: series.id });
      }
      return c.body(null, 200);
    });

    this.app.get('/api/ReadingList/items', (c) => {
      const list = this.readingLists.get(Number(c.req.query('readingListId')));
      if (!list) return c.json([]);
      return c.json(
        list.items.map((item, index) => ({
          id: item.id,
          order: index,
          seriesId: item.seriesId,
          seriesName: this.series.find((one) => one.id === item.seriesId)?.name ?? '',
        })),
      );
    });

    this.app.post('/api/ReadingList/update-position', async (c) => {
      const body = await c.req.json<{
        readingListId: number;
        readingListItemId: number;
        toPosition: number;
      }>();
      const list = this.readingLists.get(body.readingListId);
      if (!list) return c.json({ message: 'not found' }, 400);
      const from = list.items.findIndex((item) => item.id === body.readingListItemId);
      if (from < 0) return c.json({ message: 'not found' }, 400);
      const [moved] = list.items.splice(from, 1);
      list.items.splice(body.toPosition, 0, moved!);
      return c.body(null, 200);
    });

    this.app.post('/api/ReadingList/delete-item', async (c) => {
      const body = await c.req.json<{ readingListId: number; readingListItemId: number }>();
      const list = this.readingLists.get(body.readingListId);
      if (!list) return c.json({ message: 'not found' }, 400);
      list.items = list.items.filter((item) => item.id !== body.readingListItemId);
      return c.body(null, 200);
    });
  }

  seedLibrary(id: number, name: string): void {
    this.libraries.push({ id, name });
  }

  seedSeries(series: KavitaStubSeries): void {
    this.series.push(series);
  }

  /** Test lever: simulate content changing (page count moves). */
  setSeriesPages(id: number, pages: number): void {
    const series = this.series.find((one) => one.id === id);
    if (series) series.pages = pages;
  }

  seedCollection(input: Omit<KavitaStubCollection, 'id'> & { id?: number }): number {
    const id = input.id ?? this.nextId++;
    this.collections.set(id, { ...input, id, seriesIds: [...input.seriesIds] });
    return id;
  }

  seedReadingList(
    input: Omit<KavitaStubReadingList, 'id' | 'items'> & { id?: number; seriesIds: number[] },
  ): number {
    const id = input.id ?? this.nextId++;
    const items = input.seriesIds.flatMap((seriesId) => {
      const series = this.series.find((one) => one.id === seriesId);
      const chapters = Math.max(1, series?.chapterIsbns.length ?? 1);
      return Array.from({ length: chapters }, () => ({ id: this.nextId++, seriesId }));
    });
    this.readingLists.set(id, {
      id,
      title: input.title,
      summary: input.summary,
      promoted: input.promoted,
      items,
    });
    return id;
  }

  getCollection(id: number): KavitaStubCollection | undefined {
    const collection = this.collections.get(id);
    return collection && { ...collection, seriesIds: [...collection.seriesIds] };
  }

  getReadingList(id: number): (KavitaStubReadingList & { seriesOrder: number[] }) | undefined {
    const list = this.readingLists.get(id);
    if (!list) return undefined;
    return {
      ...list,
      items: [...list.items],
      seriesOrder: list.items.map((item) => item.seriesId),
    };
  }

  /** Test lever: invalidate every issued token so the next call 401s. */
  expireTokens(): void {
    this.validTokens.clear();
  }

  /** Test lever: rename out-of-band (marker ownership must survive). */
  renameCollection(id: number, title: string): void {
    const collection = this.collections.get(id);
    if (collection) collection.title = title;
  }

  private collectionDto(collection: KavitaStubCollection) {
    return {
      id: collection.id,
      title: collection.title,
      summary: collection.summary,
      promoted: collection.promoted,
      coverImageLocked: false,
      itemCount: collection.seriesIds.length,
    };
  }

  private readingListDto(list: KavitaStubReadingList) {
    return {
      id: list.id,
      title: list.title,
      summary: list.summary,
      promoted: list.promoted,
      itemCount: list.items.length,
    };
  }
}
