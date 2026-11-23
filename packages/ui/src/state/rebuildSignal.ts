/**
 * Check database saves a rebuilt collection as the local snapshot, then reloads. Any tab still
 * running on the old in-memory collection (this one before it reloads, or another tab on the same
 * device) must not overwrite that snapshot with its own: it checks this kv stamp before writing
 * one, and other tabs are asked to reload over `rebuildChannel.ts`. Kept tiny: it is on the initial
 * bundle.
 */

export const COLLECTION_REBUILT_KV_KEY = 'collection_rebuilt_at_v1';

/** True when a rebuild was saved after `sinceMs` (this tab's start), so its snapshot must stay. */
export function rebuiltSince(rebuiltAt: unknown, sinceMs: number): boolean {
  return typeof rebuiltAt === 'number' && rebuiltAt >= sinceMs;
}

/**
 * Whether a tab that started at `sinceMs` may still write the local snapshot. Every snapshot write
 * from a running tab (local edits, sync) checks this first. Without a start time it allows.
 */
export async function snapshotWriteAllowed(
  storage: { getKv(key: string): Promise<unknown> },
  sinceMs: number | undefined,
): Promise<boolean> {
  if (sinceMs === undefined) return true;
  return !rebuiltSince(await storage.getKv(COLLECTION_REBUILT_KV_KEY), sinceMs);
}
