import { syncReadCap, SyncReadTooLargeError } from '@flash/core';
import { readBodyCapped } from '../net/read-capped.ts';

// The caps live in `@flash/core` (`sync/read-caps.ts`), derived from the limits the engine reads
// under, so every transport (web, Capacitor, Tauri) shares them and they can't drift.
export {
  SYNC_READ_CAPS,
  syncFileKind,
  SyncReadTooLargeError,
  type SyncFileKind,
} from '@flash/core';

/**
 * Reads a sync file's download body under its kind's cap. Over the cap it throws
 * {@link SyncReadTooLargeError} naming the file and its size, never a truncated body.
 */
export function readSyncBodyCapped(
  res: Response,
  path: string,
  label: string,
): Promise<Uint8Array> {
  const { kind, maxBytes } = syncReadCap(path);
  return readBodyCapped(res, maxBytes, {
    tooLarge: (declared) => new SyncReadTooLargeError(label, path, kind, maxBytes, declared),
  });
}
