import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionState } from '@flash/core';
import { SYNC_V1_PREFIX } from '@flash/core/sync';

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function fileStamp(path: string): string {
  const st = statSync(path);
  return `${st.size}:${st.mtimeMs}`;
}

/** `name=size:mtime` for every matching file in `dir` (sorted), or nothing when `dir` is absent. */
function dirStamps(dir: string, matches: (name: string) => boolean): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter(matches)
    .sort(compareCodeUnits)
    .map((name) => `${name}=${fileStamp(join(dir, name))}`);
}

/**
 * Cheap change detector for a mirror: sizes and modification times of the files the loader reads
 * (a `.flashpkg`, or a `sync/v1` folder's snapshots and device segments). Stat calls only, no reads.
 */
export function mirrorFingerprint(mirrorPath: string): string {
  if (!existsSync(mirrorPath)) return 'missing';
  const st = statSync(mirrorPath);
  if (st.isFile()) return `file=${st.size}:${st.mtimeMs}`;
  const syncRoot = existsSync(join(mirrorPath, SYNC_V1_PREFIX, 'devices'))
    ? join(mirrorPath, SYNC_V1_PREFIX)
    : mirrorPath;
  const parts = dirStamps(join(syncRoot, 'snapshots'), (f) => f.endsWith('.json.gz'));
  const devicesDir = join(syncRoot, 'devices');
  if (existsSync(devicesDir) && statSync(devicesDir).isDirectory()) {
    for (const device of readdirSync(devicesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(compareCodeUnits)) {
      const segments = dirStamps(join(devicesDir, device), (f) => /^seg-\d+\.jsonl\.gz$/i.test(f));
      parts.push(`${device}/`, ...segments);
    }
  }
  return parts.join('|');
}

export interface MirrorStateCache {
  /** The collection, reloaded only when the mirror's files changed since the last call. */
  get(): CollectionState;
  /** How many times the mirror was (re)loaded. */
  readonly loadCount: number;
}

/**
 * Keeps the loaded mirror between MCP calls and reloads it when the sync app (or a file copy)
 * changes it, so tools always answer from the current mirror without re-reading it every call.
 */
export function createMirrorStateCache(
  mirrorPath: string,
  load: (path: string) => CollectionState,
): MirrorStateCache {
  let fingerprint: string | null = null;
  let state: CollectionState | null = null;
  let loadCount = 0;
  return {
    get() {
      const current = mirrorFingerprint(mirrorPath);
      if (state === null || current !== fingerprint) {
        state = load(mirrorPath);
        fingerprint = current;
        loadCount += 1;
      }
      return state;
    },
    get loadCount() {
      return loadCount;
    },
  };
}
