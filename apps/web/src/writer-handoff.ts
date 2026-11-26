import { holdWriterLock, waitUpTo, type ReleaseLock, type WriterLocks } from './writer-lock.ts';

/**
 * Moving the writer lock between tabs (lazy: loaded only when a tab is asked to give it up, or
 * shows "open in another tab"). "Use here instead" asks the holder over a BroadcastChannel; the
 * holder stops writing, lets its started writes finish, then releases. A holder that doesn't
 * answer in time (frozen or crashed) has the lock stolen instead.
 */

/** The message a tab sends to ask the writer for the lock (the writer listens in `main.tsx`). */
export const TAKE = 'take';

/** Storage methods that only read. Every other method is a write and is blocked (fail closed). */
const READS = new Set([
  'constructor',
  'getAllEvents',
  'getDeviceEventsAfterSeq',
  'getEventsAfterLocalSeq',
  'getMaxLocalSeq',
  'getDeviceMeta',
  'getSyncCursor',
  'getSyncConfig',
  'getLocalSnapshot',
  'getKv',
  'getMedia',
  'listMediaHashes',
]);

export const BLOCKED_MESSAGE = 'Flashcards is open in another tab.';

/** Makes every storage method that isn't a known read reject from now on. */
export function blockWrites(storage: object): void {
  const target = storage as Record<string, unknown>;
  const names = new Set(Object.keys(storage));
  for (let p: object | null = storage; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const key of Object.getOwnPropertyNames(p)) names.add(key);
  }
  for (const key of names) {
    if (!READS.has(key) && typeof target[key] === 'function') {
      target[key] = () => Promise.reject(new Error(BLOCKED_MESSAGE));
    }
  }
}

/**
 * Resolves once every write transaction already created on the database has finished: a new
 * read-write transaction over all its stores can't start before them.
 */
export function writeBarrier(idb: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const open = idb.open(name);
    open.onerror = () => resolve();
    open.onsuccess = () => {
      const db = open.result;
      const done = () => {
        db.close();
        resolve();
      };
      const stores = Array.from(db.objectStoreNames);
      if (stores.length === 0) return done();
      const tx = db.transaction(stores, 'readwrite');
      tx.oncomplete = done;
      tx.onabort = done;
    };
  });
}

let yielded = false;

/**
 * Stops this tab writing: storage writes reject, and the hide, focus and online events that start a
 * sync no longer reach the app. Once started writes have landed it closes the database, releases
 * the lock (when asked rather than stolen) and reloads onto the "open in another tab" screen.
 */
export async function yieldWriter(
  storage: object,
  dbName: string,
  win: Window,
  release?: ReleaseLock,
): Promise<void> {
  if (yielded) return;
  yielded = true;
  const close = (storage as { close?: () => void }).close?.bind(storage);
  blockWrites(storage);
  for (const type of ['pagehide', 'visibilitychange', 'focus', 'online']) {
    win.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
  }
  // A write that was already past its storage call gets one turn to open its transaction.
  await new Promise((r) => setTimeout(r, 0));
  await writeBarrier(win.indexedDB, dbName);
  // Closing the database also stops a backup store handle opened before (same connection).
  close?.();
  release?.();
  win.location.reload();
}

/**
 * "Use here instead": asks the writer to hand over and waits for the lock; steals it when the
 * writer hasn't let go within `waitMs`.
 */
export async function takeOver(
  locks: WriterLocks,
  name: string,
  onLost: () => void,
  waitMs = 3000,
): Promise<ReleaseLock> {
  const channel = new BroadcastChannel(`${name}:writer`);
  channel.postMessage(TAKE);
  channel.close();
  const handed = await holdWriterLock(locks, name, waitUpTo(waitMs), onLost);
  return (
    handed ?? (await holdWriterLock(locks, name, { steal: true }, onLost)) ?? (() => undefined)
  );
}

/** For tests: lets one module instance yield more than once. */
export function resetYieldedForTests(): void {
  yielded = false;
}
