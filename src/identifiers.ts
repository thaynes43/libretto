/**
 * Identifier normalization (DESIGN-037 D-04): matching is exact-string over
 * normalized identifiers, never title fuzz. Both sides of a match (builder work
 * lists and target library items) run through these helpers so that
 * "978-0-316-12908-4", "9780316129084" and the ISBN-10 "0316129089" all land on
 * the same key. The canonical forms are:
 *
 *   isbn:<13 digits>   ISBN-13 (ISBN-10 inputs are converted, a lossless
 *                      deterministic transform, not fuzz)
 *   isbn:<10 chars>    only when a 10-char value fails ISBN-10 checksum shape
 *                      but is clearly ISBN-ish; kept raw rather than guessed at
 *   asin:<10 upper>    Amazon ASIN (Audible audiobooks, Kindle editions)
 *
 * Unknown shapes are kept verbatim (trimmed) so static_ids users can match on
 * whatever opaque identifiers their targets expose.
 */

const PREFIXED = /^([a-z][a-z0-9_]*):(.*)$/;

/** Strip hyphens/spaces from an ISBN-ish payload. */
function cleanIsbn(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

function isbn10CheckDigit(digits9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(digits9[i]);
  const check = (11 - (sum % 11)) % 11;
  return check === 10 ? 'X' : String(check);
}

function isbn13CheckDigit(digits12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

export function isValidIsbn10(value: string): boolean {
  const v = cleanIsbn(value);
  return /^\d{9}[\dX]$/.test(v) && isbn10CheckDigit(v.slice(0, 9)) === v[9];
}

export function isValidIsbn13(value: string): boolean {
  const v = cleanIsbn(value);
  return /^\d{13}$/.test(v) && isbn13CheckDigit(v.slice(0, 12)) === v[12];
}

/** Convert a valid ISBN-10 to its ISBN-13 form (978 prefix). */
export function isbn10To13(isbn10: string): string {
  const digits12 = '978' + cleanIsbn(isbn10).slice(0, 9);
  return digits12 + isbn13CheckDigit(digits12);
}

/**
 * Normalize one raw identifier to its canonical key. Accepts bare values
 * ("9780316129084", "B0071IHYRW") and prefixed ones ("isbn:...", "asin:...").
 * Unknown prefixes and unrecognizable bare values pass through trimmed.
 */
export function normalizeIdentifier(raw: string): string {
  const trimmed = raw.trim();
  const match = PREFIXED.exec(trimmed);
  const scheme = match?.[1];
  const payload = match ? match[2]!.trim() : trimmed;

  if (scheme !== undefined && scheme !== 'isbn' && scheme !== 'asin') return trimmed;

  const cleaned = cleanIsbn(payload);
  if (scheme === 'isbn' || scheme === undefined) {
    if (isValidIsbn13(cleaned)) return `isbn:${cleaned}`;
    if (isValidIsbn10(cleaned)) return `isbn:${isbn10To13(cleaned)}`;
    if (scheme === 'isbn') return `isbn:${cleaned}`;
  }
  if (scheme === 'asin' || (scheme === undefined && /^B[\dA-Z]{9}$/.test(cleaned))) {
    return `asin:${cleaned}`;
  }
  return trimmed;
}

/** Normalize a list, dropping empties and duplicates while keeping order. */
export function normalizeIdentifiers(raw: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (!value) continue;
    const normalized = normalizeIdentifier(value);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
