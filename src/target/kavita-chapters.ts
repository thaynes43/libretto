import { workAuthors } from '../builders/index.js';
import { normalizeIdentifiers } from '../identifiers.js';
import { normalizeTitle } from '../matching/title.js';
import type { MatchedWork } from './types.js';

/** Fresh chapter identities from Kavita's Series/volumes response. */
export interface KavitaChapter {
  id?: number;
  sortOrder?: number;
  isbn?: string | null;
  titleName?: string | null;
  title?: string | null;
  writers?: { name?: string | null }[] | null;
  files?: { filePath?: string | null }[] | null;
}

/** Full author identity: punctuation/initial spacing is harmless, expanded names are not inferred. */
function authorKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Select canonical works, retaining every verified copy in the source's chapter order. */
export function selectBookChapters(
  seriesId: string,
  chapters: readonly KavitaChapter[],
  matches: readonly MatchedWork[],
): Map<MatchedWork, number[]> {
  const selected = new Map(matches.map((match) => [match, [] as number[]]));
  const incomplete = () => {
    throw new Error(
      `kavita series ${seriesId}: incomplete book identities; leaving existing items intact`,
    );
  };
  for (const chapter of chapters) {
    const identifiers = normalizeIdentifiers([chapter.isbn]);
    const exact = matches.filter((match) =>
      normalizeIdentifiers(match.work.identifiers).some((id) => identifiers.includes(id)),
    );
    if (exact.length > 0) {
      for (const match of exact) selected.get(match)!.push(chapter.id!);
      continue;
    }
    const title = normalizeTitle(chapter.titleName?.trim() || chapter.title?.trim() || '');
    const writers = (chapter.writers ?? []).map((writer) => writer.name?.trim() ?? '');
    // Unknown identity cannot prove that an existing chapter is foreign and safe to remove.
    if (!title || writers.length === 0 || writers.some((writer) => !authorKey(writer)))
      incomplete();
    for (const match of matches) {
      const titles = [match.work.title, match.confirmedTitle]
        .filter((value): value is string => value !== undefined)
        .map(normalizeTitle);
      if (!titles.includes(title)) continue;
      const authors = workAuthors(match.work)?.map((author) => author.trim());
      if (!authors?.length || authors.some((author) => !authorKey(author))) incomplete();
      if (
        authors?.some((author) => writers.some((writer) => authorKey(author) === authorKey(writer)))
      )
        selected.get(match)!.push(chapter.id!);
    }
  }
  if (matches.some((match) => selected.get(match)!.length === 0))
    throw new Error(
      `kavita series ${seriesId}: matched canonical book no longer verified; leaving existing items intact`,
    );
  return selected;
}
