import { describe, expect, it } from 'vitest';
import {
  isbn10To13,
  isValidIsbn10,
  isValidIsbn13,
  normalizeIdentifier,
  normalizeIdentifiers,
} from './identifiers.js';

describe('identifier normalization', () => {
  it('validates ISBN-13 checksums', () => {
    expect(isValidIsbn13('9780316129084')).toBe(true);
    expect(isValidIsbn13('978-0-316-12908-4')).toBe(true);
    expect(isValidIsbn13('9780316129085')).toBe(false);
  });

  it('validates ISBN-10 checksums including X check digits', () => {
    expect(isValidIsbn10('0316129089')).toBe(true);
    expect(isValidIsbn10('080442957X')).toBe(true);
    expect(isValidIsbn10('0316129088')).toBe(false);
  });

  it('converts ISBN-10 to ISBN-13', () => {
    expect(isbn10To13('0316129089')).toBe('9780316129084');
  });

  it('normalizes bare and prefixed ISBNs to isbn:<13 digits>', () => {
    expect(normalizeIdentifier('9780316129084')).toBe('isbn:9780316129084');
    expect(normalizeIdentifier('978-0-316-12908-4')).toBe('isbn:9780316129084');
    expect(normalizeIdentifier('isbn:0316129089')).toBe('isbn:9780316129084');
    expect(normalizeIdentifier('0316129089')).toBe('isbn:9780316129084');
  });

  it('normalizes ASINs, bare or prefixed', () => {
    expect(normalizeIdentifier('B0071IHYRW')).toBe('asin:B0071IHYRW');
    expect(normalizeIdentifier('asin:b0071ihyrw')).toBe('asin:B0071IHYRW');
  });

  it('keeps unknown shapes verbatim so opaque static ids still match', () => {
    expect(normalizeIdentifier('isbn:1')).toBe('isbn:1');
    expect(normalizeIdentifier('olid:OL27448W')).toBe('olid:OL27448W');
    expect(normalizeIdentifier('  some-opaque-id ')).toBe('some-opaque-id');
  });

  it('normalizeIdentifiers drops empties and duplicates, keeps order', () => {
    expect(
      normalizeIdentifiers(['9780316129084', null, 'isbn:0316129089', undefined, 'B0071IHYRW']),
    ).toEqual(['isbn:9780316129084', 'asin:B0071IHYRW']);
  });
});
