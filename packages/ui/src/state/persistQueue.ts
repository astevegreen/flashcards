/**
 * Storage writes run one after another; `whenSaved` resolves once everything queued so far (and
 * anything queued while waiting) has settled. A failed write never blocks the next one: it is kept,
 * reported through `onFailed` (the app shows a "not saved" alert), and run again by `retryFailed`.
 * Every queued write is idempotent (events are keyed by id), so running one again is safe.
 */
export interface PersistQueue {
  enqueue(task: () => Promise<void>): Promise<void>;
  /** Resolves once queued writes settled; rejects while any of them is still unsaved. */
  whenSaved(): Promise<void>;
  /** Runs the failed writes again, in their original order; rejects if any fails again. */
  retryFailed(): Promise<void>;
  /** Forgets the failed writes (a reset replaced what they would save). */
  discardFailed(): void;
}

export function createPersistQueue(onFailed?: (err: unknown) => void): PersistQueue {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let failed: Array<() => Promise<void>> = [];

  function enqueue(task: () => Promise<void>): Promise<void> {
    // The executor runs task() at once, and a synchronous throw becomes a rejection.
    const invoke = (): Promise<void> => new Promise<void>((resolve) => resolve(task()));
    const started = pending === 0 ? invoke() : chain.then(invoke, invoke);
    pending += 1;
    const next = started
      .catch((err) => {
        console.error('Failed to persist to storage:', err);
        failed.push(task);
        onFailed?.(err);
      })
      .finally(() => {
        pending -= 1;
      });
    chain = next;
    return next;
  }

  async function whenSaved(): Promise<void> {
    while (pending > 0) {
      // A write queued while waiting extends the chain: wait for that one too.
      await chain; // NOSONAR (S9382)
    }
    if (failed.length > 0) throw new Error(`${failed.length} change(s) could not be saved.`);
  }

  return {
    enqueue,
    whenSaved,
    retryFailed() {
      const tasks = failed;
      failed = [];
      for (const task of tasks) void enqueue(task);
      return whenSaved();
    },
    discardFailed() {
      failed = [];
    },
  };
}
