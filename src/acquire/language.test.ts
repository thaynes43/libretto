import { describe, expect, it } from 'vitest';
import { languagePolicy, parseAcquisitionLanguages, primaryLanguage } from './language.js';

describe('primaryLanguage', () => {
  it('reads codes, regions and ISO 639-2 codes as the ISO 639-1 code', () => {
    expect(primaryLanguage('en')).toBe('en');
    expect(primaryLanguage('en-US')).toBe('en');
    expect(primaryLanguage('en_GB')).toBe('en');
    expect(primaryLanguage('eng')).toBe('en');
    expect(primaryLanguage('fre')).toBe('fr');
    expect(primaryLanguage('FR')).toBe('fr');
  });

  it('reads blank, Unknown, und and xxx as no language', () => {
    for (const value of [null, undefined, '', '  ', 'Unknown', 'und', 'XXX']) {
      expect(primaryLanguage(value)).toBeNull();
    }
  });

  it('reads a name as its leading word', () => {
    expect(primaryLanguage('English')).toBe('english');
    expect(primaryLanguage('English (US)')).toBe('english');
    expect(primaryLanguage('Français')).toBe('français');
  });
});

describe('parseAcquisitionLanguages', () => {
  it('defaults to English when unset or blank', () => {
    expect(parseAcquisitionLanguages(undefined)).toEqual(['en']);
    expect(parseAcquisitionLanguages('  ')).toEqual(['en']);
  });

  it('parses a comma or space separated list into primary codes', () => {
    expect(parseAcquisitionLanguages('en, de fr-CA,eng')).toEqual(['en', 'de', 'fr']);
  });

  it('turns a language name into its code', () => {
    expect(parseAcquisitionLanguages('English')).toEqual(['en']);
    expect(parseAcquisitionLanguages('english, Français, German')).toEqual(['en', 'fr', 'de']);
    expect(languagePolicy(parseAcquisitionLanguages('English')).allows('en')).toBe(true);
  });

  it('drops an entry that is neither a code nor a name, and falls back to English when none is left', () => {
    expect(parseAcquisitionLanguages('de, Klingonish')).toEqual(['de']);
    expect(parseAcquisitionLanguages('Klingonish')).toEqual(['en']);
    expect(parseAcquisitionLanguages('zz')).toEqual(['en']);
  });

  it('turns the check off for *, any or all', () => {
    expect(parseAcquisitionLanguages('*')).toBeUndefined();
    expect(parseAcquisitionLanguages('ANY')).toBeUndefined();
    expect(parseAcquisitionLanguages('all')).toBeUndefined();
  });
});

describe('languagePolicy', () => {
  const english = languagePolicy(['en']);

  it('allows the listed language in every spelling LazyLibrarian and Google Books use', () => {
    for (const value of ['en', 'en-US', 'en-GB', 'eng', 'English', 'english']) {
      expect(english.allows(value)).toBe(true);
    }
  });

  it('allows an unknown language', () => {
    for (const value of [null, undefined, '', 'Unknown', 'und', 'xxx']) {
      expect(english.allows(value)).toBe(true);
    }
  });

  it('refuses any other language (the live BookLang values besides en)', () => {
    for (const value of ['fr', 'de', 'it', 'es', 'nl', 'tr', 'French', 'Deutsch', 'mul']) {
      expect(english.allows(value)).toBe(false);
    }
  });

  it('accepts a language by its own name', () => {
    const french = languagePolicy(['fr']);
    expect(french.allows('Français')).toBe(true);
    expect(french.allows('French')).toBe(true);
    expect(french.allows('en')).toBe(false);
  });

  it('allows everything when no list is given', () => {
    const any = languagePolicy(undefined);
    expect(any.allowed).toBeUndefined();
    expect(any.allows('fr')).toBe(true);
  });
});
