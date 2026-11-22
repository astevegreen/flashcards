/**
 * Phone secret storage (§13, §16 compliance checklist: "tokens only in Keychain/Keystore (native)").
 * Backed by the workspace plugin `@flash/capacitor-secure-storage` (iOS Keychain, Android Keystore);
 * tests inject an in-memory fake.
 */
export interface SecureStore {
  /** `null` when the key is not set. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** A plaintext entry another plugin keeps in the app's insecure native storage. */
export interface LegacyPreferenceEntry {
  key: string;
  /** Android SharedPreferences file name. iOS entries live in `UserDefaults.standard`. */
  androidPreferencesName?: string;
}

/** The native secure store plus the one-way clean-up of other plugins' plaintext token copies. */
export interface NativeSecureStorage extends SecureStore {
  removeLegacyPreference(entry: LegacyPreferenceEntry): Promise<void>;
}

export type MobilePlatform = 'android' | 'ios';

/** Keychain/Keystore key of the OneDrive (Microsoft) refresh token. */
export const MICROSOFT_REFRESH_TOKEN_KEY = 'microsoft_refresh_token_v1';

/**
 * App database (`Storage.getKv`) entries that hold secrets. On Capacitor they are kept in the
 * secure store instead of SQLite (`createSecureKvRouting`):
 * - `capacitor_google_session_v1`: Google access token (`CapacitorGoogleAuth`).
 * - `onedrive_native_session_v1`: OneDrive access token and scopes (`NativeMicrosoftAuth`).
 * - `tts_config_v1`: the bring-your-own cloud TTS API key (`useAudioController`).
 */
export const SECURE_KV_KEYS: readonly string[] = [
  'capacitor_google_session_v1',
  'onedrive_native_session_v1',
  'tts_config_v1',
];

/** The OneDrive session record; present while OneDrive is connected (or needs reconnecting). */
export const ONEDRIVE_SESSION_KV_KEY = 'onedrive_native_session_v1';

/** OAuth2 provider ID of OneDrive inside `@capgo/capacitor-social-login`. */
export const MICROSOFT_SOCIAL_LOGIN_PROVIDER_ID = 'microsoft';

/**
 * Where `@capgo/capacitor-social-login` 8.7.x writes plaintext OAuth2 tokens for a provider ID:
 * Android `OAuth2Provider.java` (`PREFS_NAME`, `PREFS_KEY_PREFIX`, `persistTokens`), iOS
 * `OAuth2Provider.swift` (`tokenStorageKeyPrefix`, `persistTokens` into `UserDefaults.standard`).
 */
export function socialLoginOAuth2Copy(
  platform: MobilePlatform,
  providerId: string,
): LegacyPreferenceEntry {
  return platform === 'android'
    ? { androidPreferencesName: 'CapgoOAuth2ProviderPrefs', key: `OAuth2Tokens_${providerId}` }
    : { key: `CapgoOAuth2ProviderTokens_${providerId}` };
}

/**
 * Where `@capgo/capacitor-social-login` 8.7.x writes the Google ID token and access token on Android
 * (`GoogleProvider.java`: `SHARED_PREFERENCE_NAME`, `GOOGLE_DATA_PREFERENCE`, `persistState`). iOS
 * leaves the Google session to the GoogleSignIn SDK, which keeps it in the Keychain.
 */
export const SOCIAL_LOGIN_GOOGLE_ANDROID_COPY: LegacyPreferenceEntry = {
  androidPreferencesName: 'GOOGLE_LOGIN_F13oz0I_SHARED_PERF',
  key: 'GOOGLE_LOGIN_GOOGLE_DATA_9158025e-947d-4211-ba51-40451630cc47',
};
