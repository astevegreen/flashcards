// Hash pinning for `scripts/fetch-upstream-packs.mjs` (S13). Kept free of network and file access
// so `pnpm test` can check it offline.
import { createHash } from 'node:crypto';

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The sha256 a download of `target` must have, or `undefined` when it cannot be pinned:
 * - `target.sha256` when the source is pinned in the repo (a versioned URL);
 * - otherwise, for an immutable version (a commit or release tag) already fetched once, the hash
 *   recorded in `sources.json` then, so that version can never silently change;
 * - nothing for the rolling sources (KANJIDIC2, JMdict, CC-CEDICT), which their publishers
 *   rebuild at the same URL every day; their hash is still recorded as provenance.
 */
export function expectedSha256(target, prev) {
  if (target.sha256) return target.sha256;
  if (target.version && prev?.version === target.version && prev.sha256) return prev.sha256;
  return undefined;
}

/** Throws when `buf` (downloaded for `target`) does not match its pinned hash. */
export function assertPinnedDownload(target, buf, prev) {
  const expected = expectedSha256(target, prev);
  const actual = sha256Hex(buf);
  if (expected && actual !== expected) {
    throw new Error(`${target.file}: sha256 ${actual} does not match the pinned ${expected}`);
  }
  return actual;
}

/** True when a cached copy can be reused: no pin, or it matches the pin. */
export function cachedCopyMatches(target, buf, prev) {
  const expected = expectedSha256(target, prev);
  return !expected || sha256Hex(buf) === expected;
}
