/**
 * The acquisition language allowlist (issue #26): which book languages the acquisition leg may queue or add.
 *
 * A language value comes from LazyLibrarian's `BookLang` (`en`, `fr`, `Unknown`, ...) or a Google Books volume's
 * `language`. It is read in three classes:
 *   - allowed: its primary language is on the list. A region (`en-US`, `en_GB`), an ISO 639-2 code (`eng`, `fre`)
 *     and the English or native name (`English`, `français`) all count as the same language;
 *   - unknown: blank, null, `Unknown`, `und` or `xxx`. Allowed: LazyLibrarian labels books it could not place this
 *     way, and refusing them would stop acquisition of books nobody has looked at;
 *   - anything else is refused.
 */

const UNKNOWN_LANGUAGE = new Set(['', 'unknown', 'und', 'xxx']);

/** Values of `LIBRETTO_ACQUISITION_LANGUAGES` that turn the check off. */
const EVERY_LANGUAGE = new Set(['*', 'any', 'all']);

/** The default allowlist when `LIBRETTO_ACQUISITION_LANGUAGES` is unset: English (LazyLibrarian's own default). */
export const DEFAULT_ACQUISITION_LANGUAGES: readonly string[] = ['en'];

/**
 * A language value's primary language, lowercased: the ISO 639-1 code when the value is a code (`en-US` and `eng`
 * read `en`), otherwise the value's leading word (`English (US)` reads `english`). Null when it names no language.
 */
export function primaryLanguage(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (UNKNOWN_LANGUAGE.has(raw)) return null;
  try {
    return new Intl.Locale(raw).language;
  } catch {
    const word = /^\p{L}+/u.exec(raw)?.[0];
    return word && !UNKNOWN_LANGUAGE.has(word) ? word : null;
  }
}

export interface LanguagePolicy {
  /** The allowed primary codes; undefined when every language is allowed. */
  readonly allowed: readonly string[] | undefined;
  /** May a book in this language be acquired? Unknown languages are allowed. */
  allows(value: string | null | undefined): boolean;
}

/**
 * Parse `LIBRETTO_ACQUISITION_LANGUAGES`: a comma- or space-separated list of language codes. Unset or blank gives
 * the default (English); `*`, `any` or `all` turns the check off (undefined).
 */
export function parseAcquisitionLanguages(raw: string | undefined): string[] | undefined {
  const entries = (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.some((entry) => EVERY_LANGUAGE.has(entry.toLowerCase()))) return undefined;
  const codes = [
    ...new Set(entries.map(primaryLanguage).filter((code): code is string => code !== null)),
  ];
  return codes.length > 0 ? codes : [...DEFAULT_ACQUISITION_LANGUAGES];
}

/** The names a language goes by, lowercased: its English name and its own name (`fr` gives `french`, `français`). */
function languageNames(code: string): string[] {
  const names: string[] = [];
  for (const locale of ['en', code]) {
    try {
      const name = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(code);
      if (name) names.push(name.toLowerCase());
    } catch {
      // Not a code Intl knows: the code itself still matches.
    }
  }
  return names;
}

export function languagePolicy(allowed: readonly string[] | undefined): LanguagePolicy {
  if (allowed === undefined) return { allowed: undefined, allows: () => true };
  const accepted = new Set<string>();
  for (const code of allowed) {
    accepted.add(code);
    for (const name of languageNames(code)) accepted.add(name);
  }
  return {
    allowed,
    allows(value) {
      const language = primaryLanguage(value);
      return language === null || accepted.has(language);
    },
  };
}
