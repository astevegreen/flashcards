#!/usr/bin/env node
/**
 * Builds the curated onboarding starter decks (Phase 14 Stream D) from the pinned open data that
 * `scripts/fetch-starter-sources.mjs` put in the gitignored cache. Offline and deterministic: no
 * network, no Date, no randomness, code-unit/numeric ordering only, pinned sha256 inputs, and the
 * output is formatted with the repo's own (lockfile-pinned) Prettier, so a rebuild is
 * byte-identical.
 *
 * Usage:
 *   node scripts/build-starter-decks.mjs [--dir <cache-dir>] [--check]
 *
 * Writes packages/core/src/starters/generated/{catalog,ko-core,zh-common}.ts. `--check` writes
 * nothing and exits 1 if the committed files differ from a fresh build.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import {
  buildKoreanNotes,
  buildMandarinNotes,
  canonicalLexemeJson,
  normalizeLexeme,
  parseNiklList,
  parseTraditionalOnly,
  parseUnihanReadings,
  renderCatalogModule,
  renderDeckModule,
  validateNotes,
} from './starters/lib.mjs';
import { NIKL_VOCAB, STARTER_DECKS_VERSION, UNIHAN, WIKIDATA } from './starters/sources.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
export const GENERATED_DIR = join(REPO_ROOT, 'packages', 'core', 'src', 'starters', 'generated');

/** Deck size: small enough to finish in a few weeks at 20 new cards a day (an owner question). */
export const STARTER_DECK_SIZE = 150;

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

const KOGL_ATTRIBUTION_KO =
  "이 덱은 국립국어원에서 2003년 작성하여 공공누리 제1유형으로 개방한 '한국어 학습용 어휘 목록'을 이용하였으며, 해당 저작물은 국립국어원 누리집(https://www.korean.go.kr)에서 무료로 내려받을 수 있습니다.";

const NIKL_SOURCE = {
  name: 'NIKL Korean learning vocabulary list (한국어 학습용 어휘 목록, 2003)',
  licence: 'KOGL Type 1 (공공누리 제1유형)',
  licenceUrl: 'https://www.kogl.or.kr/info/licenseType1.do',
  sourceUrl: NIKL_VOCAB.pageUrl,
  attribution: `National Institute of Korean Language (국립국어원), 한국어 학습용 어휘 목록 (2003), KOGL Type 1. ${KOGL_ATTRIBUTION_KO}`,
  changes:
    'Level-A (초급) entries kept in the list’s frequency-rank order; homograph numbers dropped.',
};

const WIKIDATA_SOURCE = {
  name: 'Wikidata lexemes (Korean, English glosses)',
  licence: 'CC0 1.0',
  licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  sourceUrl: 'https://www.wikidata.org/wiki/Wikidata:Lexicographical_data',
  attribution: 'English meanings from Wikidata lexemes (CC0 1.0), one pinned revision each.',
  changes: 'Up to three English glosses per word, matched by spelling, part of speech and Hanja.',
};

const UNIHAN_SOURCE = {
  name: `Unicode Unihan database ${UNIHAN.version}`,
  licence: 'Unicode License v3',
  licenceUrl: 'https://www.unicode.org/license.txt',
  sourceUrl: 'https://www.unicode.org/charts/unihan.html',
  attribution: `Copyright © 1991-2026 Unicode, Inc. Unihan ${UNIHAN.version} (kHanyuPinlu, kMandarin, kDefinition, kSimplifiedVariant), used under the Unicode License v3.`,
  changes:
    'The most frequent simplified characters by kHanyuPinlu counts, with their kMandarin pinyin and kDefinition.',
};

function readCached(dir, rel, sha256) {
  const path = join(dir, rel);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing: run node scripts/fetch-starter-sources.mjs first`);
  }
  const buf = readFileSync(path);
  if (sha256 && sha256Hex(buf) !== sha256) throw new Error(`${path}: sha256 mismatch`);
  return buf;
}

function loadLexemes(dir) {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, WIKIDATA.lockFile), 'utf8'));
  return lock.lexemes.map((pin) => {
    const raw = readCached(dir, join('wikidata', `${pin.id}-r${pin.revision}.json`));
    const lexeme = normalizeLexeme(JSON.parse(raw.toString('utf8')), pin.id);
    if (sha256Hex(canonicalLexemeJson(lexeme)) !== pin.sha256) {
      throw new Error(`${pin.id}@${pin.revision}: normalized record does not match the lock file`);
    }
    return lexeme;
  });
}

/** Deck content hash: sha256 of the canonical JSON of its notes. */
function contentHash(notes) {
  return sha256Hex(JSON.stringify(notes));
}

/** Builds both starter decks from parsed inputs (no I/O). */
export function buildStarterDecks({
  niklText,
  unihanReadingsText,
  unihanVariantsText,
  lexemes,
  size = STARTER_DECK_SIZE,
}) {
  const koNotes = buildKoreanNotes({ niklRows: parseNiklList(niklText), lexemes, size });
  validateNotes(koNotes, 'word');
  const zhNotes = buildMandarinNotes({
    readings: parseUnihanReadings(unihanReadingsText),
    traditional: parseTraditionalOnly(unihanVariantsText),
    unihanVersion: UNIHAN.version,
    size,
  });
  validateNotes(zhNotes, 'word');
  return [
    {
      file: 'ko-core.ts',
      info: {
        slug: 'starter-ko-core',
        name: 'Korean Core + Hanja',
        language: 'ko',
        noteTypeId: 'preset:vocab-ko',
        noteCount: koNotes.length,
        version: STARTER_DECKS_VERSION,
        contentHash: contentHash(koNotes),
        description:
          'Beginner (level A) Korean words from the NIKL learning vocabulary list, most frequent first, with Hanja for Sino-Korean words and English meanings from Wikidata.',
        sources: [NIKL_SOURCE, WIKIDATA_SOURCE],
      },
      notes: koNotes,
    },
    {
      file: 'zh-common.ts',
      info: {
        slug: 'starter-zh-common',
        name: 'Mandarin Basics: Common Characters',
        language: 'zh-Hans',
        noteTypeId: 'preset:vocab-zh',
        noteCount: zhNotes.length,
        version: STARTER_DECKS_VERSION,
        contentHash: contentHash(zhNotes),
        description:
          'The most frequent characters of modern Mandarin, with pinyin and English definitions from the Unicode Unihan database.',
        sources: [UNIHAN_SOURCE],
      },
      notes: zhNotes,
    },
  ];
}

/** Renders and Prettier-formats every generated module: `{ fileName: source }`. */
export async function renderStarterModules(decks) {
  const config = (await prettier.resolveConfig(join(GENERATED_DIR, 'catalog.ts'))) ?? {};
  const format = (source) => prettier.format(source, { ...config, parser: 'typescript' });
  const out = new Map();
  out.set(
    'catalog.ts',
    await format(
      renderCatalogModule(decks.map((d) => ({ ...d.info, module: d.file.replace('.ts', '') }))),
    ),
  );
  for (const deck of decks) {
    out.set(deck.file, await format(renderDeckModule({ slug: deck.info.slug, notes: deck.notes })));
  }
  return out;
}

/** Reads the cache and builds every module. */
export async function buildFromCache(dir) {
  const niklText = new TextDecoder(NIKL_VOCAB.encoding).decode(
    readCached(dir, join('raw', NIKL_VOCAB.file), NIKL_VOCAB.sha256),
  );
  readCached(dir, join('raw', UNIHAN.file), UNIHAN.sha256);
  const unihanReadingsText = readCached(dir, join('unihan', UNIHAN.readingsFile)).toString('utf8');
  const unihanVariantsText = readCached(dir, join('unihan', UNIHAN.variantsFile)).toString('utf8');
  const decks = buildStarterDecks({
    niklText,
    unihanReadingsText,
    unihanVariantsText,
    lexemes: loadLexemes(dir),
  });
  return renderStarterModules(decks);
}

export const DEFAULT_CACHE_DIR = join(REPO_ROOT, '.cache', 'starter-sources');

async function main() {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf('--dir');
  const dir = dirFlag >= 0 ? resolve(argv[dirFlag + 1]) : DEFAULT_CACHE_DIR;
  const modules = await buildFromCache(dir);
  if (!argv.includes('--check')) mkdirSync(GENERATED_DIR, { recursive: true });
  let stale = 0;
  for (const [name, source] of modules) {
    const path = join(GENERATED_DIR, name);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (current === source) continue;
    stale++;
    if (argv.includes('--check')) console.error(`✗ ${name} differs from a fresh build`);
    else writeFileSync(path, source, 'utf8');
  }
  if (argv.includes('--check') && stale > 0) process.exit(1);
  console.log(
    `✓ starter decks ${argv.includes('--check') ? 'checked' : 'built'} (${stale} changed)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
