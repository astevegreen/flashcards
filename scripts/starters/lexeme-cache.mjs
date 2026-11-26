// The Wikidata lexeme cache of scripts/fetch-starter-sources.mjs, apart from the script so tests
// can drive it with a fake download (scripts/tests/lexeme-cache.test.mjs).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalLexemeJson, normalizeLexeme } from './lib.mjs';

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Checks one lexeme revision against its pin; returns the pin with its normalized sha256. */
export function verifyLexeme(pin, buf) {
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
 * Returns the verified pin for one lexeme revision, from `<dir>/wikidata/` or `download(pin)`.
 * Like fetchPinned: a cached revision that no longer verifies is downloaded again, and a download
 * is written to the cache only after it verifies, so the cache never holds an unverified file.
 */
export async function fetchLexeme(pin, dir, force, download) {
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
  const buf = await download(pin);
  const verified = verifyLexeme(pin, buf);
  writeFileSync(dest, buf);
  return verified;
}
