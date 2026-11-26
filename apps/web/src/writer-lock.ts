/**
 * One writer per browser profile. Two tabs writing at once would reuse `(device, seq)`, and each
 * keeps only its own events in memory, so a snapshot saved by one could drop the other's events.
 * The tab that holds a Web Lock named after its IndexedDB database writes; any other tab waits on
 * the "open in another tab" screen until the user takes it over (`writer-handoff.ts`, lazy). Only
 * this gate is in the initial chunk.
 */

export interface LockOptions {
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

/** The part of `navigator.locks` used here (a fake in unit tests). */
export interface WriterLocks {
  request(
    name: string,
    options: LockOptions,
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

/** Releases the held lock. */
export type ReleaseLock = () => void;

/** Waits up to `ms` for the lock; without `AbortSignal.timeout`, takes it only if free now. */
export function waitUpTo(ms: number): LockOptions {
  const signal = AbortSignal.timeout?.(ms);
  return signal ? { signal } : { ifAvailable: true };
}

/**
 * Asks for the writer lock and holds it until released or the page closes. Resolves with the
 * release function when held, or null when another tab still has it (a timed-out wait). `onLost`
 * runs if another tab steals it. A lock manager that fails any other way resolves with a no-op:
 * the tab writes as it did before locks.
 */
export function holdWriterLock(
  locks: WriterLocks,
  name: string,
  options: LockOptions,
  onLost: () => void,
): Promise<ReleaseLock | null> {
  return new Promise((resolve) => {
    let release: ReleaseLock | undefined;
    const onLock = (lock: unknown) => {
      if (lock === null) return resolve(null);
      return new Promise<void>((done) => {
        release = done;
        resolve(done);
      });
    };
    // A synchronous throw from `request` rejects this chain too, so both reach `.catch`.
    void Promise.resolve()
      .then(() => locks.request(name, options, onLock))
      .catch(() => {
        if (release) onLost();
        else resolve(options.signal?.aborted ? null : () => undefined);
      });
  });
}

/** `navigator.locks` when it can be used; otherwise the tab writes without a lock, as before. */
export function usableLocks(nav: Navigator): WriterLocks | undefined {
  const locks = (nav as { locks?: Partial<WriterLocks> }).locks;
  return typeof locks?.request === 'function' ? (locks as WriterLocks) : undefined;
}
