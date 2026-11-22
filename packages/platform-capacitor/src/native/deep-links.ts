/**
 * The app's `flashcards://` deep links (§11, §16). Registered natively:
 * Android intent filters in `apps/mobile/android/app/src/main/AndroidManifest.xml`, iOS
 * `CFBundleURLTypes` in `apps/mobile/ios/App/App/Info.plist`.
 *
 * - `flashcards://picker-callback` — Google Picker result from the system browser.
 * - `flashcards://oauth/microsoft` — OneDrive sign-in redirect (Custom Tabs on Android,
 *   ASWebAuthenticationSession on iOS). The sign-in plugin consumes it natively and checks `state`
 *   and the PKCE verifier itself.
 *
 * Both checks are plain string comparisons, never `new URL(...)`: Android System WebViews older than
 * Chromium 130 parse custom-scheme URLs non-standardly (`host` is empty and the authority ends up in
 * `pathname`), and Capacitor 8 still runs on those WebViews.
 */
export const APP_URL_SCHEME = 'flashcards';
export const PICKER_CALLBACK_HOST = 'picker-callback';
export const OAUTH_REDIRECT_HOST = 'oauth';

/** Characters that may follow `<scheme>://<host>`: the end of the authority. */
const AUTHORITY_END = new Set(['/', '?', '#']);

/**
 * True when `url` is `<scheme>://<host>` (any path and query), compared exactly rather than by
 * prefix, so `flashcards://picker-callback.evil` or `flashcards://oauth/microsoft` never pass as a
 * picker callback. Scheme and host compare case-insensitively.
 */
export function isAppDeepLink(url: string, scheme: string, host: string): boolean {
  const prefix = `${scheme}://${host}`.toLowerCase();
  if (url.length < prefix.length || url.slice(0, prefix.length).toLowerCase() !== prefix) {
    return false;
  }
  const next = url.charAt(prefix.length);
  return next === '' || AUTHORITY_END.has(next);
}

/** `flashcards://oauth/<provider>` and nothing else (no query, fragment or extra segments). */
const NATIVE_OAUTH_REDIRECT = /^flashcards:\/\/oauth\/[a-z0-9-]+$/;

/**
 * Checks a native OAuth redirect URI before it is handed to the sign-in plugin: it must be
 * `flashcards://oauth/<provider>` with no query or fragment, which is what the Android intent filter
 * and the iOS URL scheme deliver back to the app. Anything else would leave Custom Tabs stranded on
 * the provider's page.
 */
export function assertNativeOAuthRedirect(url: string): string {
  if (!NATIVE_OAUTH_REDIRECT.test(url)) {
    throw new Error(
      `Native OAuth redirect must look like ${APP_URL_SCHEME}://${OAUTH_REDIRECT_HOST}/<provider>; got "${url}".`,
    );
  }
  return url;
}
