/**
 * One writer per browser profile. Two tabs writing at once would reuse `(device, seq)`, and each
 * keeps only its own events in memory, so a snapshot saved by one could drop the other's events.
 * The tab that holds a Web Lock named after its IndexedDB database writes; any other tab waits on
 * the "open in another tab" screen. It takes over by itself when the lock frees, or when the user
 * asks the writer to hand over (`writer-handoff.ts`, lazy). What stops a writer that loses the lock
 * is here, in the initial chunk, so it works even when a lazy chunk can't load (an older tab after
 * a deploy).
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

/** The channel messages: a tab asking for the lock, and the writer saying it is handing over. */
export type WriterMessage = { take: string } | { yielding: true };

/** Waits up to `ms` for the lock; without `AbortSignal.timeout`, takes it only if free now. */
export function waitUpTo(ms: number): LockOptions {
  const signal = AbortSignal.timeout?.(ms);
  return signal ? { signal } : { ifAvailable: true };
}

/**
 * Asks for the writer lock and holds it until released or the page closes. Resolves with the
 * release function when held, or null when another tab still has it (or the wait was aborted).
 * `onLost` runs if another tab steals it. A lock manager that fails any other way resolves with a
 * no-op: the tab writes as it did before locks.
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

/** The lazy chunk's part (`writer-handoff.ts`, re-exported by `other-tab.tsx`). */
export interface HandoffModule {
  yieldWriter(
    storage: object,
    dbName: string,
    win: Window,
    release: ReleaseLock,
    whenSaved?: () => Promise<void>,
  ): Promise<void>;
  takeOver(locks: WriterLocks, name: string, ask: TakeOverRequest): Promise<ReleaseLock | null>;
}

/** What `takeOver` needs besides the lock: who asks, and how its waiting request is doing. */
export interface TakeOverRequest {
  /** This tab's id, sent with its requests (a tab ignores its own). */
  self: string;
  onLost: () => void;
  /** Aborted once this tab's waiting lock request has won. */
  won: AbortController;
  /** Cancels that waiting request before a steal. */
  queued: AbortController;
  /** A round without a "yielding" answer ends in a steal (default 3 s). */
  roundMs?: number;
  /** The longest wait while the writer keeps answering (default 120 s). */
  maxMs?: number;
}

export interface WriterSetup {
  locks: WriterLocks;
  name: string;
  storage: { close?: () => void };
  win: Window;
  load: () => Promise<HandoffModule>;
  /** Shows "open in another tab"; `onUse` is its "Use here instead". */
  showWaiting: (onUse: () => void) => void;
  /** Resolves once the app's queued writes are saved. */
  whenSaved: () => Promise<void>;
}

/**
 * Resolves once this tab holds the writer lock, showing the waiting screen meanwhile, then keeps
 * listening for another tab asking for it. Losing the lock (stolen, or a handoff whose chunk
 * failed to load) closes the database at once, so nothing more is written, and reloads.
 */
export async function holdWriter(s: WriterSetup): Promise<void> {
  const self = String(Math.random());
  let held: ReleaseLock | null = null;
  const stop = (release?: ReleaseLock) => {
    s.storage.close?.();
    release?.();
    s.win.location.reload();
  };
  const onLost = () => stop();
  // Listening before the lock is held: a tab still waiting ignores requests, and the asking tab
  // repeats its request until it gets the lock, so a writer that just took over still hears it.
  new BroadcastChannel(`${s.name}:writer`).onmessage = (e: MessageEvent<WriterMessage>) => {
    const release = held;
    const take = (e.data as { take?: string } | null)?.take;
    if (!release || !take || take === self) return;
    held = null;
    s.load()
      .then((m) => m.yieldWriter(s.storage, s.name, s.win, release, s.whenSaved))
      .catch(() => stop(release));
  };
  held = await holdWriterLock(s.locks, s.name, waitUpTo(500), onLost);
  if (held) return;
  const won = new AbortController();
  const queued = new AbortController();
  held = await new Promise<ReleaseLock>((resolve) => {
    const take = (release: ReleaseLock | null) => {
      if (!release || won.signal.aborted) return;
      won.abort();
      resolve(release);
    };
    // Takes over by itself when the writer closes (a normal request, never a steal).
    void holdWriterLock(s.locks, s.name, { signal: queued.signal }, onLost).then(take);
    s.showWaiting(() => {
      s.load()
        .then((m) => m.takeOver(s.locks, s.name, { self, onLost, won, queued }))
        .then(take, onLost);
    });
  });
}
