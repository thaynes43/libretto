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
  const compact = (part: string) =>
    part
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
  const parts = name.split(',');
  if (parts.some((part) => !compact(part))) return '';
  // Inspect the explicit format before removing punctuation: V. and I.V. are initials,
  // whereas undotted Roman numerals are the closed suffix forms we can recognize.
  const suffix = /^(?:jr|sr)\.?$|^(?:ii|iii|iv|v)$/i.test(parts.at(-1)!.trim());
  // Preserve a known terminal suffix as identity, including its explicit comma formats.
  if (parts.length === 2 && suffix) return compact(parts.join(' '));
  if (parts.length === 3 && suffix) return compact(`${parts[1]} ${parts[0]} ${parts[2]}`);
  // One surname-first comma is a known format. Other multi-comma credits remain ambiguous;
  // arbitrary token sorting or discarding a suffix cannot establish full author identity.
  if (parts.length > 2) return '';
  return compact(parts.length === 2 ? `${parts[1]} ${parts[0]}` : name);
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
    const title = normalizeTitle(chapter.titleName?.trim() || '');
    if (!title) incomplete();
    const candidates = matches.filter((match) =>
      [match.work.title, match.confirmedTitle]
        .filter((value): value is string => value !== undefined)
        .map(normalizeTitle)
        .includes(title),
    );
    // A known different full title cannot satisfy either membership path. Writer data is then
    // unnecessary; unknown titles and potentially matching titles still need complete proof.
    if (candidates.length === 0) continue;
    const writers = (chapter.writers ?? []).map((writer) => writer.name?.trim() ?? '');
    // Unknown identity cannot prove that an existing chapter is foreign and safe to remove.
    if (writers.length === 0 || writers.some((writer) => !authorKey(writer))) incomplete();
    for (const match of candidates) {
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
