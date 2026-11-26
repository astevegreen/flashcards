// `build-packs.mjs --starter --check`: fails on a missing, extra or different file, tolerates gzip
// bytes that differ for the same content, and checks compressed_bytes against the files. No network.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = join(ROOT, 'scripts', 'build-packs.mjs');
const run = (...args) =>
  spawnSync(process.execPath, [BUILD, '--starter', '--out', out, ...args], { encoding: 'utf8' });

let out;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'flash-packs-check-'));
  expect(run().status).toBe(0);
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

function expectCheckFails(message) {
  const res = run('--check');
  expect(res.status).toBe(1);
  expect(res.stderr).toContain(message);
}

describe('build-packs --starter --check', () => {
  it('passes on a fresh build', () => {
    const res = run('--check');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('match a fresh rebuild');
  });

  it('fails when a built file is missing', () => {
    unlinkSync(join(out, 'strokes', 'ja', '04e00.json'));
    expectCheckFails('missing: strokes/ja/04e00.json');
  });

  it('fails on a file a rebuild does not produce', () => {
    writeFileSync(join(out, 'stray.json'), '{}');
    expectCheckFails('not produced by a rebuild: stray.json');
  });

  it('fails when a file differs from the rebuild', () => {
    appendFileSync(join(out, 'strokes', 'ja', '04e00.json'), ' ');
    expectCheckFails('differs from a rebuild: strokes/ja/04e00.json');
  });

  it('fails when a .gz pack decompresses to different data', () => {
    const file = join(out, 'dict-jmdict.json.gz');
    writeFileSync(
      file,
      gzipSync(Buffer.concat([gunzipSync(readFileSync(file)), Buffer.from(' ')])),
    );
    expectCheckFails('differs from a rebuild: dict-jmdict.json.gz');
  });

  it('accepts different gzip bytes for the same data when compressed_bytes matches them', () => {
    const file = join(out, 'dict-jmdict.json.gz');
    const before = readFileSync(file);
    const recompressed = gzipSync(gunzipSync(before), { level: 1 });
    expect(recompressed.equals(before)).toBe(false);
    writeFileSync(file, recompressed);
    const catalogPath = join(out, 'packs.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    catalog.packs.find((p) => p.id === 'dict-jmdict').compressed_bytes = recompressed.byteLength;
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    expect(run('--check').status).toBe(0);
  });

  it('fails when compressed_bytes does not match the committed file', () => {
    const catalogPath = join(out, 'packs.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    catalog.packs.find((p) => p.id === 'dict-jmdict').compressed_bytes += 1;
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    expectCheckFails('packs.json: dict-jmdict compressed_bytes');
  });
});
