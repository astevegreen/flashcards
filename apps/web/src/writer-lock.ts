/**
 * One writer per browser profile. Two tabs writing at once would reuse `(device, seq)`, and each
 * keeps only its own events in memory, so a snapshot saved by one could drop the other's events.
 * The tab that holds a Web Lock named after its IndexedDB database writes; any other tab waits on
 * the "open in another tab" screen until the user takes the lock over (`steal`).
 */

/** The part of `navigator.locks` used here (a fake in unit tests). */
export interface WriterLocks {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

/**
 * Asks for the writer lock and holds it while the page lives. Resolves true when held, false when
 * another tab still has it after `waitMs` (a reload can briefly race its own old page's release;
 * a steal always gets it). `onLost` runs if another tab steals it later. A lock manager that fails
 * any other way resolves true: the tab writes as it did before locks.
 */
export function holdWriterLock(
  locks: WriterLocks,
  name: string,
  steal: boolean,
  onLost: () => void,
  waitMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    let held = false;
    const signal = steal ? undefined : AbortSignal.timeout?.(waitMs);
    locks
      .request(name, steal ? { steal } : signal ? { signal } : { ifAvailable: true }, (lock) => {
        held = lock !== null;
        resolve(held);
        // A promise that never settles keeps the lock until the page closes.
        return held && new Promise(() => undefined);
      })
      .catch(() => (held ? onLost() : resolve(signal?.aborted !== true)));
  });
}

/**
 * Stops a tab that lost the lock from writing at once: every write method of its storage now
 * rejects, and the hide events that flush a sync push no longer reach the app. Then reload, so
 * the tab boots again on the "open in another tab" screen.
 */
export function stopWriting(storage: object, win: Window): void {
  const target = storage as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(storage))) {
    if (/^(append|set|put|delete|clear|open)/.test(key)) {
      target[key] = () => Promise.reject(new Error('Flashcards is open in another tab.'));
    }
  }
  for (const type of ['pagehide', 'visibilitychange', 'focus']) {
    win.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
  }
  win.location.reload();
}
