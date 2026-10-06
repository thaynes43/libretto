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

/** The English name of a language code, or undefined when Intl does not know the code. */
function englishName(code: string): string | undefined {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(code);
  } catch {
    return undefined;
  }
}

let namesToCodes: Map<string, string> | undefined;

/** Every two-letter language code Intl knows, by its English and its own name (lowercased). Built once, on demand. */
function codeForName(name: string): string | undefined {
  if (!namesToCodes) {
    namesToCodes = new Map();
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (const a of letters) {
      for (const b of letters) {
        const code = a + b;
        if (!englishName(code)) continue;
        for (const known of languageNames(code)) {
          if (!namesToCodes.has(known)) namesToCodes.set(known, code);
        }
      }
    }
  }
  return namesToCodes.get(name);
}

/**
 * One configured language as a code: a code is kept (`en-US` and `eng` give `en`), a name is looked up (`English`
 * and `français` give `en` and `fr`). Undefined when it is neither.
 */
function configuredLanguage(entry: string): string | undefined {
  const language = primaryLanguage(entry);
  if (language === null) return undefined;
  if (/^[a-z]{2,3}$/.test(language) && englishName(language)) return language;
  return codeForName(language);
}

/**
 * Parse `LIBRETTO_ACQUISITION_LANGUAGES`: a comma- or space-separated list of languages, as codes or names. An entry
 * that is neither is dropped; unset, blank or nothing usable gives the default (English). `*`, `any` or `all` turns
 * the check off (undefined). The resulting list is logged when acquisition starts.
 */
export function parseAcquisitionLanguages(raw: string | undefined): string[] | undefined {
  const entries = (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.some((entry) => EVERY_LANGUAGE.has(entry.toLowerCase()))) return undefined;
  const codes = [
    ...new Set(
      entries.map(configuredLanguage).filter((code): code is string => code !== undefined),
    ),
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
