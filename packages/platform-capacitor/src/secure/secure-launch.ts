/**
 * Launch-time secure-storage housekeeping for the Capacitor shell (§13, §16). Pure and injectable;
 * `native/boot.ts` passes the real plugins.
 */
import type { Storage } from '@flash/platform';
import type { SecureKvRouting } from './secure-kv-storage.ts';
import {
  DROPBOX_SESSION_KV_KEY,
  DROPBOX_SOCIAL_LOGIN_PROVIDER_ID,
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
 * moves secret KV rows an older build wrote to SQLite into the secure store, and the one time that
 * sweep runs, scrubs the database's free pages so the deleted rows' bytes are gone too.
 *
 * Failures are logged, not thrown, so the app still starts; the routed `getKv` retries the move on
 * first read.
 */
export async function prepareSecureStorageAtLaunch(options: {
  /** The unwrapped SQLite storage. */
  database: Storage;
  routing: SecureKvRouting;
  /** Rebuilds the database file (`VACUUM`); called once, after the first migration sweep. */
  scrubFreePages?: () => Promise<void>;
}): Promise<void> {
  try {
    if ((await options.database.getDeviceMeta()) === undefined) {
      await options.routing.removeSecrets();
    } else if (await options.routing.migrateLegacyRows()) {
      await options.scrubFreePages?.();
    }
  } catch (err) {
    console.warn('Secure storage setup failed at launch; it is retried on first use:', err);
  }
}

/**
 * iOS: reads every secret the routing owns once at launch, through the loss-tracking store, so a
 * secret that is present gets its marker now (`trackStoredSecrets` writes a missing one on read).
 * Without it, a secret an older build stored and this build never read before the next backup had
 * no marker, and its loss after a restore went unexplained. A secret whose marker outlived it is
 * reported here, which is where its first read would have reported it anyway. Run after
 * `prepareSecureStorageAtLaunch` (a fresh install's wipe has cleared the leftovers by then, and a
 * fresh database has no markers, so that stays silent). Android needs none: its plugin reports a
 * lost key itself. Never throws; a failing read is skipped.
 */
export async function markStoredSecretsAtLaunch(options: {
  platform: MobilePlatform;
  /** The loss-tracking store (`withSecretLossDetection`). */
  secureStorage: Pick<NativeSecureStorage, 'get'>;
  /** Secure-store key names (`SecureKvRouting.secretKeys`). */
  keys: readonly string[];
}): Promise<void> {
  if (options.platform !== 'ios') return;
  for (const key of options.keys) {
    try {
      // Keychain reads go one at a time on purpose, so launch never fires a burst of them.
      await options.secureStorage.get(key); // NOSONAR (S9382)
    } catch {
      // Best effort: the next read of this key tries again.
    }
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
  /** The routed app storage (reads the OneDrive/Dropbox sessions from the secure store). */
  storage: Storage;
  /** Creates the OneDrive bridge; omitted when this build has no Microsoft client ID. */
  loadOneDrive?: () => Promise<unknown>;
  /** Creates the Dropbox bridge; omitted when this build has no Dropbox app key. */
  loadDropbox?: () => Promise<unknown>;
}): Promise<void> {
  const { platform, secureStorage } = options;
  if (platform === 'android') {
    await secureStorage.removeLegacyPreference(SOCIAL_LOGIN_GOOGLE_ANDROID_COPY);
  }
  const oneDriveConnected = (await options.storage.getKv(ONEDRIVE_SESSION_KV_KEY)) !== undefined;
  if (oneDriveConnected && options.loadOneDrive) {
    await options.loadOneDrive();
  } else {
    await secureStorage.removeLegacyPreference(
      socialLoginOAuth2Copy(platform, MICROSOFT_SOCIAL_LOGIN_PROVIDER_ID),
    );
  }
  const dropboxConnected = (await options.storage.getKv(DROPBOX_SESSION_KV_KEY)) !== undefined;
  if (dropboxConnected && options.loadDropbox) {
    await options.loadDropbox();
  } else {
    await secureStorage.removeLegacyPreference(
      socialLoginOAuth2Copy(platform, DROPBOX_SOCIAL_LOGIN_PROVIDER_ID),
    );
  }
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
