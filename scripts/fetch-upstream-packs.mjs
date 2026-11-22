#!/usr/bin/env node
/**
 * Downloads the raw upstream open-data sources used by `build-packs.mjs --full` (§3.4, §6.3, §6.4).
 *
 * Raw files are cached OUTSIDE git (default `.cache/upstream-open-data/`, gitignored) together with a
 * `sources.json` provenance record (URL, upstream version, sha256, fetch time). Re-running is a no-op for
 * files already present unless `--force` is passed.
 *
 * Usage:
 *   node scripts/fetch-upstream-packs.mjs [--dir <cache-dir>] [--force] [--skip-jmdict]
 *
 * Sources (all redistributable; see apps/web/public/packs/LICENSES.txt):
 *   - Unicode Unihan database (Unihan.zip → Unihan_Readings/IRGSources/Variants.txt)  Unicode License v3
 *   - KANJIDIC2 (kanjidic2.xml.gz)                                                     CC BY-SA 4.0 (EDRDG)
 *   - JMdict English (JMdict_e.gz)                                                     CC BY-SA 4.0 (EDRDG)
 *   - CC-CEDICT (cedict_1_0_ts_utf-8_mdbg.txt.gz)                                      CC BY-SA 4.0
 *   - KanjiVG single-file XML release (kanjivg-YYYYMMDD.xml.gz)                         CC BY-SA 3.0
 *   - Make Me a Hanzi graphics.txt + Arphic Public License text (pinned commit)        Arphic PL
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/** Pinned Make Me a Hanzi commit (graphics.txt has been stable since 2018). */
export const MMAH_COMMIT = 'bddc96d41bef78427ed0e034e9f7e31d71fd1b92';
const MMAH_RAW = `https://raw.githubusercontent.com/skishore/makemeahanzi/${MMAH_COMMIT}`;

function parseArgs(argv) {
  const out = { dir: join(REPO_ROOT, '.cache', 'upstream-open-data'), force: false, jmdict: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = resolve(argv[++i]);
    else if (a === '--force') out.force = true;
    else if (a === '--skip-jmdict') out.jmdict = false;
  }
  return out;
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'flashcards-pack-builder/1.0 (+open-data pack compiler)' },
  });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resolveKanjivgRelease() {
  const res = await fetch('https://api.github.com/repos/KanjiVG/kanjivg/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'flashcards-pack-builder' },
  });
  if (!res.ok) throw new Error(`KanjiVG release lookup failed: HTTP ${res.status}`);
  const rel = await res.json();
  const asset = rel.assets.find((a) => /^kanjivg-\d{8}\.xml\.gz$/.test(a.name));
  if (!asset) throw new Error(`KanjiVG release ${rel.tag_name} has no single-file .xml.gz asset`);
  return { tag: rel.tag_name, url: asset.browser_download_url, name: asset.name };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rawDir = join(opts.dir, 'raw');
  mkdirSync(rawDir, { recursive: true });

  const sourcesPath = join(opts.dir, 'sources.json');
  const sources = existsSync(sourcesPath) ? JSON.parse(readFileSync(sourcesPath, 'utf8')) : {};

  const kvg = await resolveKanjivgRelease();
  const targets = [
    {
      key: 'unihan',
      file: 'Unihan.zip',
      url: 'https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip',
    },
    {
      key: 'kanjidic2',
      file: 'kanjidic2.xml.gz',
      url: 'https://www.edrdg.org/kanjidic/kanjidic2.xml.gz',
    },
    ...(opts.jmdict
      ? [
          {
            key: 'jmdict',
            file: 'JMdict_e.gz',
            url: 'https://www.edrdg.org/pub/Nihongo/JMdict_e.gz',
          },
        ]
      : []),
    {
      key: 'cedict',
      file: 'cedict_1_0_ts_utf-8_mdbg.txt.gz',
      url: 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
    },
    { key: 'kanjivg', file: 'kanjivg.xml.gz', url: kvg.url, version: kvg.tag },
    {
      key: 'mmah',
      file: 'mmah-graphics.txt',
      url: `${MMAH_RAW}/graphics.txt`,
      version: MMAH_COMMIT,
    },
    {
      key: 'mmah_license',
      file: 'ARPHICPL.TXT',
      url: `${MMAH_RAW}/APL/english/ARPHICPL.TXT`,
      version: MMAH_COMMIT,
    },
  ];

  for (const t of targets) {
    const dest = join(rawDir, t.file);
    const prev = sources[t.key];
    const stale = t.version && prev?.version && prev.version !== t.version;
    if (!opts.force && !stale && existsSync(dest)) {
      console.log(`✓ ${t.file} (cached)`);
      continue;
    }
    process.stdout.write(`↓ ${t.url} … `);
    const buf = await download(t.url);
    writeFileSync(dest, buf);
    sources[t.key] = {
      file: `raw/${t.file}`,
      url: t.url,
      ...(t.version ? { version: t.version } : {}),
      bytes: buf.byteLength,
      sha256: sha256Hex(buf),
      fetched_at: new Date().toISOString(),
    };
    console.log(`${(buf.byteLength / 1024 / 1024).toFixed(1)} MB`);
  }

  // Extract the three Unihan tables we need (Unihan.zip is a flat archive of .txt files).
  const unihanDir = join(opts.dir, 'unihan');
  const wanted = ['Unihan_Readings.txt', 'Unihan_IRGSources.txt', 'Unihan_Variants.txt'];
  if (opts.force || wanted.some((f) => !existsSync(join(unihanDir, f)))) {
    const require = createRequire(join(REPO_ROOT, 'packages', 'core', 'package.json'));
    const { unzipSync } = require('fflate');
    const files = unzipSync(readFileSync(join(rawDir, 'Unihan.zip')), {
      filter: (f) => wanted.includes(f.name.split('/').pop()),
    });
    mkdirSync(unihanDir, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      writeFileSync(join(unihanDir, name.split('/').pop()), data);
    }
    console.log(`✓ extracted ${Object.keys(files).length} Unihan tables`);
  }

  writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + '\n', 'utf8');
  console.log(`Upstream open data ready in ${opts.dir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
