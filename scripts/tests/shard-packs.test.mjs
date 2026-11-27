// End-to-end test of first-syllable sharding in scripts/build-packs.mjs: a lowered size limit
// forces the small starter KRDict pack into shards. Builds into a temp dir; no network.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decodeDictionaryShard,
  decodePackArchive,
  parseAndValidatePackCatalog,
} from '../../packages/core/src/dictionary/pack-codec.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = join(ROOT, 'scripts', 'build-packs.mjs');
const STARTER = join(ROOT, 'apps', 'web', 'public', 'packs');
const dirs = [];

function outDir() {
  const dir = mkdtempSync(join(tmpdir(), 'flash-shard-packs-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Each test spawns a Node process that rebuilds every starter pack: under a second idle, but seconds when other
// gates load the machine, so these get more than vitest's 5 s default.
describe('build-packs.mjs sharding', { timeout: 30_000 }, () => {
  it('--shard splits KRDict into an index plus shards that decode back to the full pack', () => {
    const out = outDir();
    // A stale shard from an earlier, more finely sharded build must be cleaned up.
    writeFileSync(join(out, 'dict-krdict.s99.json.gz'), 'stale');
    const log = execFileSync(
      process.execPath,
      [BUILD, '--starter', '--out', out, '--shard', 'dict-krdict', '--shard-size', '2K'],
      { encoding: 'utf8' },
    );
    expect(log).toMatch(/dict-krdict\.json\.gz \(index\)/);
    expect(existsSync(join(out, 'dict-krdict.s99.json.gz'))).toBe(false);

    const catalog = parseAndValidatePackCatalog(readFileSync(join(out, 'packs.json'), 'utf8'), {
      allowRelativeUrls: true,
    });
    const entry = catalog.packs.find((p) => p.id === 'dict-krdict');
    const shardFiles = readdirSync(out).filter((f) => /^dict-krdict\.s\d\d\.json\.gz$/.test(f));
    expect(entry?.url).toBe('/packs/dict-krdict.json.gz');
    expect(entry?.shards).toMatchObject({ scheme: 'first-syllable-v1', count: shardFiles.length });
    expect(shardFiles.length).toBeGreaterThan(1);
    // Other packs are untouched.
    expect(catalog.packs.find((p) => p.id === 'dict-jmdict')?.shards).toBeUndefined();
    // Compare the JSON, not the gzip bytes: zlib output differs between platforms.
    expect(gunzipSync(readFileSync(join(out, 'dict-jmdict.json.gz')))).toEqual(
      gunzipSync(readFileSync(join(STARTER, 'dict-jmdict.json.gz'))),
    );

    const index = decodePackArchive(new Uint8Array(readFileSync(join(out, entry?.url.slice(7)))), {
      expectedSha256: entry?.sha256,
    });
    const full = decodePackArchive(
      new Uint8Array(readFileSync(join(STARTER, 'dict-krdict.json.gz'))),
    );
    if (!('entries' in index) || !('entries' in full) || !index.manifest.sharding) {
      throw new Error('expected a sharded dictionary index');
    }
    expect(index.entries.map((e) => e.headword)).toEqual(full.entries.map((e) => e.headword));
    const rebuilt = new Array(full.entries.length);
    for (const shard of index.manifest.sharding.shards) {
      expect(shard.compressed_bytes).toBeLessThanOrEqual(2048);
      const decoded = decodeDictionaryShard(new Uint8Array(readFileSync(join(out, shard.file))), {
        packId: 'dict-krdict',
        version: index.manifest.version,
        sharding: index.manifest.sharding,
        shard,
      });
      decoded.indices.forEach((idx, i) => {
        rebuilt[idx] = decoded.entries[i];
      });
    }
    expect(rebuilt).toEqual(full.entries);
  });

  it('shards a dictionary pack over --max-file-size automatically and prints every size', () => {
    const out = outDir();
    const res = spawnSync(
      process.execPath,
      [BUILD, '--starter', '--out', out, '--max-file-size', '3K', '--shard-size', '2K'],
      { encoding: 'utf8' },
    );
    // Stroke packs can't shard, so the build fails, but only after printing every pack's size.
    expect(res.status).toBe(1);
    for (const f of ['dict-hanja-unihan', 'dict-krdict', 'strokes-ja-kanjivg', 'strokes-zh-mmah']) {
      expect(res.stdout).toContain(`${f}.json.gz`);
    }
    expect(res.stdout).toMatch(/dict-krdict\.json\.gz \(unsharded, not written\)/);
    expect(res.stdout).toMatch(/dict-krdict\.s01\.json\.gz/);
    expect(res.stderr).toMatch(/strokes-ja-kanjivg\.json\.gz: \d+ B gzipped exceeds/);
    expect(res.stderr).not.toMatch(/Pack dict-krdict\.s\d\d/);
    expect(existsSync(join(out, 'packs.json'))).toBe(false);
  });
});
