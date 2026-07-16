import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsTarget } from './abs.js';
import { buildCollectionDescription, recipeIdFromDescription } from './marker.js';
import { AbsStub } from '../testing/abs-stub.js';
import { startStubServer } from '../testing/http.js';
import { silentLogger } from '../testing/fixtures.js';

const TOKEN = 'abs-test-token';

describe('AbsTarget', () => {
  let stub: AbsStub;
  let close: () => Promise<void>;
  let url: string;
  let target: AbsTarget;

  beforeEach(async () => {
    stub = new AbsStub(TOKEN);
    stub.seedLibrary('lib-1', 'Audiobooks', [
      { id: 'li-1', title: 'Leviathan Wakes', isbn: '9780316129084' },
      { id: 'li-2', title: "Caliban's War", asin: 'B0071IHYRW' },
      { id: 'li-3', title: "Abaddon's Gate", isbn: '0316129070' },
      { id: 'li-4', title: 'No Identifiers Here' },
    ]);
    const server = await startStubServer(stub.app);
    close = server.close;
    url = server.url;
    target = new AbsTarget({ url, apiKey: TOKEN }, silentLogger);
  });

  afterEach(async () => {
    await close();
  });

  it('lists libraries', async () => {
    expect(await target.listLibraries()).toEqual([{ id: 'lib-1', name: 'Audiobooks' }]);
  });

  it('lists items with normalized isbn/asin identifiers, paginating', async () => {
    const items = await target.listItems('lib-1');
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({
      id: 'li-1',
      title: 'Leviathan Wakes',
      identifiers: ['isbn:9780316129084'],
    });
    expect(items[1]!.identifiers).toEqual(['asin:B0071IHYRW']);
    // ISBN-10 is converted to ISBN-13 so both sides land on one key.
    expect(items[2]!.identifiers).toEqual(['isbn:9780316129077']);
    // An item with no identifiers is listed (it just can never match).
    expect(items[3]!.identifiers).toEqual([]);
    // Pagination: 4 items at page size 500 is one page.
    expect(stub.requests.filter((r) => r.includes('/items')).length).toBe(1);
  });

  it('rejects a bad token with an honest HTTP error', async () => {
    const wrong = new AbsTarget({ url, apiKey: 'nope' }, silentLogger);
    await expect(wrong.listLibraries()).rejects.toThrow('HTTP 401');
  });

  it('creates an ordered collection whose description carries the marker', async () => {
    const created = await target.createCollection({
      libraryId: 'lib-1',
      name: 'Expanse',
      description: buildCollectionDescription('expanse'),
      itemIds: ['li-2', 'li-1'],
      ordered: true,
    });
    expect(created.kind).toBe('abs_collection');
    expect(created.itemIds).toEqual(['li-2', 'li-1']);
    expect(recipeIdFromDescription(created.description)).toBe('expanse');

    // Round-trip: listCollections recovers it, marker intact.
    const listed = await target.listCollections('lib-1');
    expect(listed).toHaveLength(1);
    expect(recipeIdFromDescription(listed[0]!.description)).toBe('expanse');
    expect(listed[0]!.itemIds).toEqual(['li-2', 'li-1']);
  });

  it('filters collections to the requested library', async () => {
    stub.seedCollection({
      libraryId: 'lib-other',
      name: 'Elsewhere',
      description: null,
      bookIds: [],
    });
    expect(await target.listCollections('lib-1')).toEqual([]);
  });

  it('updateCollection adds, removes, and reorders through the batch endpoints', async () => {
    const id = stub.seedCollection({
      libraryId: 'lib-1',
      name: 'Expanse',
      description: buildCollectionDescription('expanse'),
      bookIds: ['li-1', 'li-4'],
    });

    const updated = await target.updateCollection(id, { itemIds: ['li-3', 'li-1', 'li-2'] });
    expect(updated.itemIds).toEqual(['li-3', 'li-1', 'li-2']);
    expect(stub.getCollection(id)!.bookIds).toEqual(['li-3', 'li-1', 'li-2']);

    // The write went through batch/remove (li-4), batch/add (li-3, li-2), then
    // a PATCH for order — never a membership-by-PATCH (which ABS ignores).
    const calls = stub.requests.filter((r) => r.includes(`/api/collections/${id}`));
    expect(calls).toContain(`POST /api/collections/${id}/batch/remove`);
    expect(calls).toContain(`POST /api/collections/${id}/batch/add`);
    expect(calls).toContain(`PATCH /api/collections/${id}`);
  });

  it('updateCollection skips the reorder PATCH when order already matches', async () => {
    const id = stub.seedCollection({
      libraryId: 'lib-1',
      name: 'Expanse',
      description: buildCollectionDescription('expanse'),
      bookIds: ['li-1', 'li-2'],
    });
    await target.updateCollection(id, { itemIds: ['li-1', 'li-2', 'li-3'] });
    const patches = stub.requests.filter((r) => r === `PATCH /api/collections/${id}`);
    expect(patches).toHaveLength(0);
    expect(stub.getCollection(id)!.bookIds).toEqual(['li-1', 'li-2', 'li-3']);
  });
});
