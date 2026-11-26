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
 *   - KRDict 한국어기초사전 (NIKL), English edition — MANUAL step, see below            CC BY-SA 2.0 KR
 *
 * KRDict manual step: krdict.korean.go.kr offers the full dictionary only through its
 * "사전 전체 내려받기" popup (and its Open API needs a registered key), so this script never
 * downloads it. Download the XML export yourself (English edition or the full multilingual one;
 * only English equivalents are kept), then put the .zip or .xml files in
 * .cache/upstream-open-data/krdict/. This script unzips them in place and records provenance;
 * uild-packs.mjs --full then builds dict-krdict. Pass --krdict-version <label> (e.g. the
 * export date) to stamp the pack version.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPinnedDownload, cachedCopyMatches } from './packs/upstream-pins.mjs';
import { UNICODE_LICENSE, UNIHAN } from './starters/sources.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/** Pinned Make Me a Hanzi commit (graphics.txt has been stable since 2018). */
export const MMAH_COMMIT = 'bddc96d41bef78427ed0e034e9f7e31d71fd1b92';
const MMAH_RAW = `https://raw.githubusercontent.com/skishore/makemeahanzi/${MMAH_COMMIT}`;

function parseArgs(argv) {
  const out = {
    dir: join(REPO_ROOT, '.cache', 'upstream-open-data'),
    force: false,
    jmdict: true,
    krdictVersion: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = resolve(argv[++i]);
    else if (a === '--force') out.force = true;
    else if (a === '--skip-jmdict') out.jmdict = false;
    else if (a === '--krdict-version') out.krdictVersion = argv[++i];
    else if (a === '--urimalsam-version') out.urimalsamVersion = argv[++i];
    else if (a === '--kaikki-version') out.kaikkiVersion = argv[++i];
  }
  return out;
}

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

/**
 * KRDict cannot be fetched unattended (see header). Unzips any manually placed export in
 * <dir>/krdict/ and records provenance, or prints exactly what the owner needs to do.
 */
function prepareManualKrdict(opts, sources) {
  const dir = join(opts.dir, 'krdict');
  mkdirSync(dir, { recursive: true });
  const list = () => readdirSync(dir, { recursive: true }).map(String);
  const zips = list().filter((f) => /\.zip$/i.test(f));
  if (zips.length > 0) {
    const require = createRequire(join(REPO_ROOT, 'packages', 'core', 'package.json'));
    const { unzipSync } = require('fflate');
    for (const zip of zips) {
      const files = unzipSync(readFileSync(join(dir, zip)), {
        filter: (f) => /\.xml$/i.test(f.name) && !f.name.includes('..'),
      });
      for (const [name, data] of Object.entries(files)) {
        writeFileSync(join(dir, name.split('/').pop()), data);
      }
      console.log(`✓ extracted ${Object.keys(files).length} KRDict XML file(s) from ${zip}`);
    }
  }
  const xmls = list()
    .filter((f) => /\.xml(\.gz)?$/i.test(f))
    .sort();
  if (xmls.length === 0) {
    console.warn(
      [
        '! KRDict (dict-krdict) not found — manual download required:',
        '  1. Open https://krdict.korean.go.kr/ → "사전 전체 내려받기" (dictionary download).',
        '     Choose the XML export of the English edition (or the multilingual export).',
        '  2. Save the .zip or .xml files to:',
        `     ${dir}`,
        '  3. Re-run this script (it unzips and records provenance), then build-packs.mjs --full.',
        '  Text is CC BY-SA 2.0 KR (NIKL); audio/images are licensed per file and are not used.',
      ].join('\n'),
    );
    return;
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for (const f of xmls) {
    const buf = readFileSync(join(dir, f));
    hash.update(buf);
    bytes += buf.byteLength;
  }
  sources.krdict = {
    file: 'krdict/',
    files: xmls,
    url: 'https://krdict.korean.go.kr/ (manual download)',
    version: opts.krdictVersion ?? sources.krdict?.version ?? new Date().toISOString().slice(0, 10),
    bytes,
    sha256: hash.digest('hex'),
    fetched_at: new Date().toISOString(),
  };
  console.log(`✓ KRDict: ${xmls.length} XML file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

/**
 * Prepares an optional manually downloaded Korean share-alike source (Urimalsaem / Kaikki).
 * Unzips any `.zip` archives in place and records provenance in `sources.json`, or logs concise
 * instructions when the folder is empty.
 */
function prepareManualExtraKoreanPack(opts, sources, cfg) {
  const dir = join(opts.dir, cfg.dirName);
  mkdirSync(dir, { recursive: true });
  const list = () => readdirSync(dir, { recursive: true }).map(String);
  const zips = list().filter((f) => /\.zip$/i.test(f));
  if (zips.length > 0) {
    const require = createRequire(join(REPO_ROOT, 'packages', 'core', 'package.json'));
    const { unzipSync } = require('fflate');
    for (const zip of zips) {
      const files = unzipSync(readFileSync(join(dir, zip)), {
        filter: (f) => cfg.fileRe.test(f.name) && !f.name.includes('..'),
      });
      for (const [name, data] of Object.entries(files)) {
        writeFileSync(join(dir, name.split('/').pop()), data);
      }
      console.log(`✓ extracted ${Object.keys(files).length} ${cfg.label} file(s) from ${zip}`);
    }
  }
  const matched = list()
    .filter((f) => cfg.fileRe.test(f))
    .sort();
  if (matched.length === 0) {
    console.warn(
      [
        `! ${cfg.label} (${cfg.packId}, optional) not found — manual download:`,
        ...cfg.instructions,
        `     ${dir}`,
        '  3. Re-run this script, then build-packs.mjs --full.',
      ].join('\n'),
    );
    return;
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for (const f of matched) {
    const buf = readFileSync(join(dir, f));
    hash.update(buf);
    bytes += buf.byteLength;
  }
  sources[cfg.key] = {
    file: `${cfg.dirName}/`,
    files: matched,
    url: cfg.url,
    version: cfg.version ?? sources[cfg.key]?.version ?? new Date().toISOString().slice(0, 10),
    bytes,
    sha256: hash.digest('hex'),
    fetched_at: new Date().toISOString(),
  };
  console.log(`✓ ${cfg.label}: ${matched.length} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rawDir = join(opts.dir, 'raw');
  mkdirSync(rawDir, { recursive: true });

  const sourcesPath = join(opts.dir, 'sources.json');
  const sources = existsSync(sourcesPath) ? JSON.parse(readFileSync(sourcesPath, 'utf8')) : {};

  const kvg = await resolveKanjivgRelease();
  const targets = [
    // Pinned with the starter decks' Unihan release and hash, not `latest` (S13).
    {
      key: 'unihan',
      file: 'Unihan.zip',
      url: UNIHAN.url,
      version: UNIHAN.version,
      sha256: UNIHAN.sha256,
    },
    {
      key: 'unicode_license',
      file: 'unicode-license.txt',
      url: UNICODE_LICENSE.url,
      sha256: UNICODE_LICENSE.sha256,
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
    if (
      !opts.force &&
      !stale &&
      existsSync(dest) &&
      cachedCopyMatches(t, readFileSync(dest), prev)
    ) {
      console.log(`✓ ${t.file} (cached)`);
      continue;
    }
    process.stdout.write(`↓ ${t.url} … `);
    const buf = await download(t.url);
    const sha256 = assertPinnedDownload(t, buf, prev);
    writeFileSync(dest, buf);
    sources[t.key] = {
      file: `raw/${t.file}`,
      url: t.url,
      ...(t.version ? { version: t.version } : {}),
      bytes: buf.byteLength,
      sha256,
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

  prepareManualKrdict(opts, sources);
  prepareManualExtraKoreanPack(opts, sources, {
    key: 'urimalsam',
    dirName: 'urimalsam',
    packId: 'dict-urimalsam',
    label: 'Urimalsaem (우리말샘)',
    url: 'https://opendict.korean.go.kr/ (manual download)',
    version: opts.urimalsamVersion,
    fileRe: /\.(xml|json)(\.gz)?$/i,
    instructions: [
      '  1. Open https://opendict.korean.go.kr/ → "내려받기" (open data download, CC BY-SA 2.0 KR).',
      '  2. Save the JSON or XML .zip/.json/.xml files to:',
    ],
  });
  prepareManualExtraKoreanPack(opts, sources, {
    key: 'kaikki_ko',
    dirName: 'kaikki-ko',
    packId: 'dict-kaikki-ko',
    label: 'Kaikki Wiktionary Korean',
    url: 'https://kaikki.org/dictionary/Korean/ (manual download)',
    version: opts.kaikkiVersion,
    fileRe: /\.jsonl(\.gz)?$/i,
    instructions: [
      '  1. Download kaikki.org-dictionary-Korean.jsonl (or .jsonl.gz) from https://kaikki.org/dictionary/Korean/ (CC BY-SA 4.0).',
      '  2. Save the file to:',
    ],
  });

  writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + '\n', 'utf8');
  console.log(`Upstream open data ready in ${opts.dir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
