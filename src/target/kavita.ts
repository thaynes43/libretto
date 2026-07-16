import type { DiskCache } from '../cache/disk.js';
import type { ServiceEndpoint } from '../config.js';
import { HttpError, fetchJson, joinUrl } from '../http.js';
import { normalizeIdentifiers } from '../identifiers.js';
import type { Logger } from '../logger.js';
import { recipeIdFromDescription } from './marker.js';
import type {
  CreateCollectionInput,
  TargetClient,
  TargetCollection,
  TargetItem,
  UpdateCollectionInput,
} from './types.js';

/**
 * Kavita target (DESIGN-037 D-06/D-07), verified against the Kavita source
 * (v0.8.9.1 and develop, github.com/Kareadita/Kavita, 2026-07):
 *
 * - AUTH: POST /api/Plugin/authenticate?apiKey=&pluginName=libretto (query
 *   params, no body) returns a UserDto whose `token` is a JWT good for 10 days;
 *   subsequent calls send `Authorization: Bearer <token>`. The token is cached
 *   and a 401 triggers exactly one re-auth + retry.
 * - IDENTIFIER SPIKE FINDING: Kavita exposes ISBN per CHAPTER (ChapterDto.isbn),
 *   not per series — SeriesDto/SeriesMetadataDto carry none. The practical path
 *   is GET /api/Series/volumes?seriesId= and collecting every chapter's isbn.
 *   That is an extra call per series, so resolved identifier sets ride the TTL
 *   disk cache keyed by seriesId + the series' page count (content changes move
 *   the page count, which busts the key early). Coverage caveat: Kavita only
 *   parses an epub identifier into ISBN when the OPF <dc:identifier> carries
 *   opf:scheme="ISBN" (or an isbn:/urn:isbn: prefix it can validate) — EPUB3
 *   files without the scheme attribute yield NO isbn, so expect honest gaps
 *   (those series simply cannot match and recipes report missing[]).
 * - MARKER SPIKE FINDING: descriptions ARE API-writable on both container
 *   kinds — collection `summary` via POST /api/Collection/update (full DTO) and
 *   reading-list `summary` via POST /api/ReadingList/update. The provenance
 *   marker therefore lives in the target itself on Kavita too, and the design's
 *   sidecar-ownership fallback stays unbuilt.
 * - D-07 mapping: ordered recipes materialize as READING LISTS (create,
 *   update-by-series per series in order, update-position to reorder,
 *   delete-item to remove); unordered ones as COLLECTIONS (update-for-series to
 *   add — collectionTagId 0 creates implicitly — and update-series with
 *   seriesIdsToRemove to remove). Collection membership is unordered by nature.
 * - Collections and reading lists are PER-USER (AppUserCollection since v0.8):
 *   Libretto sees its own plus other users' promoted ones, and can only mutate
 *   its own. Creates request promoted=true so the household sees them; Kavita
 *   silently skips the flag unless the account has the Promote (or Admin) role.
 * - Membership unit is the SERIES (TargetItem.id = series id as string).
 *   Container ids are namespaced "collection:<id>" / "readinglist:<id>" since
 *   the two id spaces are independent. Kavita collections span libraries; the
 *   returned libraryId is the one the listing was asked for.
 * - Membership (series ids) is fetched only for containers whose description
 *   carries a Libretto marker — unmarked containers are never touched by the
 *   reconciler, so their members are not worth one request each per run.
 */

const SERIES_PAGE_SIZE = 200;
const ISBN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface KavitaLibrary {
  id: number;
  name: string;
}

interface KavitaSeries {
  id: number;
  name: string;
  pages: number;
}

interface KavitaVolume {
  chapters?: { isbn?: string | null }[];
}

interface KavitaCollection {
  id: number;
  title: string;
  summary: string | null;
  promoted: boolean;
  coverImageLocked?: boolean;
}

interface KavitaReadingList {
  id: number;
  title: string;
  summary: string | null;
  promoted: boolean;
}

interface KavitaReadingListItem {
  id: number;
  order: number;
  seriesId: number;
}

function collectionId(id: number): string {
  return `collection:${id}`;
}

function readingListId(id: number): string {
  return `readinglist:${id}`;
}

function parseContainerId(raw: string): { kind: 'collection' | 'readinglist'; id: number } {
  const match = /^(collection|readinglist):(\d+)$/.exec(raw);
  if (!match) throw new Error(`not a kavita container id: ${raw}`);
  return { kind: match[1] as 'collection' | 'readinglist', id: Number(match[2]) };
}

export class KavitaTarget implements TargetClient {
  readonly server = 'kavita';
  private token: string | undefined;

  constructor(
    private readonly endpoint: ServiceEndpoint,
    private readonly log: Logger,
    private readonly cache: DiskCache,
  ) {}

  // --- auth ---------------------------------------------------------------

  private async authenticate(): Promise<string> {
    const url = joinUrl(
      this.endpoint.url,
      `/api/Plugin/authenticate?apiKey=${encodeURIComponent(this.endpoint.apiKey)}&pluginName=libretto`,
    );
    const user = await fetchJson<{ token: string }>(url, { method: 'POST' });
    this.token = user.token;
    this.log.debug('kavita: authenticated (plugin JWT, 10-day lifetime)');
    return user.token;
  }

  /** Bearer-authenticated request with a single re-auth retry on 401. */
  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{
    data: T;
    headers: Headers;
  }> {
    const token = this.token ?? (await this.authenticate());
    const url = joinUrl(this.endpoint.url, path);
    const send = async (bearer: string) => {
      const response = await fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${bearer}`,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await response.text();
      if (!response.ok) throw new HttpError(response.status, url, text.slice(0, 300));
      return {
        data: (text.length === 0 ? undefined : JSON.parse(text)) as T,
        headers: response.headers,
      };
    };
    try {
      return await send(token);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        this.log.info('kavita: token rejected, re-authenticating');
        return send(await this.authenticate());
      }
      throw error;
    }
  }

  private async get<T>(path: string): Promise<T> {
    return (await this.request<T>(path)).data;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>(path, { method: 'POST', body: body ?? {} })).data;
  }

  // --- libraries + items ----------------------------------------------------

  async listLibraries(): Promise<{ id: string; name: string }[]> {
    const libraries = await this.get<KavitaLibrary[]>('/api/Library/libraries');
    return libraries.map((library) => ({ id: String(library.id), name: library.name }));
  }

  async listItems(libraryId: string): Promise<TargetItem[]> {
    const series = await this.listSeries(libraryId);
    const items: TargetItem[] = [];
    for (const one of series) {
      items.push({
        id: String(one.id),
        title: one.name,
        identifiers: await this.seriesIdentifiers(one),
      });
    }
    this.log.debug({ libraryId, items: items.length }, 'kavita: listed series');
    return items;
  }

  private async listSeries(libraryId: string): Promise<KavitaSeries[]> {
    // FilterV2Dto: restrict to the library via a statement (field 19 =
    // Libraries, comparison 0 = Equal; values are always strings). The response
    // body is a bare SeriesDto[]; pagination metadata rides the `Pagination`
    // response header as JSON.
    const filter = {
      statements: [{ comparison: 0, field: 19, value: libraryId }],
      combination: 1,
      limitTo: 0,
    };
    const all: KavitaSeries[] = [];
    for (let page = 1; ; page++) {
      const { data, headers } = await this.request<KavitaSeries[]>(
        `/api/Series/all-v2?PageNumber=${page}&PageSize=${SERIES_PAGE_SIZE}`,
        { method: 'POST', body: filter },
      );
      all.push(...data);
      const pagination = headers.get('pagination');
      const totalPages = pagination
        ? (JSON.parse(pagination) as { totalPages?: number }).totalPages
        : undefined;
      if (totalPages === undefined ? data.length < SERIES_PAGE_SIZE : page >= totalPages) break;
    }
    return all;
  }

  private async seriesIdentifiers(series: KavitaSeries): Promise<string[]> {
    // ISBNs live on chapters (see the header note); page count in the cache key
    // busts the entry as soon as the series' content changes.
    const key = `kavita:series-isbns:v1:${series.id}:${series.pages}`;
    return this.cache.getOrSet(key, ISBN_CACHE_TTL_MS, async () => {
      const volumes = await this.get<KavitaVolume[]>(`/api/Series/volumes?seriesId=${series.id}`);
      return normalizeIdentifiers(
        volumes.flatMap((volume) => (volume.chapters ?? []).map((chapter) => chapter.isbn)),
      );
    });
  }

  // --- collections + reading lists ------------------------------------------

  async listCollections(libraryId: string): Promise<TargetCollection[]> {
    const out: TargetCollection[] = [];

    const collections = await this.get<KavitaCollection[]>('/api/Collection');
    for (const collection of collections) {
      const marked = recipeIdFromDescription(collection.summary ?? undefined) !== undefined;
      out.push({
        id: collectionId(collection.id),
        libraryId,
        name: collection.title,
        description: collection.summary ?? '',
        tags: [],
        itemIds: marked ? await this.collectionSeriesIds(collection.id) : [],
        kind: 'kavita_collection',
      });
    }

    const lists = await this.post<KavitaReadingList[]>(
      '/api/ReadingList/lists?PageNumber=1&PageSize=1000&includePromoted=true',
    );
    for (const list of lists) {
      const marked = recipeIdFromDescription(list.summary ?? undefined) !== undefined;
      out.push({
        id: readingListId(list.id),
        libraryId,
        name: list.title,
        description: list.summary ?? '',
        tags: [],
        itemIds: marked ? seriesOrder(await this.readingListItems(list.id)) : [],
        kind: 'kavita_reading_list',
      });
    }

    return out;
  }

  private async collectionSeriesIds(id: number): Promise<string[]> {
    const series = await this.get<KavitaSeries[]>(
      `/api/Series/series-by-collection?collectionId=${id}&PageNumber=1&PageSize=1000`,
    );
    return series.map((one) => String(one.id));
  }

  private async readingListItems(id: number): Promise<KavitaReadingListItem[]> {
    const items = await this.get<KavitaReadingListItem[]>(
      `/api/ReadingList/items?readingListId=${id}`,
    );
    return [...items].sort((a, b) => a.order - b.order);
  }

  async createCollection(input: CreateCollectionInput): Promise<TargetCollection> {
    return input.ordered ? this.createReadingList(input) : this.createUnorderedCollection(input);
  }

  private async createUnorderedCollection(input: CreateCollectionInput): Promise<TargetCollection> {
    // collectionTagId 0 + a title creates the collection implicitly.
    await this.post('/api/Collection/update-for-series', {
      collectionTagId: 0,
      collectionTagTitle: input.name,
      seriesIds: input.itemIds.map(Number),
    });
    const created = (await this.get<KavitaCollection[]>('/api/Collection?ownedOnly=true')).find(
      (collection) => collection.title === input.name,
    );
    if (!created) throw new Error(`kavita did not report the created collection "${input.name}"`);
    // Second write plants the marker (summary) and requests promotion.
    await this.post('/api/Collection/update', {
      ...created,
      summary: input.description,
      promoted: true,
    });
    return {
      id: collectionId(created.id),
      libraryId: input.libraryId,
      name: input.name,
      description: input.description,
      tags: [],
      itemIds: input.itemIds.map(String),
      kind: 'kavita_collection',
    };
  }

  private async createReadingList(input: CreateCollectionInput): Promise<TargetCollection> {
    const list = await this.post<KavitaReadingList>('/api/ReadingList/create', {
      title: input.name,
    });
    await this.post('/api/ReadingList/update', {
      readingListId: list.id,
      title: input.name,
      summary: input.description,
      promoted: true,
    });
    for (const seriesId of input.itemIds) {
      // Appends the whole series' chapters in call order = source order.
      await this.post('/api/ReadingList/update-by-series', {
        readingListId: list.id,
        seriesId: Number(seriesId),
      });
    }
    return {
      id: readingListId(list.id),
      libraryId: input.libraryId,
      name: input.name,
      description: input.description,
      tags: [],
      itemIds: [...input.itemIds],
      kind: 'kavita_reading_list',
    };
  }

  async updateCollection(
    containerId: string,
    patch: UpdateCollectionInput,
  ): Promise<TargetCollection> {
    const { kind, id } = parseContainerId(containerId);
    return kind === 'collection'
      ? this.updateUnorderedCollection(id, patch.itemIds)
      : this.updateReadingList(id, patch.itemIds);
  }

  private async updateUnorderedCollection(
    id: number,
    itemIds: string[],
  ): Promise<TargetCollection> {
    const dto = (await this.get<KavitaCollection[]>('/api/Collection')).find(
      (collection) => collection.id === id,
    );
    if (!dto) throw new Error(`kavita collection ${id} not found`);
    const current = await this.collectionSeriesIds(id);
    const currentSet = new Set(current);
    const desired = new Set(itemIds);
    const toAdd = itemIds.filter((seriesId) => !currentSet.has(seriesId));
    const toRemove = current.filter((seriesId) => !desired.has(seriesId));
    // Add before remove: update-series deletes a collection that goes empty,
    // and the reconciler never asks for an empty membership anyway.
    if (toAdd.length > 0) {
      await this.post('/api/Collection/update-for-series', {
        collectionTagId: id,
        collectionTagTitle: dto.title,
        seriesIds: toAdd.map(Number),
      });
    }
    if (toRemove.length > 0) {
      await this.post('/api/Collection/update-series', {
        tag: dto,
        seriesIdsToRemove: toRemove.map(Number),
      });
    }
    return {
      id: collectionId(id),
      libraryId: '',
      name: dto.title,
      description: dto.summary ?? '',
      tags: [],
      itemIds: [...itemIds],
      kind: 'kavita_collection',
    };
  }

  private async updateReadingList(id: number, itemIds: string[]): Promise<TargetCollection> {
    const desired = new Set(itemIds);

    // Remove items of series that left the recipe.
    for (const item of await this.readingListItems(id)) {
      if (desired.has(String(item.seriesId))) continue;
      await this.post('/api/ReadingList/delete-item', {
        readingListId: id,
        readingListItemId: item.id,
        fromPosition: item.order,
        toPosition: item.order,
      });
    }

    // Append series that are new (update-by-series appends all its chapters).
    const present = new Set((await this.readingListItems(id)).map((item) => String(item.seriesId)));
    for (const seriesId of itemIds) {
      if (present.has(seriesId)) continue;
      await this.post('/api/ReadingList/update-by-series', {
        readingListId: id,
        seriesId: Number(seriesId),
      });
    }

    // Reorder to the source order: group items by series (keeping in-series
    // chapter order) and walk the list into place with update-position moves.
    // Kavita re-packs orders to contiguous 0-based values after every mutation,
    // so array index == order here.
    const items = await this.readingListItems(id);
    const bySeries = new Map<string, KavitaReadingListItem[]>();
    for (const item of items) {
      const key = String(item.seriesId);
      const group = bySeries.get(key) ?? [];
      group.push(item);
      bySeries.set(key, group);
    }
    const target = itemIds.flatMap((seriesId) => bySeries.get(seriesId) ?? []);
    const working = [...items];
    for (let i = 0; i < target.length; i++) {
      if (working[i]!.id === target[i]!.id) continue;
      const from = working.findIndex((item) => item.id === target[i]!.id);
      await this.post('/api/ReadingList/update-position', {
        readingListId: id,
        readingListItemId: target[i]!.id,
        fromPosition: from,
        toPosition: i,
      });
      const [moved] = working.splice(from, 1);
      working.splice(i, 0, moved!);
    }

    const lists = await this.post<KavitaReadingList[]>(
      '/api/ReadingList/lists?PageNumber=1&PageSize=1000&includePromoted=true',
    );
    const dto = lists.find((list) => list.id === id);
    return {
      id: readingListId(id),
      libraryId: '',
      name: dto?.title ?? '',
      description: dto?.summary ?? '',
      tags: [],
      itemIds: seriesOrder(await this.readingListItems(id)),
      kind: 'kavita_reading_list',
    };
  }
}

/** Ordered, deduplicated series ids from chapter-level reading-list items. */
function seriesOrder(items: KavitaReadingListItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const seriesId = String(item.seriesId);
    if (seen.has(seriesId)) continue;
    seen.add(seriesId);
    out.push(seriesId);
  }
  return out;
}
