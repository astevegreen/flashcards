import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../src/ids.ts';
import {
  detectImportFile,
  detectImportText,
  parseGoogleSheetsUrl,
  type DetectedImport,
} from '../src/import/detect.ts';
import { exportFlashpkg } from '../src/import/flashpkg.ts';
import { listZipEntryNames } from '../src/import/zip-entries.ts';
import { createEmptyState } from '../src/events/replay.ts';

const ANKI_FIXTURES = resolve(fileURLToPath(import.meta.url), '../../../../tests/fixtures/anki');
const anki = (name: string) => new Uint8Array(readFileSync(join(ANKI_FIXTURES, name)));
const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, encodeUtf8(v)])));

function kindOf(d: DetectedImport): string {
  if (d.kind === 'unsupported') return `unsupported:${d.reason}`;
  if (d.kind === 'anki') return `anki:${d.collection}`;
  if (d.kind === 'csv') return `csv:${d.dialect}`;
  return d.kind;
}

describe('detectImportFile (magic bytes + zip entry names + header row)', () => {
  const cases: Array<[string, Uint8Array, string | undefined, string]> = [
    ['legacy Anki 2.0 package', anki('basic-reversed.apkg'), 'a.apkg', 'anki:anki2'],
    ['Anki 2.1 package (anki21 beside the stub)', anki('cloze.apkg'), 'c.apkg', 'anki:anki21'],
    ['current Anki package (anki21b, zstd)', anki('anki21b.apkg'), 'b.apkg', 'anki:anki21b'],
    // Unsafe packages still route to the Anki importer, whose safe-unzip refuses them.
    ['path-traversal package', anki('malicious-traversal.apkg'), 'x.apkg', 'anki:anki2'],
    ['zip without a collection', anki('not-anki.apkg'), 'not.apkg', 'unsupported:zip-other'],
    ['Anki package named .zip', anki('media.apkg'), 'download.zip', 'anki:anki2'],
    [
      '.flashpkg (manifest.json)',
      exportFlashpkg(createEmptyState(), { name: 'Empty' }),
      'deck.flashpkg',
      'flashpkg',
    ],
    ['.flashpkg named .apkg', zip({ 'manifest.json': '{}' }), 'odd.apkg', 'flashpkg'],
    [
      'Excel workbook',
      zip({ '[Content_Types].xml': '<x/>', 'xl/workbook.xml': '<w/>' }),
      'cards.xlsx',
      'unsupported:xlsx',
    ],
    [
      'Flashcards Deluxe TSV',
      encodeUtf8('Text 1\tText 2\tCategory 1\n고양이\tcat\tanimals\n'),
      'fd.txt',
      'csv:flashcards-deluxe',
    ],
    [
      'Flashcards Deluxe CSV with BOM and CRLF',
      encodeUtf8('﻿Text 1,Text 2,Notes\r\n犬,dog,\r\n'),
      'fd.csv',
      'csv:flashcards-deluxe',
    ],
    ['generic CSV', encodeUtf8('Word,Meaning,Tags\n고양이,cat,a\n'), 'w.csv', 'csv:generic'],
    ['CSV named .apkg', encodeUtf8('Word,Meaning\n고양이,cat\n'), 'x.apkg', 'csv:generic'],
    [
      'plain text, no columns',
      encodeUtf8('hello world\nsecond line'),
      'n.txt',
      'unsupported:no-columns',
    ],
    ['empty file', new Uint8Array(0), 'e.csv', 'unsupported:empty'],
    ['whitespace only', encodeUtf8(' \n\n\t'), 'e.csv', 'unsupported:empty'],
    ['UTF-16 text', new Uint8Array([0xff, 0xfe, 0x54, 0x00]), 'u.txt', 'unsupported:utf16'],
    [
      'raw SQLite collection',
      encodeUtf8('SQLite format 3\u0000rest'),
      'collection.anki2',
      'unsupported:sqlite',
    ],
    [
      'PNG image',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      'p.png',
      'unsupported:not-recognized',
    ],
    [
      'invalid UTF-8',
      new Uint8Array([0x41, 0xc3, 0x28, 0x2c, 0x42]),
      'bad.csv',
      'unsupported:not-recognized',
    ],
  ];

  it.each(cases)('%s', (_label, bytes, name, expected) => {
    expect(kindOf(detectImportFile(bytes, name))).toBe(expected);
  });

  it('reports the delimiter and headers of a CSV/TSV table', () => {
    expect(detectImportFile(encodeUtf8('Text 1\tText 2\na\tb'))).toEqual({
      kind: 'csv',
      dialect: 'flashcards-deluxe',
      delimiter: '\t',
      headers: ['Text 1', 'Text 2'],
    });
  });

  it('mentions a misleading extension instead of trusting it', () => {
    const d = detectImportFile(anki('not-anki.apkg'), 'deck.apkg');
    expect(d.kind === 'unsupported' && d.message).toContain('named like an Anki package');
  });

  it('never throws and never reports a format for random bytes it cannot place', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), fc.string(), (bytes, name) => {
        const d = detectImportFile(bytes, name);
        if (d.kind === 'anki' || d.kind === 'flashpkg') {
          // Only a zip signature can lead to an archive format.
          expect(bytes[0]).toBe(0x50);
        }
      }),
    );
  });

  it('a truncated archive still detects from its local headers', () => {
    const bytes = anki('basic-reversed.apkg');
    const cut = bytes.subarray(0, bytes.length - 30);
    expect(kindOf(detectImportFile(cut))).toBe('anki:anki2');
  });
});

describe('listZipEntryNames', () => {
  it('lists every entry without inflating, in archive order', () => {
    expect(listZipEntryNames(anki('anki21b.apkg'))).toEqual([
      'collection.anki2',
      'collection.anki21b',
      'media',
      'meta',
      '0',
    ]);
    expect(listZipEntryNames(encodeUtf8('Word,Meaning'))).toBeUndefined();
  });

  it('stops at the entry cap and survives hostile central directories', () => {
    const many = zip(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, 'x'])));
    expect(listZipEntryNames(many, 5)).toHaveLength(5);
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 200 }), fc.nat(400), (junk, at) => {
        const bytes = new Uint8Array(many);
        bytes.set(junk.subarray(0, Math.max(0, bytes.length - at)), Math.min(at, bytes.length));
        const names = listZipEntryNames(bytes);
        expect(names === undefined || Array.isArray(names)).toBe(true);
      }),
    );
  });
});

describe('detectImportText (pasted links and rows)', () => {
  const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
  const table: Array<[string, string]> = [
    [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, 'google-sheets'],
    [`https://docs.google.com/spreadsheets/d/${ID}`, 'google-sheets'],
    [`  https://docs.google.com/spreadsheets/u/1/d/${ID}/edit?usp=sharing  `, 'google-sheets'],
    [`HTTPS://DOCS.GOOGLE.COM/spreadsheets/d/${ID}/edit`, 'google-sheets'],
    [`http://docs.google.com/spreadsheets/d/${ID}/view`, 'google-sheets'],
    [
      `https://docs.google.com/spreadsheets/d/e/2PACX-${ID}/pubhtml`,
      'unsupported:google-published',
    ],
    ['https://docs.google.com/spreadsheets/u/0/', 'unsupported:url-other'],
    [`https://docs.google.com/document/d/${ID}/edit`, 'unsupported:google-docs'],
    [`https://drive.google.com/file/d/${ID}/view`, 'unsupported:google-drive-file'],
    [`https://docs.google.com.evil.example/spreadsheets/d/${ID}/edit`, 'unsupported:url-other'],
    [`https://evil.example/docs.google.com/spreadsheets/d/${ID}`, 'unsupported:url-other'],
    ['https://docs.google.com/spreadsheets/d/short/edit', 'unsupported:url-other'],
    [`https://docs.google.com/spreadsheets/d/${ID}<script>/edit`, 'unsupported:url-other'],
    ['Text 1\tText 2\n고양이\tcat', 'csv:flashcards-deluxe'],
    ['Word,Meaning\n고양이,cat', 'csv:generic'],
    ['just some words', 'unsupported:no-columns'],
    ['   ', 'unsupported:empty'],
  ];

  it.each(table)('%s', (input, expected) => {
    expect(kindOf(detectImportText(input))).toBe(expected);
  });

  it('returns the spreadsheet id and a canonical edit URL', () => {
    expect(
      parseGoogleSheetsUrl(`https://docs.google.com/spreadsheets/u/2/d/${ID}/htmlview`),
    ).toEqual({ spreadsheetId: ID, url: `https://docs.google.com/spreadsheets/d/${ID}/edit` });
  });

  it('only ever accepts docs.google.com ids made of URL-safe characters (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const parsed = parseGoogleSheetsUrl(text);
        if (!parsed) return;
        expect(parsed.spreadsheetId).toMatch(/^[\w-]{10,200}$/);
        expect(parsed.url.startsWith('https://docs.google.com/spreadsheets/d/')).toBe(true);
      }),
    );
    fc.assert(
      fc.property(
        fc.stringMatching(/^[\w-]{10,60}$/),
        fc.constantFrom('/edit', '', '/view#gid=3'),
        (id, tail) => {
          const parsed = parseGoogleSheetsUrl(
            `https://docs.google.com/spreadsheets/d/${id}${tail}`,
          );
          expect(parsed?.spreadsheetId).toBe(id);
        },
      ),
    );
  });
});
