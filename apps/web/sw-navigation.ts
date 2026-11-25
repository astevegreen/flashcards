/**
 * Navigations the PWA service worker must not answer with the cached `index.html` (N3). Custom
 * Tabs share Chrome's service worker, so without this, once the PWA has been opened,
 * `picker.html#access_token=…` (the Google Drive Picker bridge) loads the app instead of the
 * Picker. Static `.txt` notices and pack files must also reach the network. Workbox tests each
 * pattern against `pathname + search`.
 */
export const NAVIGATE_FALLBACK_DENYLIST: RegExp[] = [
  /^\/picker(?:\.html)?(?:[/?]|$)/,
  /\.txt(?:\?|$)/,
  /^\/packs\//,
];
