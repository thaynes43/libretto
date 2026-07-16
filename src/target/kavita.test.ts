import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KavitaTarget } from './kavita.js';
import { buildCollectionDescription, recipeIdFromDescription } from './marker.js';
import { DiskCache } from '../cache/disk.js';
import { KavitaStub } from '../testing/kavita-stub.js';
import { startStubServer } from '../testing/http.js';
import { makeTempDir, silentLogger } from '../testing/fixtures.js';

const API_KEY = 'kavita-api-key';

describe('KavitaTarget', () => {
  let stub: KavitaStub;
  let close: () => Promise<void>;
  let cleanup: () => Promise<void>;
  let cache: DiskCache;
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
      id: 14,
      name: 'Elsewhere',
      libraryId: 3,
      pages: 10,
      chapterIsbns: ['9780553418026'],
    });

    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    cache = new DiskCache(path.join(tmp.dir, 'cache'));
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
      ]);
      // 3 matching series at the stub's page cap of 2 = two all-v2 pages.
      expect(stub.requests.filter((r) => r.includes('/api/Series/all-v2'))).toHaveLength(2);
    });

    it('caches per-series ISBN lookups and busts the key when the page count changes', async () => {
      await target.listItems('2');
      const volumeCalls = () => stub.requests.filter((r) => r.includes('/api/Series/volumes'));
      const afterFirst = volumeCalls().length;
      expect(afterFirst).toBe(3);

      await target.listItems('2');
      expect(volumeCalls()).toHaveLength(afterFirst); // all served from disk cache

      // Content change: the series' page count moves, so the key rotates.
      stub.setSeriesPages(11, 700);
      await target.listItems('2');
      expect(volumeCalls()).toHaveLength(afterFirst + 1);
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
    it('creates a reading list with the marker and appends series in source order', async () => {
      const created = await target.createCollection({
        libraryId: '2',
        name: 'Expanse In Order',
        description: buildCollectionDescription('expanse-ordered'),
        itemIds: ['12', '11'],
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
      });
      expect(updated.itemIds).toEqual(['12', '11']);
      expect(stub.getReadingList(id)!.seriesOrder).toEqual([12, 11]);
      const calls = stub.requests;
      expect(calls.filter((r) => r.includes('delete-item')).length).toBeGreaterThan(0);
      expect(calls.filter((r) => r.includes('update-by-series')).length).toBeGreaterThan(0);
      expect(calls.filter((r) => r.includes('update-position')).length).toBeGreaterThan(0);
    });

    it('reorder is a no-op when the order already matches', async () => {
      const id = stub.seedReadingList({
        title: 'Ordered',
        summary: buildCollectionDescription('ordered'),
        promoted: true,
        seriesIds: [11, 12],
      });
      await target.updateCollection(`readinglist:${id}`, { itemIds: ['11', '12'] });
      expect(stub.requests.filter((r) => r.includes('update-position'))).toHaveLength(0);
    });
  });
});
