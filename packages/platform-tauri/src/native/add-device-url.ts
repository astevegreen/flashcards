/**
 * The desktop shell's `flashcards://add-device?...` deep link source, kept free of Tauri imports so
 * it can be unit tested with fake plugin functions.
 */

/** Exact `flashcards://add-device` (any path and query), compared as plain text. */
export function isAddDeviceUrl(url: string): boolean {
  const prefix = 'flashcards://add-device';
  if (url.length < prefix.length || url.slice(0, prefix.length).toLowerCase() !== prefix) {
    return false;
  }
  const next = url.charAt(prefix.length);
  return next === '' || next === '/' || next === '?' || next === '#';
}

export interface DeepLinkPluginPort {
  getCurrent(): Promise<string[] | null>;
  onOpenUrl(handler: (urls: string[]) => void): Promise<() => void>;
}

/**
 * Delivers every add-device URL the OS opens the app with. The launch URLs (`getCurrent`) are
 * delivered once per process, so subscribing again never replays them.
 */
export function createAddDeviceUrlSourceFrom(
  plugin: DeepLinkPluginPort,
): (handler: (url: string) => void) => () => void {
  let launchDelivered = false;
  return (handler) => {
    let live = true;
    let unlisten: (() => void) | undefined;
    const deliver = (urls: readonly string[] | null | undefined) => {
      if (!live) return;
      for (const url of urls ?? []) if (isAddDeviceUrl(url)) handler(url);
    };
    if (!launchDelivered) {
      launchDelivered = true;
      void plugin
        .getCurrent()
        .then(deliver)
        .catch(() => undefined);
    }
    void plugin
      .onOpenUrl(deliver)
      .then((fn) => {
        if (live) unlisten = fn;
        else fn();
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unlisten?.();
    };
  };
}
