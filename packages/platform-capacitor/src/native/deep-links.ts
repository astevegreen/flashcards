/**
 * The app's `flashcards://` deep links (§11, §16). Registered natively:
 * Android intent filters in `apps/mobile/android/app/src/main/AndroidManifest.xml`, iOS
 * `CFBundleURLTypes` in `apps/mobile/ios/App/App/Info.plist`.
 *
 * - `flashcards://picker-callback` — Google Picker result from the system browser.
 * - `flashcards://oauth/microsoft` — OneDrive sign-in redirect (Custom Tabs on Android,
 *   ASWebAuthenticationSession on iOS). The sign-in plugin consumes it natively and checks `state`
 *   and the PKCE verifier itself.
 */
export const APP_URL_SCHEME = 'flashcards';
export const PICKER_CALLBACK_HOST = 'picker-callback';
export const OAUTH_REDIRECT_HOST = 'oauth';

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * True when `url` is `<scheme>://<host>` (any path and query), compared exactly rather than by
 * prefix, so `flashcards://picker-callback.evil` or `flashcards://oauth/microsoft` never pass as a
 * picker callback.
 */
export function isAppDeepLink(url: string, scheme: string, host: string): boolean {
  const parsed = parse(url);
  return (
    parsed !== null &&
    parsed.protocol === `${scheme.toLowerCase()}:` &&
    parsed.host.toLowerCase() === host.toLowerCase()
  );
}

/**
 * Checks a native OAuth redirect URI before it is handed to the sign-in plugin: it must be
 * `flashcards://oauth/<provider>` with no query or fragment, which is what the Android intent filter
 * and the iOS URL scheme deliver back to the app. Anything else would leave Custom Tabs stranded on
 * the provider's page.
 */
export function assertNativeOAuthRedirect(url: string): string {
  const parsed = parse(url);
  const valid =
    parsed !== null &&
    isAppDeepLink(url, APP_URL_SCHEME, OAUTH_REDIRECT_HOST) &&
    /^\/[a-z0-9-]+$/.test(parsed.pathname) &&
    parsed.search === '' &&
    parsed.hash === '';
  if (!valid) {
    throw new Error(
      `Native OAuth redirect must look like ${APP_URL_SCHEME}://${OAUTH_REDIRECT_HOST}/<provider>; got "${url}".`,
    );
  }
  return url;
}
