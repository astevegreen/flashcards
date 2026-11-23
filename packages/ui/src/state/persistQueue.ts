/**
 * Storage writes run one after another; `whenSaved` resolves once everything queued so far (and
 * anything queued while waiting) has settled. A failed write is logged, never thrown to the next.
 */
export interface PersistQueue {
  enqueue(task: () => Promise<void>): Promise<void>;
  whenSaved(): Promise<void>;
}

export function createPersistQueue(): PersistQueue {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    enqueue(task) {
      // The executor runs task() at once, and a synchronous throw becomes a rejection.
      const invoke = (): Promise<void> => new Promise<void>((resolve) => resolve(task()));
      const started = pending === 0 ? invoke() : chain.then(invoke, invoke);
      pending += 1;
      const next = started
        .catch((err) => {
          console.error('Failed to persist to storage:', err);
        })
        .finally(() => {
          pending -= 1;
        });
      chain = next;
      return next;
    },
    async whenSaved() {
      while (pending > 0) {
        // A write queued while waiting extends the chain: wait for that one too.
        await chain; // NOSONAR (S9382)
      }
    },
  };
}
