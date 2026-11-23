export const TAGS_GUIDE_DISMISSED_KEY = 'flash.tagsGuideDismissed';

/**
 * Whether the "How tags work" panel was dismissed on this device. A device-local help
 * preference (like the card text size): kept in `localStorage`, never synced as an event.
 */
export function readTagsGuideDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(TAGS_GUIDE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function storeTagsGuideDismissed(dismissed: boolean): void {
  try {
    if (dismissed) globalThis.localStorage?.setItem(TAGS_GUIDE_DISMISSED_KEY, '1');
    else globalThis.localStorage?.removeItem(TAGS_GUIDE_DISMISSED_KEY);
  } catch {
    // Storage blocked (private mode): the panel just closes for this session.
  }
}
