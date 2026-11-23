/**
 * Key/value secret storage for the Capacitor shell (§13, §16: "tokens only in Keychain/Keystore").
 *
 * - iOS: one Keychain generic-password item per key (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`,
 *   never synchronized to iCloud Keychain).
 * - Android: values encrypted with an AES-256-GCM key that never leaves `AndroidKeyStore`, stored as
 *   ciphertext in an app-private SharedPreferences file.
 * - Web: every secret method rejects with `UNAVAILABLE`. Nothing is ever written to browser storage.
 */
export interface FlashSecureStoragePlugin {
  /**
   * Reads a secret. `value` is `null` when the key has never been set (or could not be decrypted).
   * `lost` is `true` (Android) when a stored secret was dropped because the Keystore key was lost.
   * iOS never sets it (the Keychain cannot tell a vanished item from one never stored); the app
   * detects that case itself with plain markers in its database (`trackStoredSecrets`).
   */
  get(options: { key: string }): Promise<{ value: string | null; lost?: boolean }>;
  /**
   * Writes (or replaces) a secret. Resolves `{ lost: true }` (Android) when the Keystore key was
   * lost and the secrets it sealed were dropped first.
   */
  set(options: { key: string; value: string }): Promise<{ lost?: boolean } | undefined>;
  /** Deletes a secret. Deleting a missing key succeeds. */
  remove(options: { key: string }): Promise<void>;
  /**
   * Deletes a plaintext entry another plugin left in the app's own insecure storage (UserDefaults on
   * iOS, the named SharedPreferences file on Android), so a token copy can be cleared after it was
   * moved here. Never reads the value. A no-op on the web.
   *
   * The native side only accepts the token copies `@capgo/capacitor-social-login` 8.7.x writes
   * (Android: `CapgoOAuth2ProviderPrefs` / `OAuth2Tokens_*` and `GOOGLE_LOGIN_F13oz0I_SHARED_PERF` /
   * `GOOGLE_LOGIN_GOOGLE_DATA_*`; iOS: `CapgoOAuth2ProviderTokens_*`) and rejects anything else
   * with `INVALID_ARGUMENT`.
   */
  removeLegacyPreference(options: {
    key: string;
    /** Android only: the SharedPreferences file name. Required on Android. */
    androidPreferencesName?: string;
  }): Promise<void>;
}
