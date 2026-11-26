/** The Worker events a one-shot request listens to besides `onmessage` (C25). */
export interface WatchedWorker {
  onerror: ((ev: ErrorEvent) => void) | null;
  /** Optional so test fakes can leave it out; real Workers always have it. */
  onmessageerror?: ((ev: MessageEvent) => void) | null;
}

export interface WorkerWatch {
  /** Restarts the idle clock (call on every message from the Worker). */
  touch(): void;
  /** Stops the clock and detaches the error handlers. */
  stop(): void;
}

/**
 * Makes a one-shot Worker request always settle (C25): a Worker that fails to load, sends a
 * message the page cannot deserialize, or goes silent for `idleTimeoutMs` (a crashed or killed
 * Worker fires nothing) calls `fail` once with a readable error.
 */
export function watchWorker(
  worker: WatchedWorker,
  what: string,
  idleTimeoutMs: number,
  fail: (err: Error) => void,
): WorkerWatch {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    worker.onerror = null;
    worker.onmessageerror = null;
  };
  const touch = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      stop();
      fail(new Error(`The ${what} worker stopped responding`));
    }, idleTimeoutMs);
  };
  worker.onerror = (ev) => {
    stop();
    fail(new Error(ev.message || `The ${what} worker failed to load`));
  };
  worker.onmessageerror = () => {
    stop();
    fail(new Error(`A message from the ${what} worker could not be read`));
  };
  touch();
  return { touch, stop };
}
