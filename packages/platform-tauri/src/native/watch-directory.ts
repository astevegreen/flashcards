/**
 * The desktop folder watcher, kept free of Tauri imports so it can be unit tested with a fake
 * `watch` from `@tauri-apps/plugin-fs`.
 */

/** The part of `@tauri-apps/plugin-fs`'s `watch` this module uses. */
export type WatchFn = (
  path: string,
  cb: (event: { paths: string[] }) => void,
  options: { recursive: boolean; delayMs: number },
) => Promise<() => void>;

/**
 * Watches `rootPath` recursively and reports the changed paths relative to it. A watch that fails
 * to start (a folder outside the fs scope, or one removed meanwhile) is logged rather than left as
 * an unhandled rejection (N8); the app still rescans when the window regains focus.
 */
export function watchDirectoryWith(
  watch: WatchFn,
  rootPath: string,
  onChange: (changedPaths: string[]) => void,
): () => void {
  let stopped = false;
  let unwatch: (() => void) | null = null;
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  watch(
    rootPath,
    (event) => {
      const changed = event.paths
        .map((p) => p.replace(/\\/g, '/'))
        .filter((p) => p.startsWith(`${root}/`))
        .map((p) => p.slice(root.length + 1));
      if (changed.length > 0) onChange(changed);
    },
    { recursive: true, delayMs: 500 },
  )
    .then((fn) => {
      if (stopped) fn();
      else unwatch = fn;
    })
    .catch((err: unknown) => {
      console.warn('Could not watch the linked folder for changes:', err);
    });
  return () => {
    stopped = true;
    unwatch?.();
  };
}
