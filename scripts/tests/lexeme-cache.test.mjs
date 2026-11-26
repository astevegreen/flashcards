// The Wikidata lexeme cache of fetch-starter-sources.mjs: verify before caching, and re-download a
// cached copy that no longer verifies. A fake download stands in for Wikidata; no network.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLexeme } from '../starters/lexeme-cache.mjs';

const ID = 'L7';
const REVISION = 42;

function entityData(revision) {
  return Buffer.from(
    JSON.stringify({
      entities: {
        [ID]: {
          type: 'lexeme',
          id: ID,
          lastrevid: revision,
          language: 'Q9176',
          lexicalCategory: 'Q1084',
          lemmas: { ko: { language: 'ko', value: '사람' } },
          senses: [{ id: `${ID}-S1`, glosses: { en: { language: 'en', value: 'person' } } }],
        },
      },
    }),
  );
}

let dir;
let dest;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flash-lexeme-cache-'));
  mkdirSync(join(dir, 'wikidata'));
  dest = join(dir, 'wikidata', `${ID}-r${REVISION}.json`);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('fetchLexeme', () => {
  it('caches a download only after it verifies', async () => {
    const pin = { id: ID, revision: REVISION };
    const download = vi.fn(async () => entityData(REVISION + 1));
    await expect(fetchLexeme(pin, dir, false, download)).rejects.toThrow(
      `got revision ${REVISION + 1}, pinned ${REVISION}`,
    );
    expect(existsSync(dest)).toBe(false);
  });

  it('downloads again when the cached copy no longer verifies, and replaces it', async () => {
    const good = entityData(REVISION);
    const { sha256 } = await fetchLexeme(
      { id: ID, revision: REVISION },
      dir,
      true,
      async () => good,
    );
    writeFileSync(dest, '{"broken":true}');
    const download = vi.fn(async () => good);
    const verified = await fetchLexeme(
      { id: ID, revision: REVISION, sha256 },
      dir,
      false,
      download,
    );
    expect(download).toHaveBeenCalledTimes(1);
    expect(verified.sha256).toBe(sha256);
    expect(readFileSync(dest).equals(good)).toBe(true);
  });

  it('uses a cached copy that verifies without downloading', async () => {
    writeFileSync(dest, entityData(REVISION));
    const download = vi.fn();
    const verified = await fetchLexeme({ id: ID, revision: REVISION }, dir, false, download);
    expect(download).not.toHaveBeenCalled();
    expect(verified.revision).toBe(REVISION);
  });
});
