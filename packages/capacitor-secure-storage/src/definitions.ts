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
  /** Reads a secret. `value` is `null` when the key has never been set (or could not be decrypted). */
  get(options: { key: string }): Promise<{ value: string | null }>;
  /** Writes (or replaces) a secret. */
  set(options: { key: string; value: string }): Promise<void>;
  /** Deletes a secret. Deleting a missing key succeeds. */
  remove(options: { key: string }): Promise<void>;
  /**
   * Deletes a plaintext entry another plugin left in the app's own insecure storage (UserDefaults on
   * iOS, the named SharedPreferences file on Android), so a token copy can be cleared after it was
   * moved here. Never reads the value. A no-op on the web.
   */
  removeLegacyPreference(options: {
    key: string;
    /** Android only: the SharedPreferences file name. Required on Android. */
    androidPreferencesName?: string;
  }): Promise<void>;
}
