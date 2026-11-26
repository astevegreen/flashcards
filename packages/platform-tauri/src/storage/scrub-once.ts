import type { Storage } from '@flash/platform';

/** Set once the desktop database has been rebuilt with `secure_delete` on (N9). */
export const FREE_PAGES_SCRUBBED_KV_KEY = 'desktop_free_pages_scrubbed_v1';

/**
 * The desktop half of Capacitor's free-page scrub (N9). Builds before this one deleted rows (such
 * as a refresh token moved to the keychain) without `secure_delete`, so their bytes can still sit
 * in free pages. The first launch of a build whose SQLite has `secure_delete` on rebuilds the file
 * once (`VACUUM`); later deletions are zeroed by SQLite itself. Never throws: a failure is logged
 * and retried at the next launch.
 */
export async function scrubFreePagesOnce(options: {
  storage: Pick<Storage, 'getKv' | 'setKv'>;
  vacuum: () => Promise<void>;
  nowMs?: () => number;
}): Promise<void> {
  try {
    if (await options.storage.getKv(FREE_PAGES_SCRUBBED_KV_KEY)) return;
    await options.vacuum();
    await options.storage.setKv(FREE_PAGES_SCRUBBED_KV_KEY, {
      at: (options.nowMs ?? Date.now)(),
    });
  } catch (err) {
    console.warn('Could not scrub the desktop database free pages; retrying next launch:', err);
  }
}
