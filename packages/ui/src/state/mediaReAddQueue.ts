import type { KnownEvent, MediaEntry, MediaRefSource } from '@flash/core';

/** One batch of edits that started using files, with what was in use before it. */
export interface MediaReAddBatch {
  prior: MediaRefSource;
  events: readonly KnownEvent[];
}

export type PlanMediaReAdds = (batch: MediaReAddBatch) => Promise<MediaEntry[]>;

export interface MediaReAddQueue {
  add(batch: MediaReAddBatch): void;
  /**
   * Plans and emits the queued re-adds, after any flush still running; resolves when done. A batch
   * that fails is kept for the next call, up to {@link MEDIA_RE_ADD_TRIES} tries.
   */
  flush(): Promise<void>;
}

/** Tries per batch; after that, Check media's "Add back to the collection" covers its files. */
export const MEDIA_RE_ADD_TRIES = 3;

/**
 * Batches of edits whose files still have to be added again (mediaReAdds.ts). When the lazy chunk
 * or a batch's stored-file lookup fails, that batch stays queued and is retried on the next edit
 * or sync, a few times at most. Kept tiny: it is on the initial bundle.
 */
export function createMediaReAddQueue(
  load: () => Promise<PlanMediaReAdds>,
  emit: (entries: MediaEntry[]) => void,
): MediaReAddQueue {
  let pending: { batch: MediaReAddBatch; tries: number }[] = [];
  let running = Promise.resolve();
  const retryLater = (items: typeof pending): void => {
    for (const item of items) {
      if (item.tries + 1 < MEDIA_RE_ADD_TRIES) pending.push({ ...item, tries: item.tries + 1 });
    }
  };
  const run = async (): Promise<void> => {
    if (pending.length === 0) return;
    const items = pending;
    pending = [];
    let plan: PlanMediaReAdds;
    try {
      plan = await load();
    } catch {
      retryLater(items);
      return;
    }
    const byHash = new Map<string, MediaEntry>();
    for (const item of items) {
      try {
        // One after another: each reads stored files.
        for (const entry of await plan(item.batch)) byHash.set(entry.hash, entry); // NOSONAR (S9382)
      } catch {
        retryLater([item]);
      }
    }
    if (byHash.size > 0) emit([...byHash.values()]);
  };
  return {
    add(batch) {
      pending.push({ batch, tries: 0 });
    },
    flush() {
      running = running.then(run).catch(() => undefined);
      return running;
    },
  };
}
