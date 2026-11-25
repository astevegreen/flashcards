/**
 * Runs `load` once and shares its promise. A rejected load is forgotten so the next call retries:
 * a failed chunk fetch (offline before precache, a replaced deploy) or a failed plugin init must
 * not stick for the whole session (C24).
 */
export function loadOnceUntilFailure<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () =>
    (pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    }));
}
