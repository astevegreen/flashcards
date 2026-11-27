// End-to-end test of `build-packs.mjs --full` (the path `publish-packs.yml` runs) against a tiny
// synthetic upstream tree in fixtures/full-upstream/. Every fixture file was written for this repo
// in the upstream's format; none is upstream data. A parser or emitter break fails `pnpm test`.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decodePackArchive,
  parseAndValidatePackCatalog,
} from '../../packages/core/src/dictionary/pack-codec.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', 'build-packs.mjs');
const FIXTURE = join(HERE, 'fixtures', 'full-upstream');
/** Fixture files kept as plain text in git, gzipped under the names the build reads. */
const GZIPPED = {
  'raw/kanjidic2.xml': 'raw/kanjidic2.xml.gz',
  'raw/JMdict_e.xml': 'raw/JMdict_e.gz',
  'raw/cedict.txt': 'raw/cedict_1_0_ts_utf-8_mdbg.txt.gz',
  'raw/kanjivg.xml': 'raw/kanjivg.xml.gz',
};
/** Entries (or characters) each pack must hold, from the fixture. */
const EXPECTED = {
  'dict-hanja-unihan': 2,
  'dict-kanjidic2': 1,
  'dict-cc-cedict': 2,
  'dict-jmdict': 1,
  'dict-krdict': 1,
  'dict-urimalsam': 1,
  'dict-kaikki-ko': 1,
  'strokes-ja-kanjivg': 1,
  'strokes-zh-mmah': 1,
};

const dirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function syntheticUpstream() {
  const input = tempDir('flash-full-upstream-');
  cpSync(FIXTURE, input, { recursive: true });
  for (const [plain, gz] of Object.entries(GZIPPED)) {
    writeFileSync(join(input, gz), gzipSync(readFileSync(join(input, plain))));
    rmSync(join(input, plain));
  }
  return input;
}

describe('build-packs.mjs --full (synthetic upstream)', () => {
  it('parses every upstream format and writes packs the runtime codec accepts', () => {
    const input = syntheticUpstream();
    const out = tempDir('flash-full-packs-');
    const log = execFileSync(process.execPath, [BUILD, '--full', '--input', input, '--out', out], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(log).toMatch(/Built 9 full packs/);

    const catalog = parseAndValidatePackCatalog(readFileSync(join(out, 'packs.json'), 'utf8'), {
      allowRelativeUrls: true,
    });
    expect(Object.fromEntries(catalog.packs.map((p) => [p.id, p.entry_count]))).toEqual(EXPECTED);
    for (const entry of catalog.packs) {
      const bytes = new Uint8Array(readFileSync(join(out, entry.url.replace(/^\/packs\//, ''))));
      const decoded = decodePackArchive(bytes, { expectedSha256: entry.sha256 });
      const count =
        'entries' in decoded ? decoded.entries.length : Object.keys(decoded.characters).length;
      expect([entry.id, count]).toEqual([entry.id, EXPECTED[entry.id]]);
    }
    expect(existsSync(join(out, 'ARPHIC-PL.txt'))).toBe(true);
    expect(existsSync(join(out, 'LICENSES.txt'))).toBe(true);
  }, 30_000);

  it('fails when a required upstream file is missing', () => {
    const input = syntheticUpstream();
    rmSync(join(input, 'raw', 'kanjidic2.xml.gz'));
    const out = tempDir('flash-full-packs-');
    expect(() =>
      execFileSync(process.execPath, [BUILD, '--full', '--input', input, '--out', out], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow(/Missing upstream file/);
  }, 30_000);
});
