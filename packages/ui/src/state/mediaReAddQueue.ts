import type { KnownEvent, MediaEntry, MediaRefSource } from '@flash/core';

/** One batch of edits that started using files, with what was in use before it. */
export interface MediaReAddBatch {
  prior: MediaRefSource;
  events: readonly KnownEvent[];
}

export type PlanMediaReAdds = (batch: MediaReAddBatch) => Promise<MediaEntry[]>;

export interface MediaReAddQueue {
  add(batch: MediaReAddBatch): void;
  /** Plans and emits the queued re-adds. A failure keeps them queued for the next call. */
  flush(): Promise<void>;
}

/**
 * Batches of edits whose files still have to be added again (mediaReAdds.ts). When the lazy chunk
 * or the stored-file lookup fails, the batches stay queued and are retried on the next edit or
 * sync, rather than dropped. Kept tiny: it is on the initial bundle.
 */
export function createMediaReAddQueue(
  load: () => Promise<PlanMediaReAdds>,
  emit: (entries: MediaEntry[]) => void,
): MediaReAddQueue {
  let pending: MediaReAddBatch[] = [];
  return {
    add(batch) {
      pending.push(batch);
    },
    async flush() {
      if (pending.length === 0) return;
      const batches = pending;
      pending = [];
      try {
        const plan = await load();
        const byHash = new Map<string, MediaEntry>();
        for (const batch of batches) {
          // One after another: each reads stored files.
          for (const entry of await plan(batch)) byHash.set(entry.hash, entry); // NOSONAR (S9382)
        }
        if (byHash.size > 0) emit([...byHash.values()]);
      } catch {
        pending = [...batches, ...pending];
      }
    },
  };
}
