import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ankiExportSlug } from '../src/export/anki/csv.ts';
import { asciiSlug } from '../src/slug.ts';

/** The `.flashpkg` export's `safeSlug` that `asciiSlug` replaced (review R8). */
function oldSafeSlug(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

describe('asciiSlug', () => {
  it('slugs names, with the fallback when nothing ASCII is left', () => {
    expect(asciiSlug('  Korean: TOPIK I  ', 'deck')).toBe('korean-topik-i');
    expect(asciiSlug('한국어', 'deck-1')).toBe('deck-1');
    expect(ankiExportSlug('한국어')).toBe('deck');
  });

  it('matches the `.flashpkg` slug it replaced on any name', () => {
    const name = fc.string({ unit: fc.constantFrom('a', 'Z', '9', '-', ' ', '.', '한', '_') });
    fc.assert(
      fc.property(name, (n) => {
        expect(asciiSlug(n, 'x')).toBe(oldSafeSlug(n, 'x'));
      }),
    );
  });
});
