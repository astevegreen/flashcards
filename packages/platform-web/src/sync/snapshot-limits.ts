/**
 * Snapshot caps for a phone or tablet browser: the codec's 25 MiB raw cap, as on Capacitor
 * (`CAPACITOR_SYNC_SNAPSHOT_LIMITS`). A mobile browser tab has no more memory than the app's
 * WebView, and the OS kills the tab outright when it runs out, before the engine's error handling
 * runs; past the cap the device replays segments instead, which is slower but cannot crash.
 * Written out rather than imported: importing `SYNC_CODEC_LIMITS` here would pull the sync codec
 * into the boot chunk (§8). A test keeps the two equal.
 */
export const MOBILE_WEB_SYNC_SNAPSHOT_LIMITS = {
  maxUncompressedBytes: 25 * 1024 * 1024,
} as const;

/** The navigator fields {@link isMobileBrowser} reads. */
export interface MobileHints {
  userAgent?: string;
  maxTouchPoints?: number;
  platform?: string;
  userAgentData?: { mobile?: boolean };
}

/**
 * True on a phone or tablet browser: when the client hint says `mobile` (Chromium), when the user
 * agent names a phone or tablet, or on iPadOS, which reports itself as a Mac but has touch points.
 * A hint of `mobile: false` does not override the user agent: any one sign of a mobile device is
 * enough, since the lower cap is the safe side.
 */
export function isMobileBrowser(hints: MobileHints | undefined): boolean {
  if (!hints) return false;
  if (hints.userAgentData?.mobile === true) return true;
  const ua = hints.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(ua)) return true;
  return /Mac/.test(hints.platform || ua) && (hints.maxTouchPoints ?? 0) > 1;
}

/** The snapshot caps for this browser, or `undefined` for the engine's defaults (desktop). */
export function webSyncSnapshotLimits(
  hints: MobileHints | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as MobileHints),
): typeof MOBILE_WEB_SYNC_SNAPSHOT_LIMITS | undefined {
  return isMobileBrowser(hints) ? MOBILE_WEB_SYNC_SNAPSHOT_LIMITS : undefined;
}
