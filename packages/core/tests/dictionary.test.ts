import { gzipSync } from 'fflate';
import {
  buildEntrySearchTokens,
  decodePackArchive,
  materializeDictionaryEntries,
  OPEN_DATA_ATTRIBUTIONS,
  PackValidationError,
  parseAndValidatePackCatalog,
  rankDictionaryResults,
} from '../src/dictionary/index.ts';
import { sha256Hex } from '../src/sources/hash.ts';
import { describe, expect, it } from 'vitest';

const SAMPLE_PACK_CATALOG = {
  format_version: 1,
  name: 'Test Offline Packs',
  packs: [
    {
      id: 'dict-hanja-unihan',
      kind: 'dictionary',
      name: 'Hanja Dictionary',
      description: 'Korean Hanja readings and definitions',
      version: '2026.11.0',
      language: 'ko',
      url: 'https://packs.example.com/dict-hanja-unihan.json.gz',
      compressed_bytes: 1024,
      entry_count: 20,
      license_name: 'Unicode License v3',
      license_url: 'https://www.unicode.org/license.txt',
      attribution: 'Unicode, Inc.',
      source_url: 'https://www.unicode.org/charts/unihan.html',
    },
  ],
};

describe('Phase 6 offline dictionary search, pack codec & security guards', () => {
  it('validates packs.json catalog and rejects unsafe URLs / path traversal (§13)', () => {
    const valid = parseAndValidatePackCatalog(JSON.stringify(SAMPLE_PACK_CATALOG));
    expect(valid.packs).toHaveLength(1);

    // Relative /packs/... allowed only when explicitly opted in (dev/CI fixtures)
    const relCatalog = {
      ...SAMPLE_PACK_CATALOG,
      packs: [{ ...SAMPLE_PACK_CATALOG.packs[0], url: '/packs/dict-hanja-unihan.json.gz' }],
    };
    expect(() => parseAndValidatePackCatalog(JSON.stringify(relCatalog))).toThrow(
      PackValidationError,
    );
    expect(
      parseAndValidatePackCatalog(JSON.stringify(relCatalog), { allowRelativeUrls: true }).packs,
    ).toHaveLength(1);

    // Reject http:, javascript:, credentials, and relative traversal
    for (const badUrl of [
      'http://insecure.example.com/p.json.gz',
      'javascript:alert(1)',
      'https://user:pass@example.com/p.json.gz',
      '/packs/../secret.json',
      '//evil.example.com/p.json.gz',
    ]) {
      const bad = {
        ...SAMPLE_PACK_CATALOG,
        packs: [{ ...SAMPLE_PACK_CATALOG.packs[0], url: badUrl }],
      };
      expect(() =>
        parseAndValidatePackCatalog(JSON.stringify(bad), { allowRelativeUrls: true }),
      ).toThrow(PackValidationError);
    }
  });

  it('decodes gzipped packs, enforces SHA-256 verification, and blocks gzip bombs (§13)', () => {
    const payload = {
      manifest: {
        format_version: 1,
        id: 'dict-hanja-unihan',
        kind: 'dictionary',
        name: 'Hanja Test',
        version: '1.0.0',
        language: 'ko',
        description: 'Test Hanja pack',
        license_name: 'Unicode License v3',
        license_url: 'https://www.unicode.org/license.txt',
        attribution: 'Unicode, Inc.',
        source_url: 'https://www.unicode.org/charts/unihan.html',
      },
      entries: [
        {
          headword: '學',
          altForms: ['学'],
          readings: ['학'],
          eumhun: ['배울 학'],
          meanings: ['learn', 'study'],
          strokeCount: 16,
          radical: '子',
          grade: 'Education Hanja',
        },
      ],
    };

    const rawBytes = new TextEncoder().encode(JSON.stringify(payload));
    const gzBytes = gzipSync(rawBytes);
    const hash = sha256Hex(gzBytes);

    const decoded = decodePackArchive(gzBytes, { expectedSha256: hash });
    expect(decoded.manifest.id).toBe('dict-hanja-unihan');
    expect('entries' in decoded && decoded.entries).toHaveLength(1);

    // Tampered SHA-256 must throw
    expect(() =>
      decodePackArchive(gzBytes, {
        expectedSha256: '0'.repeat(64),
      }),
    ).toThrow(/SHA-256 checksum mismatch/);

    // Gzip bomb cap must abort before expanding huge payloads
    const huge = new Uint8Array(256 * 1024);
    huge.fill(65); // Highly compressible 'A's
    const bombGz = gzipSync(huge);
    expect(() =>
      decodePackArchive(bombGz, {
        maxUncompressedBytes: 64 * 1024,
      }),
    ).toThrow(/maximum uncompressed byte cap/);
  });

  it('indexes and ranks bidirectional native <-> target dictionary queries accurately', () => {
    const entries = materializeDictionaryEntries('dict-hanja-unihan', [
      {
        headword: '學',
        altForms: ['学'],
        readings: ['학'],
        eumhun: ['배울 학'],
        meanings: ['learn', 'study', 'school'],
        grade: 'Education Hanja',
        frequency: 12,
      },
      {
        headword: '校',
        readings: ['교'],
        eumhun: ['학교 교'],
        meanings: ['school', 'proofread'],
        grade: 'Education Hanja',
        frequency: 45,
      },
    ]).concat(
      materializeDictionaryEntries('dict-cc-cedict', [
        {
          headword: '学习',
          altForms: ['學習'],
          readings: ['xue2 xi2'],
          meanings: ['to learn', 'to study'],
          frequency: 50,
        },
      ]),
      materializeDictionaryEntries('dict-kanjidic2', [
        {
          headword: '食',
          readings: ['ショク', 'た.べる'],
          meanings: ['eat', 'food'],
          frequency: 300,
        },
      ]),
    );

    const cedictEntry = entries[2];
    expect(cedictEntry).toBeDefined();
    if (cedictEntry) {
      expect(buildEntrySearchTokens(cedictEntry)).toContain('xuexi');
    }

    // Exact Hanja character
    expect(rankDictionaryResults(entries, '學')[0]?.headword).toBe('學');
    // Variant form lookup (`学` -> `學`)
    expect(rankDictionaryResults(entries, '学')[0]?.headword).toBe('學');
    // Korean Hangul reading lookup
    expect(rankDictionaryResults(entries, '학')[0]?.headword).toBe('學');
    // English native meaning lookup
    const schoolMatches = rankDictionaryResults(entries, 'school');
    expect(schoolMatches.map((e) => e.headword)).toContain('校');
    // Mandarin tone-stripped pinyin lookup
    expect(rankDictionaryResults(entries, 'xuéxí')[0]?.headword).toBe('学习');
    expect(rankDictionaryResults(entries, 'xuexi')[0]?.headword).toBe('学习');
    // Japanese katakana/hiragana folded reading lookup
    expect(rankDictionaryResults(entries, 'しょく')[0]?.headword).toBe('食');
    expect(rankDictionaryResults(entries, 'タベル')[0]?.headword).toBe('食');
  });

  it('exposes complete upstream license attributions for all 6 packs + hanzi-writer', () => {
    const ids = new Set(OPEN_DATA_ATTRIBUTIONS.map((a) => a.id));
    expect(ids.has('dict-hanja-unihan')).toBe(true);
    expect(ids.has('dict-kanjidic2')).toBe(true);
    expect(ids.has('dict-cc-cedict')).toBe(true);
    expect(ids.has('dict-jmdict')).toBe(true);
    expect(ids.has('strokes-ja-kanjivg')).toBe(true);
    expect(ids.has('strokes-zh-mmah')).toBe(true);
    expect(ids.has('lib-hanzi-writer')).toBe(true);
    for (const item of OPEN_DATA_ATTRIBUTIONS) {
      expect(item.licenseUrl.startsWith('https://')).toBe(true);
      expect(item.sourceUrl.startsWith('https://')).toBe(true);
    }
  });
});

describe('pack manifest links (S13)', () => {
  const manifest = {
    format_version: 1,
    id: 'dict-hanja-unihan',
    kind: 'dictionary',
    name: 'Hanja Test',
    version: '1.0.0',
    language: 'ko',
    description: 'Test Hanja pack',
    license_name: 'Unicode License v3',
    license_url: 'https://www.unicode.org/license.txt',
    attribution: 'Unicode, Inc.',
    source_url: 'https://www.unicode.org/charts/unihan.html',
  };
  const pack = (m: Record<string, unknown>) =>
    new TextEncoder().encode(JSON.stringify({ manifest: m, entries: [] }));

  it('accepts https links and refuses any other scheme', () => {
    expect(decodePackArchive(pack(manifest)).manifest.id).toBe('dict-hanja-unihan');
    for (const field of ['license_url', 'source_url']) {
      for (const bad of ['javascript:alert(1)', 'http://example.com/', 'data:text/html,x', '/x']) {
        expect(() => decodePackArchive(pack({ ...manifest, [field]: bad })), bad).toThrow(
          /must be an https/,
        );
      }
    }
  });
});
