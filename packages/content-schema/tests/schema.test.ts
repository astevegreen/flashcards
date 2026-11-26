import { describe, expect, it } from 'vitest';
import {
  getPackageJsonSchemas,
  isSafeRelativePackPath,
  LayoutDefSchema,
  NoteTypeDefSchema,
  validateFamilyCatalog,
  validatePackageManifest,
  validatePackageNote,
} from '../src/index.ts';

describe('@flash/content-schema', () => {
  it('validates a well-formed manifest and note record', () => {
    const manifestRes = validatePackageManifest({
      package_id: 'pkg:ko-1',
      name: 'Korean Pack',
      version: '1.0.0',
      format_version: 1,
      languages: ['ko', 'en'],
      decks: [],
    });
    expect(manifestRes.ok).toBe(true);

    const noteRes = validatePackageNote({
      id: 'n-1',
      fields: { word: '학교', meaning: 'school' },
      tags: ['topik-1'],
    });
    expect(noteRes.ok).toBe(true);
  });

  it('returns machine-readable structured errors on invalid input', () => {
    const bad = validatePackageManifest({ package_id: '', format_version: 2 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.length).toBeGreaterThan(0);
      expect(bad.errors.some((e) => e.path === 'format_version')).toBe(true);
    }
  });

  it('validates a Family Library index.json catalog and enforces strict https: URLs', () => {
    const ok = validateFamilyCatalog({
      format_version: 1,
      name: 'Green Family Decks',
      description: 'Shared Korean & Japanese decks',
      packages: [
        {
          package_id: 'pkg:family-ko-1',
          title: 'Korean Core',
          description: 'Everyday phrases',
          url: 'https://raw.githubusercontent.com/example/decks/main/ko.flashpkg',
          version: '1.2.0',
          languages: ['ko', 'en'],
          sha256: 'a'.repeat(64),
        },
      ],
    });
    expect(ok.ok).toBe(true);

    const badHttp = validateFamilyCatalog({
      format_version: 1,
      name: 'Insecure',
      packages: [
        {
          package_id: 'pkg:bad',
          title: 'HTTP Pack',
          url: 'http://example.com/bad.flashpkg',
          version: '1.0.0',
        },
      ],
    });
    expect(badHttp.ok).toBe(false);

    const badCreds = validateFamilyCatalog({
      format_version: 1,
      name: 'Creds',
      packages: [
        {
          package_id: 'pkg:bad',
          title: 'Creds Pack',
          url: 'https://user:pass@example.com/bad.flashpkg',
          version: '1.0.0',
        },
      ],
    });
    expect(badCreds.ok).toBe(false);
  });

  it('exports JSON Schema definitions for external tools', () => {
    const schemas = getPackageJsonSchemas();
    expect(schemas['manifest']).toBeDefined();
    expect(schemas['note_record']).toBeDefined();
    expect(schemas['family_catalog']).toBeDefined();
  });

  it('rejects field keys that name an Object.prototype member (S4)', () => {
    const noteType = (key: string) =>
      NoteTypeDefSchema.safeParse({
        id: 'nt',
        name: 'NT',
        fields: [{ key, kind: 'text', lang: 'en' }],
      }).success;
    expect(noteType('word')).toBe(true);
    expect(noteType('constructor_2')).toBe(true);
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(noteType(key), key).toBe(false);
    }
    const layout = LayoutDefSchema.safeParse({
      id: 'l',
      note_type_id: 'nt',
      name: 'L',
      front_fields: ['word'],
      reveal_steps: [['meaning']],
      answer_field: 'constructor',
    });
    expect(layout.success).toBe(false);
    const json = JSON.stringify(getPackageJsonSchemas()['note_type']);
    expect(json).toContain('constructor|__proto__');
  });

  it('rejects `..` path segments but not names that contain two dots (§11 nit)', () => {
    expect(isSafeRelativePackPath('/packs/a..b.json')).toBe(true);
    expect(isSafeRelativePackPath('/packs/v1..2/index.json')).toBe(true);
    expect(isSafeRelativePackPath('/packs/../secret.json')).toBe(false);
    expect(isSafeRelativePackPath('/packs/%2e%2E/secret.json')).toBe(false);
    expect(isSafeRelativePackPath('/packs/.%2e/secret.json')).toBe(false);
    expect(isSafeRelativePackPath('/packs/..')).toBe(false);
  });
});
