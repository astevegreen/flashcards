export const SWIPE_GUIDE_DISMISSED_KEY = 'flash.swipeGuideDismissed';

/**
 * Whether the one-time touch swipe tutorial hint was dismissed on this device.
 * Device-local preference kept in `localStorage` (never synced as an event).
 */
export function readSwipeGuideDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SWIPE_GUIDE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function storeSwipeGuideDismissed(dismissed: boolean): void {
  try {
    if (dismissed) globalThis.localStorage?.setItem(SWIPE_GUIDE_DISMISSED_KEY, '1');
    else globalThis.localStorage?.removeItem(SWIPE_GUIDE_DISMISSED_KEY);
  } catch {
    // Storage blocked (private mode): dismissal lasts for this session.
  }
}

/** True when the current device reports a coarse/touch pointer. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  } catch {
    // Ignore unsupported matchMedia in minimal environments.
  }
  return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
}

export function shouldShowSwipeGuide(): boolean {
  return isTouchDevice() && !readSwipeGuideDismissed();
}
