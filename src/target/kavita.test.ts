import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KavitaTarget } from './kavita.js';
import { buildCollectionDescription, recipeIdFromDescription } from './marker.js';
import { DiskCache } from '../cache/disk.js';
import { KavitaStub } from '../testing/kavita-stub.js';
import { startStubServer } from '../testing/http.js';
import { makeTempDir, silentLogger } from '../testing/fixtures.js';
import { makeRecipe } from '../testing/fixtures.js';
import { reconcileTarget } from '../core/reconciler.js';

const API_KEY = 'kavita-api-key';

describe('KavitaTarget', () => {
  let stub: KavitaStub;
  let close: () => Promise<void>;
  let cleanup: () => Promise<void>;
  let cache: DiskCache;
  let cacheDir: string;
  let url: string;
  let target: KavitaTarget;

  beforeEach(async () => {
    stub = new KavitaStub(API_KEY);
    stub.seedLibrary(2, 'Books');
    stub.seedLibrary(3, 'Other');
    stub.seedSeries({
      id: 11,
      name: 'Leviathan Wakes',
      libraryId: 2,
      pages: 500,
      chapterIsbns: ['978-0-316-12908-4'],
    });
    stub.seedSeries({
      id: 12,
      name: "Caliban's War",
      libraryId: 2,
      pages: 520,
      chapterIsbns: ['0316129062'],
    });
    stub.seedSeries({
      id: 13,
      name: 'Scheme-less EPUB3',
      libraryId: 2,
      pages: 100,
      chapterIsbns: [null],
    });
    stub.seedSeries({
      id: 15,
      name: 'Outlander',
      libraryId: 2,
      pages: 900,
      chapterIsbns: [null, '9780385344432'],
      chapters: [
        {
          titleName: 'Outlander',
          writers: ['Diana Gabaldon'],
          filePath: '/books/Diana Gabaldon/Outlander/Outlander.epub',
        },
        {
          titleName: "Written in My Own Heart's Blood",
          writers: ['Diana Gabaldon'],
          filePath: '/books/Diana Gabaldon/Written in My Own Hearts Blood/Written.epub',
        },
      ],
    });
    stub.seedSeries({
      id: 14,
      name: 'Elsewhere',
      libraryId: 3,
      pages: 10,
      chapterIsbns: ['9780553418026'],
    });

    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    cacheDir = path.join(tmp.dir, 'cache');
    cache = new DiskCache(cacheDir);
    const server = await startStubServer(stub.app);
    close = server.close;
    url = server.url;
    target = new KavitaTarget({ url, apiKey: API_KEY }, silentLogger, cache);
  });

  afterEach(async () => {
    await close();
    await cleanup();
  });

  describe('auth', () => {
    it('authenticates once via the plugin flow and reuses the JWT', async () => {
      await target.listLibraries();
      await target.listLibraries();
      expect(stub.authCount).toBe(1);
    });

    it('re-authenticates once and retries on a 401 (expired JWT)', async () => {
      await target.listLibraries();
      stub.expireTokens();
      const libraries = await target.listLibraries();
      expect(libraries.map((library) => library.name)).toEqual(['Books', 'Other']);
      expect(stub.authCount).toBe(2);
    });

    it('surfaces a wrong API key as an auth error', async () => {
      const bad = new KavitaTarget({ url, apiKey: 'wrong' }, silentLogger, cache);
      await expect(bad.listItems('2')).rejects.toThrow('HTTP 401');
    });
  });

  describe('items (the identifier spike path)', () => {
    it('lists a library as series with chapter-level ISBNs normalized, paging via the Pagination header', async () => {
      const items = await target.listItems('2');
      expect(items).toEqual([
        { id: '11', title: 'Leviathan Wakes', identifiers: ['isbn:9780316129084'] },
        // ISBN-10 chapter value converts to ISBN-13.
        { id: '12', title: "Caliban's War", identifiers: ['isbn:9780316129060'] },
        // EPUB3 scheme gap: series listed, honestly unmatched forever.
        { id: '13', title: 'Scheme-less EPUB3', identifiers: [] },
        // A series that holds two books: each book's own title (and under the series name), the
        // chapters' writers, and the folders their files live in.
        {
          id: '15',
          title: 'Outlander',
          identifiers: ['isbn:9780385344432'],
          books: [
            ['Outlander'],
            ["Written in My Own Heart's Blood", "Outlander: Written in My Own Heart's Blood"],
          ],
          writers: ['Diana Gabaldon'],
          folders: [
            '/books/Diana Gabaldon/Outlander',
            '/books/Diana Gabaldon/Written in My Own Hearts Blood',
          ],
        },
      ]);
      // 4 matching series at the stub's page cap of 2 = two all-v2 pages.
      expect(stub.requests.filter((r) => r.includes('/api/Series/all-v2'))).toHaveLength(2);
    });

    it('caches per-series ISBN lookups and busts the key when the page count changes', async () => {
      await target.listItems('2');
      const volumeCalls = () => stub.requests.filter((r) => r.includes('/api/Series/volumes'));
      const afterFirst = volumeCalls().length;
      expect(afterFirst).toBe(4);

      await target.listItems('2');
      expect(volumeCalls()).toHaveLength(afterFirst); // all served from disk cache

      // Content change: the series' page count moves, so the entry is refetched.
      stub.setSeriesPages(11, 700);
      await target.listItems('2');
      expect(volumeCalls()).toHaveLength(afterFirst + 1);
    });

    describe('a metadata edit reaches the matcher (issue #25)', () => {
      const editedBooks = async (listing: KavitaTarget) =>
        (await listing.listItems('2')).find((item) => item.id === '11')!.books;

      it('is seen at the next listing once the series is scanned after the edit', async () => {
        const volumeCalls = () => stub.requests.filter((r) => r.includes('/api/Series/volumes'));
        expect(await editedBooks(target)).toBeUndefined();
        const afterFirst = volumeCalls().length;

        // The edit alone moves no SeriesDto field: the cached detail still serves.
        stub.setChapterTitle(11, 0, 'Leviathan Wakes: Book One');
        expect(await editedBooks(target)).toBeUndefined();
        expect(volumeCalls()).toHaveLength(afterFirst);

        // "Scan Series" moves lastFolderScanned, and only that series is refetched.
        stub.scanSeries(11, '2026-10-06T12:47:22.9785091');
        expect(await editedBooks(target)).toEqual([
          ['Leviathan Wakes: Book One', 'Leviathan Wakes: Leviathan Wakes: Book One'],
        ]);
        expect(volumeCalls()).toHaveLength(afterFirst + 1);
      });

      it('is seen without a scan once the entry is 12 hours old', async () => {
        let now = Date.parse('2026-10-06T14:33:00Z');
        const clocked = new KavitaTarget(
          { url, apiKey: API_KEY },
          silentLogger,
          new DiskCache(path.join(cacheDir, 'clocked'), () => now),
        );
        expect(await editedBooks(clocked)).toBeUndefined();
        stub.setChapterTitle(11, 0, 'Leviathan Wakes: Book One');

        now += 12 * 60 * 60 * 1000 - 1;
        expect(await editedBooks(clocked)).toBeUndefined();
        now += 1;
        expect(await editedBooks(clocked)).toEqual([
          ['Leviathan Wakes: Book One', 'Leviathan Wakes: Leviathan Wakes: Book One'],
        ]);
      });

      it('keeps one cache file per series: a new fingerprint overwrites the old entry', async () => {
        await target.listItems('2');
        const files = async () => (await readdir(cacheDir)).length;
        const before = await files();
        stub.scanSeries(11, '2026-10-06T12:47:22.9785091');
        stub.setSeriesPages(12, 999);
        await target.listItems('2');
        expect(await files()).toBe(before);
      });
    });
  });

  describe('unordered recipes: collections', () => {
    it('creates a collection implicitly and plants the marker in the summary', async () => {
      const created = await target.createCollection({
        libraryId: '2',
        name: 'Expanse',
        description: buildCollectionDescription('expanse'),
        itemIds: ['11', '12'],
        ordered: false,
      });
      expect(created.kind).toBe('kavita_collection');
      const raw = stub.getCollection(Number(created.id.split(':')[1]))!;
      expect(raw.seriesIds).toEqual([11, 12]);
      expect(recipeIdFromDescription(raw.summary!)).toBe('expanse');
      expect(raw.promoted).toBe(true);
    });

    it('recovers ownership by marker even after an out-of-band rename', async () => {
      const created = await target.createCollection({
        libraryId: '2',
        name: 'Expanse',
        description: buildCollectionDescription('expanse'),
        itemIds: ['11'],
        ordered: false,
      });
      const numericId = Number(created.id.split(':')[1]);
      stub.renameCollection(numericId, 'Totally Different Name');

      const collections = await target.listCollections('2');
      const owned = collections.find(
        (collection) => recipeIdFromDescription(collection.description) === 'expanse',
      );
      expect(owned).toBeDefined();
      expect(owned!.id).toBe(created.id);
      expect(owned!.itemIds).toEqual(['11']);
    });

    it('does not fetch members for unmarked collections', async () => {
      stub.seedCollection({
        title: 'Hand Curated',
        summary: 'a human wrote this',
        promoted: false,
        seriesIds: [11],
      });
      const collections = await target.listCollections('2');
      expect(collections).toHaveLength(1);
      expect(collections[0]!.itemIds).toEqual([]);
      expect(stub.requests.filter((r) => r.includes('series-by-collection'))).toHaveLength(0);
    });

    it('updates membership through update-for-series and update-series', async () => {
      const id = stub.seedCollection({
        title: 'Expanse',
        summary: buildCollectionDescription('expanse'),
        promoted: true,
        seriesIds: [11, 13],
      });
      const updated = await target.updateCollection(`collection:${id}`, {
        itemIds: ['11', '12'],
      });
      expect(updated.itemIds).toEqual(['11', '12']);
      expect(stub.getCollection(id)!.seriesIds.sort()).toEqual([11, 12]);
    });
  });

  describe('ordered recipes: reading lists', () => {
    const bookContext = (ids: string[]) => ({
      libraryId: '2',
      matchedWorks: ids.map((itemId) => ({
        itemId,
        work:
          itemId === '15'
            ? {
                label: 'Outlander',
                title: 'Outlander',
                identifiers: [],
                credits: ['Diana Gabaldon'],
              }
            : {
                label: itemId === '11' ? 'Leviathan Wakes' : "Caliban's War",
                identifiers: [itemId === '11' ? 'isbn:9780316129084' : 'isbn:9780316129060'],
              },
      })),
    });
    const clareWork = {
      label: 'City of Bones',
      title: 'City of Bones',
      identifiers: ['isbn:9781406331417'],
      credits: ['Cassandra Clare'],
    };
    function seedCity(stub: KavitaStub) {
      stub.seedSeries({
        id: 160,
        name: 'City of Bones',
        libraryId: 2,
        pages: 700,
        chapterIds: [184, 185],
        chapterIsbns: ['9781406331417', null],
        chapters: [
          { titleName: 'City of Bones', writers: ['Cassandra Clare'] },
          { titleName: 'City of Bones', writers: ['Martha Wells'] },
        ],
      });
    }

    it('refuses ordered Books writes without canonical context or a known library type', async () => {
      const id = stub.seedReadingList({
        title: 'Books',
        summary: buildCollectionDescription('books'),
        promoted: true,
        seriesIds: [11],
      });
      const original = stub.getReadingList(id)!.items;
      await expect(
        target.updateCollection(`readinglist:${id}`, { itemIds: ['12'], libraryId: '2' }),
      ).rejects.toThrow('canonical book identities missing');
      await expect(
        target.updateCollection(`readinglist:${id}`, {
          itemIds: [],
          libraryId: '2',
          matchedWorks: [],
        }),
      ).rejects.toThrow('canonical book identities missing');
      await expect(
        target.updateCollection(`readinglist:${id}`, { itemIds: ['12'] }),
      ).rejects.toThrow('library identity missing');
      await expect(
        target.updateCollection(`readinglist:${id}`, {
          itemIds: ['12'],
          libraryId: '999',
          matchedWorks: bookContext(['12']).matchedWorks,
        }),
      ).rejects.toThrow('incomplete library type read');
      await expect(
        target.createCollection({
          libraryId: '2',
          name: 'Books',
          ordered: true,
          description: '',
          itemIds: ['12'],
        }),
      ).rejects.toThrow('canonical book identities missing');
      stub.seedLibrary(99, 'Unknown future type', 99);
      await expect(
        target.updateCollection(`readinglist:${id}`, {
          itemIds: ['12'],
          libraryId: '99',
          matchedWorks: bookContext(['12']).matchedWorks,
        }),
      ).rejects.toThrow('incomplete library type read');
      expect(stub.getReadingList(id)!.items).toEqual(original);
      expect(
        stub.requests.some((r) =>
          /update-by-|delete-item|update-position|ReadingList\/create/.test(r),
        ),
      ).toBe(false);
    });

    it('repairs a complete same-title foreign chapter without replacing the valid item', async () => {
      seedCity(stub);
      const recipe = makeRecipe({ id: 'mortal', targets: [{ server: 'kavita', libraryId: '2' }] });
      const id = stub.seedReadingList({
        title: 'Mortal',
        summary: buildCollectionDescription('mortal'),
        promoted: true,
        seriesIds: [160],
      });
      const original = stub.getReadingList(id)!.items[0]!;
      await reconcileTarget(recipe, recipe.targets[0]!, target, [clareWork], silentLogger);
      expect(stub.getReadingList(id)!.items).toEqual([original]);
      expect(stub.requests.some((r) => r.includes('update-by-series'))).toBe(false);
    });

    it('creates a reading list using precise chapter adds, never adding the foreign chapter', async () => {
      seedCity(stub);
      const recipe = makeRecipe({ id: 'mortal', targets: [{ server: 'kavita', libraryId: '2' }] });
      await reconcileTarget(recipe, recipe.targets[0]!, target, [clareWork], silentLogger);
      const list = (await target.listCollections('2')).find(
        (collection) => recipeIdFromDescription(collection.description) === 'mortal',
      )!;
      const id = Number(list.id.split(':')[1]);
      expect(stub.getReadingList(id)!.items.map((item) => item.chapterId)).toEqual([184]);
      expect(stub.requests.filter((r) => r.includes('update-by-chapter'))).toHaveLength(1);
      expect(stub.requests.some((r) => r.includes('update-by-series'))).toBe(false);
    });

    it('unions canonical books in an old series while preserving interleaved source order and copies', async () => {
      stub.seedSeries({
        id: 161,
        name: 'Old umbrella',
        libraryId: 2,
        pages: 900,
        chapterIds: [16101, 16103, 16104, 16199],
        chapterIsbns: [null, null, null, null],
        chapters: [
          { titleName: 'First book', writers: ['Writer One'] },
          { titleName: 'Third book', writers: ['Writer One'] },
          { titleName: 'Third book', writers: ['Writer One'] },
          { titleName: 'Foreign book', writers: ['Other Author'] },
        ],
      });
      const first = {
        label: 'First book',
        title: 'First book',
        identifiers: [],
        credits: ['Writer One'],
      };
      const third = { ...first, label: 'Third book', title: 'Third book' };
      const id = stub.seedReadingList({
        title: 'Mixed',
        summary: buildCollectionDescription('mixed'),
        promoted: true,
        seriesIds: [161, 11],
      });
      const recipe = makeRecipe({ id: 'mixed', targets: [{ server: 'kavita', libraryId: '2' }] });
      await reconcileTarget(
        recipe,
        recipe.targets[0]!,
        target,
        [first, { identifiers: ['isbn:9780316129084'], label: 'Second' }, third],
        silentLogger,
      );
      expect(stub.getReadingList(id)!.items.map((item) => item.chapterId)).toEqual([
        16101, 11000, 16103, 16104,
      ]);
    });

    it('preserves existing items when a chapter identity is unknown, before any mutation', async () => {
      seedCity(stub);
      stub.setChapterTitle(160, 1, '');
      const id = stub.seedReadingList({
        title: 'Mortal',
        summary: buildCollectionDescription('mortal'),
        promoted: true,
        seriesIds: [160, 11],
      });
      const original = stub.getReadingList(id)!.items;
      await expect(
        target.updateCollection(`readinglist:${id}`, {
          itemIds: ['160'],
          libraryId: '2',
          matchedWorks: [{ itemId: '160', work: clareWork }],
        }),
      ).rejects.toThrow('incomplete book identities');
      expect(stub.getReadingList(id)!.items).toEqual(original);
      expect(stub.requests.some((r) => /update-by-|delete-item|update-position/.test(r))).toBe(
        false,
      );
    });

    it('does not create an empty list when the matched book cannot be verified freshly', async () => {
      seedCity(stub);
      stub.setChapterIsbn(160, 0, null);
      stub.setChapterTitle(160, 0, '');
      await expect(
        target.createCollection({
          libraryId: '2',
          name: 'Mortal',
          description: buildCollectionDescription('mortal'),
          ordered: true,
          itemIds: ['160'],
          matchedWorks: [{ itemId: '160', work: clareWork }],
        }),
      ).rejects.toThrow('incomplete book identities');
      expect(stub.requests.some((r) => r.includes('/api/ReadingList/create'))).toBe(false);
    });

    it('preserves old items if identities change during verified chapter additions', async () => {
      seedCity(stub);
      const id = stub.seedReadingList({
        title: 'Mortal',
        summary: buildCollectionDescription('mortal'),
        promoted: true,
        seriesIds: [11],
      });
      const original = stub.getReadingList(id)!.items[0]!;
      stub.afterChapterAdd = () => stub.setChapterTitle(160, 1, 'Changed during scan');
      await expect(
        target.updateCollection(`readinglist:${id}`, {
          itemIds: ['160'],
          libraryId: '2',
          matchedWorks: [{ itemId: '160', work: clareWork }],
        }),
      ).rejects.toThrow('chapters changed during reconcile');
      expect(stub.getReadingList(id)!.items).toContainEqual(original);
      expect(stub.requests.some((r) => r.includes('delete-item'))).toBe(false);
    });

    it('append adds verified chapters while retaining old items and excluding new foreign chapters', async () => {
      seedCity(stub);
      const id = stub.seedReadingList({
        title: 'Append',
        summary: buildCollectionDescription('append'),
        promoted: true,
        seriesIds: [11, 160],
      });
      const original = stub.getReadingList(id)!.items;
      stub.setSeriesChapterIds(160, [184, 185, 186, 187]);
      stub.setChapterIsbn(160, 2, '9781406331417');
      stub.setChapterTitle(160, 3, 'City of Bones');
      stub.setChapterWriters(160, 3, ['Martha Wells']);
      await target.updateCollection(`readinglist:${id}`, {
        itemIds: ['11', '160'],
        libraryId: '2',
        syncMode: 'append',
        matchedWorks: [{ itemId: '160', work: clareWork }],
      });
      expect(stub.getReadingList(id)!.items.slice(0, original.length)).toEqual(original);
      expect(stub.getReadingList(id)!.items.map((item) => item.chapterId)).toEqual([
        11000, 184, 185, 186,
      ]);
      expect(stub.requests.some((r) => r.includes('delete-item'))).toBe(false);
    });

    it('keeps whole-series membership for non-Books library types even with work matches', async () => {
      stub.seedLibrary(4, 'Comics', 0);
      stub.seedSeries({
        id: 170,
        name: 'Comic',
        libraryId: 4,
        pages: 20,
        chapterIds: [17001, 17002],
        chapterIsbns: [null, null],
      });
      const created = await target.createCollection({
        libraryId: '4',
        name: 'Comic',
        description: buildCollectionDescription('comic'),
        tags: [],
        ordered: true,
        itemIds: ['170'],
        matchedWorks: [{ itemId: '170', work: clareWork }],
      });
      expect(
        stub.getReadingList(Number(created.id.split(':')[1]))!.items.map((item) => item.chapterId),
      ).toEqual([17001, 17002]);
      expect(stub.requests.some((r) => r.includes('update-by-series'))).toBe(true);
      // A series-grain/comic caller needs the library type, but no canonical book context.
      await target.updateCollection(created.id, { itemIds: ['170'], libraryId: '4' });
    });

    it('reconciles replacement and added chapters when the ordered series ids are unchanged', async () => {
      const recipe = makeRecipe({ id: 'ordered', targets: [{ server: 'kavita', libraryId: '2' }] });
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [11, 12],
      });
      const original = stub.getReadingList(id)!.items;
      // Prime the identifier cache, then model a scan changing only chapter ids + scan time.
      await target.listItems('2');
      stub.setSeriesChapterIds(11, [11050, 11051]);
      stub.setChapterIsbn(11, 1, '9780316129084');
      stub.scanSeries(11, '2026-10-07T22:00:00Z');
      const works = [
        { identifiers: ['isbn:9780316129084'], label: 'Leviathan Wakes' },
        { identifiers: ['isbn:9780316129060'], label: "Caliban's War" },
      ];
      const result = await reconcileTarget(recipe, recipe.targets[0]!, target, works, silentLogger);
      const repaired = stub.getReadingList(id)!;
      expect(result.counts).toMatchObject({ added: 0, removed: 0, written: 2 });
      expect(repaired.items.map((item) => item.chapterId)).toEqual([11050, 11051, 12000]);
      expect(repaired.items.at(-1)!.id).toBe(original.at(-1)!.id);
      expect(repaired.items.some((item) => item.id === original[0]!.id)).toBe(false);
      const beforeRepeat = stub.requests.length;
      await reconcileTarget(recipe, recipe.targets[0]!, target, works, silentLogger);
      expect(stub.getReadingList(id)!.items).toEqual(repaired.items);
      expect(
        stub.requests
          .slice(beforeRepeat)
          .filter((r) => /update-by-(?:series|chapter)|delete-item|update-position/.test(r)),
      ).toEqual([]);
    });

    it('leaves all existing items intact when any desired series detail read is incomplete', async () => {
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [13, 11],
      });
      const original = stub.getReadingList(id)!.items;
      stub.setSeriesDetailIncomplete(12, true);
      await expect(
        target.updateCollection(`readinglist:${id}`, {
          itemIds: ['11', '12'],
          ...bookContext(['11', '12']),
        }),
      ).rejects.toThrow('incomplete chapter read');
      expect(stub.getReadingList(id)!.items).toEqual(original);
      expect(
        stub.requests.filter((r) =>
          /update-by-(?:series|chapter)|delete-item|update-position/.test(r),
        ),
      ).toEqual([]);
    });

    it('retains old chapters when successful append responses do not confirm the replacement', async () => {
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [11, 12],
      });
      const original = stub.getReadingList(id)!.items;
      stub.setSeriesChapterIds(11, [11050]);
      stub.suppressChapterAdds = true;
      await expect(
        target.updateCollection(`readinglist:${id}`, {
          itemIds: ['11', '12'],
          ...bookContext(['11', '12']),
        }),
      ).rejects.toThrow('chapter additions not confirmed');
      expect(stub.getReadingList(id)!.items).toEqual(original);
      expect(stub.requests.filter((r) => r.includes('delete-item'))).toHaveLength(0);
    });

    it('keeps distinct duplicate-file chapters and surviving item ids in stable source order', async () => {
      stub.setChapterTitle(15, 1, 'Outlander');
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [15, 11],
      });
      const originals = new Map(
        stub.getReadingList(id)!.items.map((item) => [item.chapterId, item.id]),
      );
      stub.setSeriesChapterIds(15, [15002, 15000, 15001]);
      stub.setChapterTitle(15, 2, 'Outlander');
      stub.setChapterWriters(15, 2, ['Diana Gabaldon']);
      await target.updateCollection(`readinglist:${id}`, {
        itemIds: ['11', '15'],
        ...bookContext(['11', '15']),
      });
      const repaired = stub.getReadingList(id)!.items;
      expect(repaired.map((item) => item.chapterId)).toEqual([11000, 15002, 15000, 15001]);
      for (const item of repaired)
        if (originals.has(item.chapterId)) expect(item.id).toBe(originals.get(item.chapterId));
      const beforeRepeat = stub.requests.length;
      await target.updateCollection(`readinglist:${id}`, {
        itemIds: ['11', '15'],
        ...bookContext(['11', '15']),
      });
      expect(stub.getReadingList(id)!.items).toEqual(repaired);
      expect(
        stub.requests
          .slice(beforeRepeat)
          .filter((r) => /update-by-(?:series|chapter)|delete-item|update-position/.test(r)),
      ).toEqual([]);
    });

    it('retains old references when a scan changes chapter identities during the append', async () => {
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [11, 12],
      });
      const original = stub.getReadingList(id)!.items;
      stub.setSeriesChapterIds(11, [11050]);
      stub.afterChapterAdd = () => stub.setSeriesChapterIds(11, [11099]);
      await expect(
        target.updateCollection(`readinglist:${id}`, {
          itemIds: ['11', '12'],
          ...bookContext(['11', '12']),
        }),
      ).rejects.toThrow('chapters changed during reconcile');
      for (const item of original) expect(stub.getReadingList(id)!.items).toContainEqual(item);
      expect(stub.requests.filter((r) => r.includes('delete-item'))).toHaveLength(0);
    });

    it('append adds current chapters without removing departed chapter references', async () => {
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [11],
      });
      const original = stub.getReadingList(id)!.items[0]!;
      stub.setSeriesChapterIds(11, [11050]);
      await target.updateCollection(`readinglist:${id}`, {
        itemIds: ['11'],
        syncMode: 'append',
        ...bookContext(['11']),
      });
      expect(stub.getReadingList(id)!.items.map((item) => item.chapterId)).toEqual([11000, 11050]);
      expect(stub.getReadingList(id)!.items[0]).toEqual(original);
      expect(stub.requests.filter((r) => r.includes('delete-item'))).toHaveLength(0);
    });

    it('creates a reading list with the marker and appends series in source order', async () => {
      const created = await target.createCollection({
        name: 'Expanse In Order',
        description: buildCollectionDescription('expanse-ordered'),
        itemIds: ['12', '11'],
        ...bookContext(['12', '11']),
        ordered: true,
      });
      expect(created.kind).toBe('kavita_reading_list');
      const raw = stub.getReadingList(Number(created.id.split(':')[1]))!;
      expect(recipeIdFromDescription(raw.summary!)).toBe('expanse-ordered');
      expect(raw.seriesOrder).toEqual([12, 11]);
    });

    it('listCollections exposes reading lists with deduplicated ordered series ids', async () => {
      stub.seedSeries({
        id: 15,
        name: 'Two Chapter Series',
        libraryId: 2,
        pages: 50,
        chapterIsbns: ['9780316129084', null],
      });
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [15, 11],
      });
      const lists = await target.listCollections('2');
      const list = lists.find((collection) => collection.id === `readinglist:${id}`)!;
      expect(list.kind).toBe('kavita_reading_list');
      // 15 has two chapter items but appears once, in order.
      expect(list.itemIds).toEqual(['15', '11']);
    });

    it('update removes departed series, appends new ones, and reorders to source order', async () => {
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [13, 11],
      });
      const updated = await target.updateCollection(`readinglist:${id}`, {
        itemIds: ['12', '11'],
        ...bookContext(['12', '11']),
      });
      expect(updated.itemIds).toEqual(['12', '11']);
      expect(stub.getReadingList(id)!.seriesOrder).toEqual([12, 11]);
      const calls = stub.requests;
      expect(calls.filter((r) => r.includes('delete-item')).length).toBeGreaterThan(0);
      expect(calls.filter((r) => r.includes('update-by-chapter')).length).toBeGreaterThan(0);
      expect(calls.filter((r) => r.includes('update-position')).length).toBeGreaterThan(0);
    });

    it('reorder is a no-op when the order already matches', async () => {
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [11, 12],
      });
      await target.updateCollection(`readinglist:${id}`, {
        itemIds: ['11', '12'],
        ...bookContext(['11', '12']),
      });
      expect(stub.requests.filter((r) => r.includes('update-position'))).toHaveLength(0);
    });
  });
});
