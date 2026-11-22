# @flash/capacitor-secure-storage

A small workspace Capacitor plugin (JS name `FlashSecureStorage`) that keeps sign-in tokens out of
UserDefaults, SharedPreferences, SQLite and browser storage. `apps/mobile` depends on it, so
`cap sync` adds it to the Android Gradle settings and the iOS `CapApp-SPM` package.

| Platform | Where a value lives                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS      | One Keychain generic-password item per key: service `<bundle id>.secure-storage`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronized to iCloud Keychain.                              |
| Android  | AES-256-GCM ciphertext in the app-private SharedPreferences file `app.flashcards.securestorage`. The key (`app.flashcards.securestorage.aes.v1`) is generated in `AndroidKeyStore` and never leaves it. |
| Web      | `get` / `set` / `remove` reject with `UNAVAILABLE`. There is no insecure fallback.                                                                                                                      |

API (`src/definitions.ts`):

- `get({ key })` → `{ value: string | null }`
- `set({ key, value })`
- `remove({ key })`
- `removeLegacyPreference({ key, androidPreferencesName? })` deletes a plaintext copy another plugin
  left in `UserDefaults.standard` (iOS) or a named SharedPreferences file (Android). It never reads
  the value.

On Android, a value that can no longer be decrypted (for example SharedPreferences restored by Auto
Backup onto a new device, where the Keystore key does not exist) is deleted and read as `null`, so
the user signs in again.

The app code that uses it is in `packages/platform-capacitor/src/secure/`.
