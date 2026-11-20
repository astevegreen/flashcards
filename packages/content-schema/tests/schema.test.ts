import { describe, expect, it } from 'vitest';
import {
  getPackageJsonSchemas,
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

  it('exports JSON Schema definitions for external tools', () => {
    const schemas = getPackageJsonSchemas();
    expect(schemas['manifest']).toBeDefined();
    expect(schemas['note_record']).toBeDefined();
  });
});
