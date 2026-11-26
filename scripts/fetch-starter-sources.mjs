#!/usr/bin/env node
/**
 * Downloads the pinned open-data sources for the onboarding starter decks into the gitignored
 * cache (default `.cache/starter-sources/`), checking every pinned sha256. Network step only;
 * `scripts/build-starter-decks.mjs` then builds offline from the cache.
 *
 * Usage:
 *   node scripts/fetch-starter-sources.mjs [--dir <cache-dir>] [--force]
 *   node scripts/fetch-starter-sources.mjs --discover   # owner step: re-pin Wikidata lexemes
 *
 * `--discover` asks the Wikidata Query Service for every Korean lexeme that has an English gloss
 * and whose lemma is a NIKL level-A word, pins each one to its current revision and rewrites
 * content/starters/wikidata-ko-lexemes.lock.json (review the diff, then rebuild and commit).
 * Without it, only the revisions already in the lock file are fetched.
 *
 * Sources (licences checked for commercial redistribution; see scripts/starters/sources.mjs):
 *   - NIKL 한국어 학습용 어휘 목록 (2003)       KOGL Type 1
 *   - Unicode Unihan 17.0.0 (Unihan_Readings)  Unicode License v3
 *   - Wikidata lexemes (pinned revisions)      CC0 1.0
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalLexemeJson,
  compareLexemeIds,
  normalizeLexeme,
  parseNiklList,
} from './starters/lib.mjs';
import { NIKL_VOCAB, UNICODE_LICENSE, UNIHAN, USER_AGENT, WIKIDATA } from './starters/sources.mjs';
import { unzipSync } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { dir: join(REPO_ROOT, '.cache', 'starter-sources'), force: false, discover: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = resolve(argv[++i]);
    else if (a === '--force') out.force = true;
    else if (a === '--discover') out.discover = true;
  }
  return out;
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url, init = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Downloads `source` to `<dir>/raw/<file>` unless cached; fails on a sha256 mismatch. */
async function fetchPinned(source, dir, force) {
  const dest = join(dir, 'raw', source.file);
  if (!force && existsSync(dest)) {
    const cached = readFileSync(dest);
    if (!source.sha256 || sha256Hex(cached) === source.sha256) {
      console.log(`✓ ${source.file} (cached)`);
      return cached;
    }
  }
  process.stdout.write(`↓ ${source.url} … `);
  const buf = await download(source.url);
  const hash = sha256Hex(buf);
  if (source.sha256 && hash !== source.sha256) {
    throw new Error(`${source.file}: sha256 ${hash} does not match the pinned ${source.sha256}`);
  }
  writeFileSync(dest, buf);
  console.log(`${(buf.byteLength / 1024).toFixed(0)} KB, sha256 ${hash}`);
  return buf;
}

const UNIHAN_TABLES = [UNIHAN.readingsFile, UNIHAN.variantsFile];

function extractUnihanTables(zip, dir) {
  const files = unzipSync(zip, { filter: (f) => UNIHAN_TABLES.includes(f.name.split('/').pop()) });
  for (const table of UNIHAN_TABLES) {
    const entry = Object.entries(files).find(([name]) => name.split('/').pop() === table);
    if (!entry) throw new Error(`${UNIHAN.file} has no ${table}`);
    writeFileSync(join(dir, 'unihan', table), entry[1]);
  }
  console.log(`✓ extracted ${UNIHAN_TABLES.join(', ')}`);
}

const ESCAPED_BACKSLASH = String.raw`\\`;
const ESCAPED_QUOTE = String.raw`\"`;

function sparqlString(value) {
  const escaped = value.replaceAll('\\', ESCAPED_BACKSLASH).replaceAll('"', ESCAPED_QUOTE);
  return `"${escaped}"@ko`;
}

/** Owner step: pins every Korean lexeme with an English gloss whose lemma is a NIKL A word. */
async function discoverLexemes(niklText) {
  const words = [
    ...new Set(
      parseNiklList(niklText)
        .filter((r) => r.grade === 'A')
        .map((r) => r.word),
    ),
  ];
  const query = `SELECT DISTINCT ?l ?rev WHERE {
  VALUES ?lemma { ${words.map(sparqlString).join(' ')} }
  ?l dct:language wd:${WIKIDATA.koreanLanguageItem} ; wikibase:lemma ?lemma ; schema:version ?rev .
  FILTER EXISTS { ?l ontolex:sense/skos:definition ?g . FILTER(LANG(?g) = "en") }
}`;
  const body = new URLSearchParams({ query });
  const buf = await download(WIKIDATA.sparqlUrl, {
    method: 'POST',
    body,
    headers: { Accept: 'application/sparql-results+json' },
  });
  const rows = JSON.parse(buf.toString('utf8')).results.bindings;
  const pins = new Map();
  for (const row of rows) {
    const id = row.l.value.split('/').pop();
    pins.set(id, Number(row.rev.value));
  }
  console.log(`✓ discovered ${pins.size} lexemes for ${words.length} NIKL level-A words`);
  return [...pins.entries()]
    .toSorted((a, b) => compareLexemeIds(a[0], b[0]))
    .map(([id, revision]) => ({ id, revision }));
}

/** Checks one lexeme revision against its pin; returns the pin with its normalized sha256. */
function verifyLexeme(pin, buf) {
  const normalized = normalizeLexeme(JSON.parse(buf.toString('utf8')), pin.id);
  if (normalized.revision !== pin.revision) {
    throw new Error(`${pin.id}: got revision ${normalized.revision}, pinned ${pin.revision}`);
  }
  const hash = sha256Hex(canonicalLexemeJson(normalized));
  if (pin.sha256 && hash !== pin.sha256) {
    throw new Error(`${pin.id}@${pin.revision}: normalized sha256 ${hash} ≠ pinned ${pin.sha256}`);
  }
  return { ...pin, sha256: hash };
}

/**
 * Like fetchPinned: a cached revision that no longer verifies is downloaded again, and a download
 * is written to the cache only after it verifies, so the cache never holds an unverified file.
 */
async function fetchLexeme(pin, dir, force) {
  const dest = join(dir, 'wikidata', `${pin.id}-r${pin.revision}.json`);
  if (!force && existsSync(dest)) {
    try {
      return verifyLexeme(pin, readFileSync(dest));
    } catch (err) {
      console.warn(
        `! ${pin.id}: cached copy failed verification, downloading again (${err.message})`,
      );
    }
  }
  const buf = await download(WIKIDATA.entityDataUrl(pin.id, pin.revision));
  const verified = verifyLexeme(pin, buf);
  writeFileSync(dest, buf);
  return verified;
}

/** Fetches pinned lexeme revisions a few at a time (Wikimedia asks clients to stay gentle). */
async function fetchLexemes(pins, dir, force) {
  const out = new Array(pins.length);
  let next = 0;
  const worker = async () => {
    while (next < pins.length) {
      const i = next++;
      out[i] = await fetchLexeme(pins[i], dir, force);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  console.log(`✓ ${out.length} Wikidata lexeme revisions verified`);
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  for (const sub of ['raw', 'unihan', 'wikidata'])
    mkdirSync(join(opts.dir, sub), { recursive: true });

  const nikl = await fetchPinned(NIKL_VOCAB, opts.dir, opts.force);
  const unihanZip = await fetchPinned(UNIHAN, opts.dir, opts.force);
  await fetchPinned(UNICODE_LICENSE, opts.dir, opts.force);
  if (opts.force || UNIHAN_TABLES.some((t) => !existsSync(join(opts.dir, 'unihan', t)))) {
    extractUnihanTables(unihanZip, opts.dir);
  }

  const lockPath = join(REPO_ROOT, WIKIDATA.lockFile);
  const niklText = new TextDecoder(NIKL_VOCAB.encoding).decode(nikl);
  const pins = opts.discover
    ? await discoverLexemes(niklText)
    : JSON.parse(readFileSync(lockPath, 'utf8')).lexemes;
  const verified = await fetchLexemes(pins, opts.dir, opts.force);
  if (opts.discover) {
    const lock = {
      source: 'Wikidata lexemes (CC0 1.0), one pinned revision each',
      query: 'Korean lexemes with an English gloss whose lemma is a NIKL level-A word',
      lexemes: verified,
    };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    console.log(`✓ wrote ${WIKIDATA.lockFile} (${verified.length} lexemes)`);
  }
  console.log(`Starter-deck sources ready in ${opts.dir}`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
