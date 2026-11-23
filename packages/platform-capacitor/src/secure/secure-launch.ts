/**
 * Launch-time secure-storage housekeeping for the Capacitor shell (§13, §16). Pure and injectable;
 * `native/boot.ts` passes the real plugins.
 */
import type { Storage } from '@flash/platform';
import type { SecureKvRouting } from './secure-kv-storage.ts';
import {
  MICROSOFT_SOCIAL_LOGIN_PROVIDER_ID,
  ONEDRIVE_SESSION_KV_KEY,
  SOCIAL_LOGIN_GOOGLE_ANDROID_COPY,
  socialLoginOAuth2Copy,
  type MobilePlatform,
  type NativeSecureStorage,
} from './secure-store.ts';

/**
 * Runs before the app reads any session. On a fresh database (first launch after install), deletes
 * secrets left by an earlier install: iOS keeps Keychain items when an app is deleted. Otherwise
 * moves secret KV rows an older build wrote to SQLite into the secure store.
 *
 * Failures are logged, not thrown, so the app still starts; the routed `getKv` retries the move on
 * first read.
 */
export async function prepareSecureStorageAtLaunch(options: {
  /** The unwrapped SQLite storage. */
  database: Storage;
  routing: SecureKvRouting;
}): Promise<void> {
  try {
    if ((await options.database.getDeviceMeta()) === undefined) {
      await options.routing.removeSecrets();
    } else {
      await options.routing.migrateLegacyRows();
    }
  } catch (err) {
    console.warn('Secure storage setup failed at launch; it is retried on first use:', err);
  }
}

/**
 * Deletes the plaintext token copies `@capgo/capacitor-social-login` keeps (or an older build left)
 * in UserDefaults / SharedPreferences:
 * - Google on Android: the ID and access tokens. Nothing reads them back (refresh is a silent
 *   sign-in through Credential Manager), so they are simply deleted.
 * - Microsoft: when OneDrive is connected, `loadOneDrive` creates the sign-in bridge, which moves
 *   the refresh token into the secure store before deleting the copy. When it is not connected the
 *   copy is useless and is deleted directly, without starting the sign-in plugin.
 */
export async function clearPluginTokenCopiesAtLaunch(options: {
  platform: MobilePlatform;
  secureStorage: NativeSecureStorage;
  /** The routed app storage (reads the OneDrive session from the secure store). */
  storage: Storage;
  /** Creates the OneDrive bridge; omitted when this build has no Microsoft client ID. */
  loadOneDrive?: () => Promise<unknown>;
}): Promise<void> {
  const { platform, secureStorage } = options;
  if (platform === 'android') {
    await secureStorage.removeLegacyPreference(SOCIAL_LOGIN_GOOGLE_ANDROID_COPY);
  }
  const connected = (await options.storage.getKv(ONEDRIVE_SESSION_KV_KEY)) !== undefined;
  if (connected && options.loadOneDrive) {
    await options.loadOneDrive();
    return;
  }
  await secureStorage.removeLegacyPreference(
    socialLoginOAuth2Copy(platform, MICROSOFT_SOCIAL_LOGIN_PROVIDER_ID),
  );
}

/**
 * The `afterLogin` hook for native Google sign-in: on Android it deletes the ID and access tokens
 * the sign-in plugin has just saved in plaintext SharedPreferences. iOS needs none (the GoogleSignIn
 * SDK keeps its session in the Keychain).
 */
export function googleSignInCleanup(
  platform: MobilePlatform,
  secureStorage: NativeSecureStorage,
): (() => Promise<void>) | undefined {
  if (platform !== 'android') return undefined;
  return () => secureStorage.removeLegacyPreference(SOCIAL_LOGIN_GOOGLE_ANDROID_COPY);
}
