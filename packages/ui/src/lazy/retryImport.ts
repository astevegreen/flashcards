/**
 * Retry a dynamic `import()` that failed, e.g. because the device went offline before the service
 * worker finished precaching that chunk. Pure (no React) so hooks, handlers and `lazyWithRetry`
 * share it.
 */

/** Default waits between attempts: two retries after the first try. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [300, 1200];

export interface RetryImportOptions {
  /** One wait per retry; the loader runs `delaysMs.length + 1` times at most. */
  delaysMs?: readonly number[];
  /** Waits before a retry. Defaults to `waitForRetry` (a timer cut short by the `online` event). */
  wait?: (ms: number) => Promise<void>;
}

/** Runs `loader`, retrying after each wait in `delaysMs`; rethrows the last error. */
export async function retryImport<T>(
  loader: () => Promise<T>,
  options: RetryImportOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const wait = options.wait ?? waitForRetry;
  for (let attempt = 0; ; attempt++) {
    try {
      // Retries must run one after another, never in parallel.
      return await loader(); // NOSONAR (S9382)
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined) throw error;
      await wait(delay); // NOSONAR (S9382)
    }
  }
}

/** Resolves after `ms`, or as soon as the browser reports it is back `online`. */
export function waitForRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const target = typeof window === 'undefined' ? undefined : window;
    const done = () => {
      clearTimeout(timer);
      target?.removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    target?.addEventListener('online', done);
  });
}

/** Whether an error looks like a chunk that could not be fetched (rather than a code bug). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Unable to preload|Failed to fetch|Loading (CSS )?chunk/i.test(
    message,
  );
}
