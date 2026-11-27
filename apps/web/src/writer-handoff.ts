import {
  holdWriterLock,
  type ReleaseLock,
  type TakeOverRequest,
  type WriterLocks,
  type WriterMessage,
} from './writer-lock.ts';

/**
 * Moving the writer lock between tabs (lazy: loaded when a tab is asked to give it up, or shows
 * "open in another tab"). "Use here instead" asks the writer over a BroadcastChannel; the writer
 * saves its queued writes, stops writing, lets started writes land, then releases, and the asking
 * tab's waiting lock request gets the lock. A writer that stops answering (frozen or crashed) has
 * the lock stolen instead.
 */

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

/** How often the asking tab repeats its request (the writer answers as often, `holdWriter`). */
const PING_MS = 500;

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

/** Storages already handed over (one handoff per page). */
const yielded = new WeakSet<object>();

/**
 * Hands the lock over (the asking tab already hears "yielding", from `holdWriter`). The hide,
 * focus and online events that start a sync stop reaching the app. The app's queued writes (a
 * rating already shown, the rest of an import) are saved first; then every storage write rejects,
 * started writes land, the database closes (which also stops a backup store opened earlier), the
 * lock is released and the tab reloads onto the "open in another tab" screen.
 */
export async function yieldWriter(
  storage: object,
  dbName: string,
  win: Window,
  release: ReleaseLock,
  whenSaved?: () => Promise<void>,
): Promise<void> {
  if (yielded.has(storage)) return;
  yielded.add(storage);
  for (const type of ['pagehide', 'visibilitychange', 'focus', 'online']) {
    win.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
  }
  // A write that failed stays failed; the rest are saved.
  await whenSaved?.().catch(() => undefined);
  const close = (storage as { close?: () => void }).close?.bind(storage);
  blockWrites(storage);
  // A write that was already past its storage call gets one turn to open its transaction.
  await new Promise((r) => setTimeout(r, 0));
  await writeBarrier(win.indexedDB, dbName);
  close?.();
  release();
  win.location.reload();
}

/** Waits `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * "Use here instead": asks the writer to hand over, repeating the request until this tab's waiting
 * lock request wins (`won` aborts). While the writer answers "yielding" it keeps waiting, up to
 * `maxMs`; a round of `roundMs` without an answer steals the lock (after cancelling the waiting
 * request, `queued`). Resolves with the stolen lock, or null when the handoff won.
 */
export async function takeOver(
  locks: WriterLocks,
  name: string,
  { self, onLost, won, queued, roundMs = 3000, maxMs = 120_000 }: TakeOverRequest,
): Promise<ReleaseLock | null> {
  const channel = new BroadcastChannel(`${name}:writer`);
  let answers = 0;
  channel.onmessage = (e: MessageEvent<WriterMessage>) => {
    if ((e.data as { yielding?: boolean } | null)?.yielding) answers++;
  };
  const take: WriterMessage = { take: self };
  const ask = () => channel.postMessage(take);
  ask();
  const asking = setInterval(ask, PING_MS);
  try {
    for (let waited = 0; waited < maxMs; waited += roundMs) {
      const before = answers;
      await pause(roundMs, won.signal);
      if (won.signal.aborted) return null;
      if (answers === before) break;
    }
    queued.abort();
    return await holdWriterLock(locks, name, { steal: true }, onLost);
  } finally {
    clearInterval(asking);
    channel.close();
  }
}
