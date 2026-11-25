/**
 * Waiting for the system browser to come back: a loopback OAuth redirect or the
 * `flashcards://picker-callback` deep link (N6).
 *
 * The listener is registered before the browser opens, so a fast redirect can't be missed. The
 * wait ends after a timeout, or when a new attempt of the same kind starts. Either way the caller's
 * `finally` runs, so a loopback server (Dropbox binds fixed ports) is released.
 */

/** How long a sign-in waits for the browser's redirect. */
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
/** How long the Drive picker waits: choosing files can take longer than signing in. */
export const PICKER_CALLBACK_TIMEOUT_MS = 15 * 60_000;

export class BrowserCallbackError extends Error {
  constructor(
    readonly reason: 'timeout' | 'superseded',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserCallbackError';
  }
}

export interface AwaitBrowserCallbackOptions {
  /** Registers `onUrl` and resolves with its unsubscribe function once the listener is live. */
  subscribe: (onUrl: (url: string) => void) => Promise<() => void>;
  /** Opens the browser. Runs only after `subscribe` has resolved. */
  open: () => Promise<void>;
  /** Which URLs answer this wait (default: the first one). */
  accept?: (url: string) => boolean;
  timeoutMs: number;
  /** Aborted when a newer attempt replaces this one. */
  signal?: AbortSignal;
  /** What the user is waiting for, e.g. "Dropbox sign-in". */
  label: string;
}

export async function awaitBrowserCallback(options: AwaitBrowserCallbackOptions): Promise<string> {
  const superseded = () =>
    new BrowserCallbackError('superseded', `${options.label} was replaced by a new attempt.`);
  if (options.signal?.aborted) throw superseded();

  let settle: { resolve: (url: string) => void; reject: (err: Error) => void } | undefined;
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A timeout or abort while `open` is still running rejects before anyone awaits `result`.
  result.catch(() => undefined);
  const unsubscribe = await options.subscribe((url) => {
    if (!options.accept || options.accept(url)) settle?.resolve(url);
  });
  const onAbort = () => settle?.reject(superseded());
  options.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    settle?.reject(
      new BrowserCallbackError(
        'timeout',
        `${options.label} timed out: the browser didn't come back. Try again.`,
      ),
    );
  }, options.timeoutMs);
  try {
    if (options.signal?.aborted) throw superseded();
    await options.open();
    return await result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}

/**
 * Runs one attempt at a time: starting a new one aborts the one still waiting, and the new one
 * starts only after the old one has cleaned up (so a fixed loopback port is free again).
 */
export function createLatestAttempt(): <T>(
  attempt: (signal: AbortSignal) => Promise<T>,
) => Promise<T> {
  let previous: Promise<unknown> = Promise.resolve();
  let abortPrevious = () => {};
  return (attempt) => {
    abortPrevious();
    const controller = new AbortController();
    abortPrevious = () => controller.abort();
    const run = previous.then(() => attempt(controller.signal));
    previous = run.catch(() => undefined);
    return run;
  };
}
