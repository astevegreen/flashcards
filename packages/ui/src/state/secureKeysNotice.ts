/**
 * Plain app-database flag the Capacitor shell sets when the Android Keystore / iOS Keychain key was
 * lost and the stored sign-in secrets were dropped. Holds no secret. The app explains it once
 * (a banner) and deletes it. Same value as `SECURE_KEYS_LOST_KV_KEY` in
 * `@flash/platform-capacitor` (a unit test checks the two constants match).
 */
export const SECURE_KEYS_LOST_KV_KEY = 'secure_keys_lost_v1';

export const SECURE_KEYS_LOST_MESSAGE =
  'This device lost the secure key that protected your sign-ins (this can happen after a system update or a restore). Your cards are safe. Please sign in again to resume syncing.';
