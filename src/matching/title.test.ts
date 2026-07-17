import { describe, expect, it } from 'vitest';
import { authorsAgree, normalizeTitle, TitleIndex } from './title.js';

describe('normalizeTitle', () => {
  it('folds case, punctuation and whitespace to a stable key', () => {
    expect(normalizeTitle("Harry Potter and the Philosopher's Stone")).toBe(
      'harry potter and the philosophers stone',
    );
    expect(normalizeTitle('  Harry   Potter\tand the  Philosopher’s  Stone ')).toBe(
      'harry potter and the philosophers stone',
    );
  });

  it('drops a single leading article but keeps interior ones', () => {
    expect(normalizeTitle('The Martian')).toBe('martian');
    expect(normalizeTitle('A Wizard of Earthsea')).toBe('wizard of earthsea');
    // interior "the" is part of the distinguishing title, never stripped
    expect(normalizeTitle('Harry Potter and the Chamber of Secrets')).toBe(
      'harry potter and the chamber of secrets',
    );
  });

  it('strips bracketed edition/series noise but not the title itself', () => {
    expect(normalizeTitle('Leviathan Wakes (The Expanse, #1)')).toBe('leviathan wakes');
    expect(normalizeTitle('Dune [Illustrated Edition]')).toBe('dune');
  });

  it('folds diacritics and expands ampersands', () => {
    expect(normalizeTitle('Les Misérables')).toBe('les miserables');
    expect(normalizeTitle('War & Peace')).toBe('war and peace');
  });

  it('is empty when nothing comparable survives', () => {
    expect(normalizeTitle('   ')).toBe('');
    expect(normalizeTitle('(2011)')).toBe('');
  });

  it('keeps the honest US/UK divergence a real miss, not a fuzzy hit', () => {
    expect(normalizeTitle("Harry Potter and the Sorcerer's Stone")).not.toBe(
      normalizeTitle("Harry Potter and the Philosopher's Stone"),
    );
  });
});

describe('authorsAgree', () => {
  it('is permissive when either side lacks authors (title carries the match)', () => {
    expect(authorsAgree(undefined, ['J.K. Rowling'])).toBe(true);
    expect(authorsAgree(['J.K. Rowling'], [])).toBe(true);
    expect(authorsAgree(undefined, undefined)).toBe(true);
  });

  it('agrees across initials/spacing when both supply authors', () => {
    expect(authorsAgree(['J.K. Rowling'], ['J. K. Rowling'])).toBe(true);
    expect(authorsAgree(['JK Rowling'], ['Rowling'])).toBe(true);
  });

  it('vetoes disjoint authors (franchise mispair guard)', () => {
    expect(authorsAgree(['Frank Herbert'], ['Brian Herbert', 'Kevin J. Anderson'])).toBe(true); // shares "herbert"
    expect(authorsAgree(['Frank Herbert'], ['Kevin Anderson'])).toBe(false);
  });
});

describe('TitleIndex.match', () => {
  const none = new Set<string>();

  it('matches a work title to the one library item that carries it', () => {
    const index = new TitleIndex([
      { id: 'a', title: 'Leviathan Wakes' },
      { id: 'b', title: "Caliban's War" },
    ]);
    expect(index.match('Leviathan Wakes (The Expanse, #1)', undefined, none)?.id).toBe('a');
  });

  it('refuses a library-side ambiguous key (two distinct items same title) — never guesses', () => {
    const index = new TitleIndex([
      { id: 'a', title: 'The Gathering' },
      { id: 'b', title: 'The Gathering' },
    ]);
    expect(index.match('The Gathering', undefined, none)).toBeUndefined();
  });

  it('never binds an already-claimed item', () => {
    const index = new TitleIndex([{ id: 'a', title: 'Leviathan Wakes' }]);
    expect(index.match('Leviathan Wakes', undefined, new Set(['a']))).toBeUndefined();
  });

  it('applies the author guard when both sides supply authors', () => {
    const index = new TitleIndex([{ id: 'a', title: 'Dune', authors: ['Frank Herbert'] }]);
    expect(index.match('Dune', ['Frank Herbert'], none)?.id).toBe('a');
    expect(index.match('Dune', ['Kevin Anderson'], none)).toBeUndefined();
  });

  it('does not match an empty or unknown title key', () => {
    const index = new TitleIndex([{ id: 'a', title: 'Dune' }]);
    expect(index.match('(2011)', undefined, none)).toBeUndefined();
    expect(index.match('Nonexistent', undefined, none)).toBeUndefined();
    expect(index.match(undefined, undefined, none)).toBeUndefined();
  });

  it('items with unresolvable titles never enter the index', () => {
    const index = new TitleIndex([{ id: 'a', title: '   ' }]);
    expect(index.match('   ', undefined, none)).toBeUndefined();
  });
});
