import type { DiskCache } from '../cache/disk.js';
import type { ServiceEndpoint } from '../config.js';
import { HttpError, fetchJson, joinUrl } from '../http.js';
import { normalizeIdentifiers } from '../identifiers.js';
import type { Logger } from '../logger.js';
import { recipeIdFromDescription } from './marker.js';
import { selectBookChapters, type KavitaChapter } from './kavita-chapters.js';
import type {
  CreateCollectionInput,
  MatchedWork,
  TargetClient,
  TargetCollection,
  TargetItem,
  UpdateCollectionInput,
} from './types.js';

/**
 * Kavita target (DESIGN-037 D-06/D-07), verified against the Kavita source
 * (v0.8.9.1 and v0.9.0.2, github.com/Kareadita/Kavita):
 *
 * - AUTH: POST /api/Plugin/authenticate?apiKey=&pluginName=libretto (query
 *   params, no body) returns a UserDto whose `token` is a JWT good for 10 days;
 *   subsequent calls send `Authorization: Bearer <token>`. The token is cached
 *   and a 401 triggers exactly one re-auth + retry.
 * - IDENTIFIER SPIKE FINDING: Kavita exposes ISBN per CHAPTER (ChapterDto.isbn),
 *   not per series — SeriesDto/SeriesMetadataDto carry none. The practical path
 *   is GET /api/Series/volumes?seriesId= and collecting every chapter's isbn.
 *   That is an extra call per series (about 3 ms of Kavita time each, measured
 *   2026-10-06 over 1,829 series), so resolved identifier sets ride the TTL disk
 *   cache: one entry per series, refetched when the series' fingerprint moves
 *   (page count, last folder scan, last chapter added) and at least every 12
 *   hours. A metadata edit made through Kavita's API (a chapter title fixed and
 *   locked, writers corrected) changes none of the SeriesDto fields, so a scan of
 *   the series after the edit makes it visible at the next listing, and the TTL
 *   bounds it to the same day without one (issue #25). Coverage caveat: Kavita only
 *   parses an epub identifier into ISBN when the OPF <dc:identifier> carries
 *   opf:scheme="ISBN" — an isbn:/urn:isbn: prefix alone does not pass that check. EPUB3
 *   files without the scheme attribute yield NO isbn, so expect honest gaps
 *   (those series simply cannot match and recipes report missing[]).
 * - BOOKS INSIDE A SERIES: the same volumes call carries each chapter's own
 *   title (`titleName`, the epub's dc:title) and its writers. An epub that
 *   names its series is filed as a volume of that series, so the series name
 *   ("Outlander") hides the book ("Written in My Own Heart's Blood", volume 8).
 *   Items therefore carry `books` (each chapter's title, and "<series>: <title>")
 *   plus `writers` (the chapters' Writer credits) and `folders` (where the
 *   chapter files live) beside the series name, cached with the ISBNs under the
 *   same key. Writers and folders only verify duplicates; they never act as the
 *   title fallback's author guard (see TargetItem.writers).
 * - MARKER SPIKE FINDING: descriptions ARE API-writable on both container
 *   kinds — collection `summary` via POST /api/Collection/update (full DTO) and
 *   reading-list `summary` via POST /api/ReadingList/update. The provenance
 *   marker therefore lives in the target itself on Kavita too, and the design's
 *   sidecar-ownership fallback stays unbuilt.
 * - D-07 mapping: ordered recipes materialize as READING LISTS (create,
 *   update-by-chapter for verified Book works, update-by-series at series grain,
 *   update-position to reorder,
 *   delete-item to remove); unordered ones as COLLECTIONS (update-for-series to
 *   add — collectionTagId 0 creates implicitly — and update-series with
 *   seriesIdsToRemove to remove). Collection membership is unordered by nature.
 * - Collections and reading lists are PER-USER (AppUserCollection since v0.8):
 *   Libretto sees its own plus other users' promoted ones, and can only mutate
 *   its own. Creates request promoted=true so the household sees them; Kavita
 *   silently skips the flag unless the account has the Promote (or Admin) role.
 * - Matching unit is the SERIES (TargetItem.id = series id as string). Ordered
 *   Book recipes carry each matched canonical work into the adapter, which selects
 *   fresh chapters by ISBN or full confirmed title plus agreeing Writer credits.
 *   Container ids are namespaced "collection:<id>" / "readinglist:<id>" since
 *   the two id spaces are independent. Kavita collections span libraries; the
 *   returned libraryId is the one the listing was asked for.
 * - Membership (series ids) is fetched only for containers whose description
 *   carries a Libretto marker — unmarked containers are never touched by the
 *   reconciler, so their members are not worth one request each per run.
 */

const SERIES_PAGE_SIZE = 200;
/**
 * How long a series' cached detail is trusted when its fingerprint has not moved (issue #25): a metadata edit
 * made without a scan reaches the matcher within this. A full refresh of the books library costs about 1,800
 * volumes calls of about 3 ms each, so twice a day is cheap.
 */
const SERIES_DETAIL_TTL_MS = 12 * 60 * 60 * 1000;

interface KavitaLibrary {
  id: number;
  name: string;
  /** Kavita LibraryType.Book = 2; other types retain whole-series membership. */
  type?: number;
}

interface KavitaSeries {
  id: number;
  name: string;
  pages: number;
  /** When Kavita last scanned the series' folder: a library scan that saw it change, or "Scan Series". */
  lastFolderScanned?: string | null;
  lastFolderScannedUtc?: string | null;
  lastChapterAddedUtc?: string | null;
}

/** A series' detail on disk, with the fingerprint of the series it was read from. */
interface CachedSeriesDetail {
  fingerprint: string;
  detail: KavitaSeriesDetail;
}

/**
 * The SeriesDto fields that move when a series' content or files change: its page count, its last folder scan and
 * its last chapter added. A cached detail is reused only while these match.
 */
function seriesFingerprint(series: KavitaSeries): string {
  return [
    series.pages,
    series.lastFolderScannedUtc ?? series.lastFolderScanned ?? '',
    series.lastChapterAddedUtc ?? '',
  ].join('|');
}

interface KavitaVolume {
  minNumber?: number;
  chapters?: KavitaChapter[];
}

interface ReadingListPlan {
  selective: boolean;
  expected: Map<string, number[]>;
  order: { seriesId: string; chapterId: number }[];
  fingerprints: Map<string, string>;
}

/** Compare membership and book identity, excluding volatile reading progress in ChapterDto. */
function chapterFingerprint(chapters: KavitaChapter[], selective: boolean): string {
  return JSON.stringify(
    selective
      ? chapters.map((chapter) => [
          chapter.id,
          chapter.sortOrder,
          chapter.isbn,
          chapter.titleName,
          chapter.title,
          chapter.writers?.map((writer) => writer.name ?? '').sort(),
        ])
      : chapters.map((chapter) => chapter.id),
  );
}

/** What a series' volumes say about it: chapter ISBNs, the books it holds, and their writers. */
interface KavitaSeriesDetail {
  identifiers: string[];
  books: string[][];
  writers: string[];
  folders: string[];
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
  chapterId: number;
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
      const detail = await this.seriesDetail(one);
      items.push({
        id: String(one.id),
        title: one.name,
        identifiers: detail.identifiers,
        ...(detail.books.length > 0 ? { books: detail.books } : {}),
        ...(detail.writers.length > 0 ? { writers: detail.writers } : {}),
        ...(detail.folders.length > 0 ? { folders: detail.folders } : {}),
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

  private async seriesDetail(series: KavitaSeries): Promise<KavitaSeriesDetail> {
    // ISBNs, book titles and writers all live on chapters (see the header note), so one
    // volumes call per series feeds all three. One entry per series (so a new fingerprint
    // overwrites it rather than leaving the old one behind); the version busts it when this
    // shape does.
    const key = `kavita:series-detail:v3:${series.id}`;
    const fingerprint = seriesFingerprint(series);
    const cached = await this.cache.get<CachedSeriesDetail>(key);
    if (cached?.fingerprint === fingerprint) return cached.detail;
    const detail = await this.fetchSeriesDetail(series);
    await this.cache.set<CachedSeriesDetail>(key, { fingerprint, detail }, SERIES_DETAIL_TTL_MS);
    return detail;
  }

  private async fetchSeriesDetail(series: KavitaSeries): Promise<KavitaSeriesDetail> {
    const volumes = await this.get<KavitaVolume[]>(`/api/Series/volumes?seriesId=${series.id}`);
    const chapters = volumes.flatMap((volume) => volume.chapters ?? []);
    return {
      identifiers: normalizeIdentifiers(chapters.map((chapter) => chapter.isbn)),
      books: seriesBooks(series.name, chapters),
      writers: [
        ...new Set(
          chapters.flatMap((chapter) =>
            (chapter.writers ?? [])
              .map((writer) => writer.name?.trim() ?? '')
              .filter((name) => name.length > 0),
          ),
        ),
      ],
      folders: [
        ...new Set(
          chapters.flatMap((chapter) =>
            (chapter.files ?? [])
              .map((file) => file.filePath?.trim() ?? '')
              .filter((filePath) => filePath.includes('/'))
              .map((filePath) => filePath.slice(0, filePath.lastIndexOf('/'))),
          ),
        ),
      ],
    };
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
    if (
      !Array.isArray(items) ||
      items.some(
        (item) =>
          !Number.isInteger(item.id) ||
          item.id <= 0 ||
          !Number.isInteger(item.seriesId) ||
          item.seriesId <= 0 ||
          !Number.isInteger(item.chapterId) ||
          item.chapterId <= 0 ||
          !Number.isInteger(item.order) ||
          item.order < 0,
      )
    )
      throw new Error(
        `kavita reading list ${id}: incomplete item read; leaving existing items intact`,
      );
    return [...items].sort((a, b) => a.order - b.order);
  }

  /** Fresh chapter membership, never inferred from the cached book identities or a series id. */
  private async currentChapters(seriesId: string): Promise<KavitaChapter[]> {
    const volumes = await this.get<KavitaVolume[]>(`/api/Series/volumes?seriesId=${seriesId}`);
    if (
      !Array.isArray(volumes) ||
      volumes.length === 0 ||
      volumes.some(
        (volume) =>
          !Number.isFinite(volume.minNumber) ||
          !Array.isArray(volume.chapters) ||
          volume.chapters.length === 0 ||
          volume.chapters.some((chapter) => !Number.isFinite(chapter.sortOrder)),
      )
    )
      throw new Error(
        `kavita series ${seriesId}: incomplete chapter read; leaving existing items intact`,
      );
    const chapters = volumes
      .flatMap((volume) =>
        volume.chapters!.map((chapter) => ({ chapter, minNumber: volume.minNumber! })),
      )
      .sort(
        (a, b) =>
          a.minNumber - b.minNumber ||
          a.chapter.sortOrder! - b.chapter.sortOrder! ||
          (a.chapter.id ?? 0) - (b.chapter.id ?? 0),
      );
    const ids = chapters.map(({ chapter }) => chapter.id!);
    if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length)
      throw new Error(
        `kavita series ${seriesId}: incomplete chapter identities; leaving existing items intact`,
      );
    return chapters.map(({ chapter }) => chapter);
  }

  private async readingListPlan(
    itemIds: string[],
    libraryId?: string,
    matchedWorks?: MatchedWork[],
    syncMode: 'append' | 'sync' = 'sync',
  ): Promise<ReadingListPlan> {
    if (!libraryId)
      throw new Error(
        'kavita: reading-list library identity missing; leaving existing items intact',
      );
    const library = (await this.get<KavitaLibrary[]>('/api/Library/libraries')).find(
      (one) => String(one.id) === libraryId,
    );
    if (!library || ![0, 1, 2, 3, 4, 5].includes(library.type ?? -1))
      throw new Error('kavita: incomplete library type read; leaving existing items intact');
    const selective = library.type === 2;
    if (selective && !matchedWorks?.length)
      throw new Error('kavita: canonical book identities missing; leaving existing items intact');
    const expected = new Map<string, number[]>();
    const fingerprints = new Map<string, string>();
    const perWork = new Map<MatchedWork, number[]>();
    for (const seriesId of [...new Set(itemIds)]) {
      const matches = matchedWorks?.filter((match) => match.itemId === seriesId) ?? [];
      if (selective && matches.length === 0) {
        // Append may retain series which the current source no longer names. Never prune them.
        if (syncMode === 'append') continue;
        throw new Error(`kavita series ${seriesId}: canonical book identity missing`);
      }
      const chapters = await this.currentChapters(seriesId);
      fingerprints.set(seriesId, chapterFingerprint(chapters, selective));
      if (selective) {
        const selected = selectBookChapters(seriesId, chapters, matches);
        for (const [match, ids] of selected) perWork.set(match, ids);
        expected.set(seriesId, [...new Set([...selected.values()].flat())]);
      } else
        expected.set(
          seriesId,
          chapters.map((chapter) => chapter.id!),
        );
    }
    // Several canonical books may share an old series id. Their source positions still interleave
    // correctly with books in other series, rather than grouping all chapters of that id together.
    const entries = selective
      ? (matchedWorks ?? []).flatMap((match) =>
          (perWork.get(match) ?? []).map((chapterId) => ({ seriesId: match.itemId, chapterId })),
        )
      : [...expected].flatMap(([seriesId, ids]) =>
          ids.map((chapterId) => ({ seriesId, chapterId })),
        );
    const seen = new Set<string>();
    const order = entries.filter(({ seriesId, chapterId }) => {
      const key = `${seriesId}:${chapterId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { selective, expected, order, fingerprints };
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
    const plan = await this.readingListPlan(input.itemIds, input.libraryId, input.matchedWorks);
    const list = await this.post<KavitaReadingList>('/api/ReadingList/create', {
      title: input.name,
    });
    await this.post('/api/ReadingList/update', {
      readingListId: list.id,
      title: input.name,
      summary: input.description,
      promoted: true,
    });
    const created = await this.updateReadingList(
      list.id,
      {
        itemIds: input.itemIds,
        libraryId: input.libraryId,
        ...(input.matchedWorks ? { matchedWorks: input.matchedWorks } : {}),
      },
      plan,
    );
    return { ...created, libraryId: input.libraryId };
  }

  async updateCollection(
    containerId: string,
    patch: UpdateCollectionInput,
  ): Promise<TargetCollection> {
    const { kind, id } = parseContainerId(containerId);
    return kind === 'collection'
      ? this.updateUnorderedCollection(id, patch.itemIds, patch.description)
      : this.updateReadingList(id, patch);
  }

  private async updateUnorderedCollection(
    id: number,
    itemIds: string[],
    description?: string,
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
    // Marker re-sync (ADR-076 C-02): re-write the summary when the recipe's category changed.
    if (description !== undefined && description !== (dto.summary ?? '')) {
      await this.post('/api/Collection/update', { ...dto, summary: description, promoted: true });
    }
    return {
      id: collectionId(id),
      libraryId: '',
      name: dto.title,
      description: description ?? dto.summary ?? '',
      tags: [],
      itemIds: [...itemIds],
      kind: 'kavita_collection',
    };
  }

  private async updateReadingList(
    id: number,
    patch: UpdateCollectionInput,
    prepared?: ReadingListPlan,
  ): Promise<TargetCollection> {
    const { itemIds, description, libraryId, matchedWorks } = patch;
    const syncMode = patch.syncMode ?? 'sync';
    // Finish every source read before any mutation. A transient empty/malformed detail during a
    // scan cannot be used as proof that the list should lose its existing chapters.
    const plan =
      prepared ?? (await this.readingListPlan(itemIds, libraryId, matchedWorks, syncMode));
    const { expected } = plan;
    const original = await this.readingListItems(id);

    // Add missing chapters even under a retained series id. Kavita update-by-series itself skips
    // chapter ids already in the list; surviving items keep their ids and per-item progress.
    if (plan.selective) {
      for (const { seriesId, chapterId } of plan.order) {
        if (
          original.some(
            (item) => String(item.seriesId) === seriesId && item.chapterId === chapterId,
          )
        )
          continue;
        await this.post('/api/ReadingList/update-by-chapter', {
          readingListId: id,
          seriesId: Number(seriesId),
          chapterId,
        });
      }
    } else
      for (const [seriesId, chapters] of expected) {
        const present = new Set(
          original
            .filter((item) => String(item.seriesId) === seriesId)
            .map((item) => item.chapterId),
        );
        if (chapters.every((chapter) => present.has(chapter))) continue;
        await this.post('/api/ReadingList/update-by-series', {
          readingListId: id,
          seriesId: Number(seriesId),
        });
      }

    // Verify the additions before removing stale references. A partial or rejected append leaves
    // the old list intact, including chapters that no longer appear in the source detail.
    const items = await this.readingListItems(id);
    for (const [seriesId, chapters] of expected) {
      if (
        chapters.some(
          (chapterId) =>
            !items.some(
              (item) => String(item.seriesId) === seriesId && item.chapterId === chapterId,
            ),
        )
      )
        throw new Error(
          `kavita reading list ${id}: chapter additions not confirmed; leaving existing items intact`,
        );
    }
    const working = [...items];
    const seen = new Set<string>();
    if (syncMode === 'sync') {
      // A scan can replace chapters while we are appending. Confirm that every desired series
      // still has the same complete membership before trusting absence as a reason to delete.
      for (const [seriesId, fingerprint] of plan.fingerprints) {
        const confirmed = await this.currentChapters(seriesId);
        if (chapterFingerprint(confirmed, plan.selective) !== fingerprint)
          throw new Error(
            `kavita series ${seriesId}: chapters changed during reconcile; leaving existing items intact`,
          );
      }
      for (const item of items) {
        const chapters = expected.get(String(item.seriesId));
        const key = `${item.seriesId}:${item.chapterId}`;
        const retain = chapters?.includes(item.chapterId) && !seen.has(key);
        seen.add(key);
        if (retain) continue;
        const position = working.findIndex((entry) => entry.id === item.id);
        await this.post('/api/ReadingList/delete-item', {
          readingListId: id,
          readingListItemId: item.id,
          fromPosition: position,
          toPosition: position,
        });
        working.splice(position, 1);
      }
    }

    // Reorder to the source series and chapter order, preserving distinct chapter ids for duplicate
    // files. Append retains all old entries and their order and puts additions at the end.
    // Kavita re-packs orders to contiguous 0-based values after every mutation,
    // so array index == order here.
    const target =
      syncMode === 'append'
        ? working
        : plan.order.map(({ seriesId, chapterId }) =>
            working.find(
              (item) => String(item.seriesId) === seriesId && item.chapterId === chapterId,
            )!,
          );
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
    // Marker re-sync (ADR-076 C-02): re-write the summary when the recipe's category changed.
    if (description !== undefined && description !== (dto?.summary ?? '')) {
      await this.post('/api/ReadingList/update', {
        readingListId: id,
        title: dto?.title ?? '',
        summary: description,
        promoted: true,
      });
    }
    return {
      id: readingListId(id),
      libraryId: '',
      name: dto?.title ?? '',
      description: description ?? dto?.summary ?? '',
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

/**
 * The books a series holds, one entry per chapter that names its book: the chapter's own title, and the
 * same title under the series ("Mistborn" + "The Final Empire" => "Mistborn: The Final Empire") when the
 * two differ. A series whose epubs name no title yields none, and its name stays its only title.
 */
export function seriesBooks(
  seriesName: string,
  chapters: { titleName?: string | null }[],
): string[][] {
  const books: string[][] = [];
  const series = seriesName.trim();
  for (const chapter of chapters) {
    const title = chapter.titleName?.trim() ?? '';
    if (title.length === 0) continue;
    books.push(
      series.length === 0 || series.toLowerCase() === title.toLowerCase()
        ? [title]
        : [title, `${series}: ${title}`],
    );
  }
  return books;
}
