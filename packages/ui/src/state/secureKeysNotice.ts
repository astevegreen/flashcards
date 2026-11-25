/**
 * Plain app-database flag the Capacitor shell sets when the stored sign-in secrets were lost: the
 * Android Keystore key was lost (the secrets it sealed are dropped), or iOS Keychain items that
 * were stored are gone (e.g. after a backup was restored onto another device). Holds no secret. The app explains it once
 * (a banner) and deletes it. Same value as `SECURE_KEYS_LOST_KV_KEY` in
 * `@flash/platform-capacitor` (a unit test checks the two constants match).
 */
export const SECURE_KEYS_LOST_KV_KEY = 'secure_keys_lost_v1';
