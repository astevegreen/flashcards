# Native shells: local build guide (Phase 8)

All three shells (PWA, Capacitor Android/iOS, Tauri desktop) ship the **identical**
`apps/web/dist` bundle. `apps/web/src/main.tsx` detects the runtime
(`window.Capacitor.isNativePlatform()` / `window.__TAURI_INTERNALS__`) and lazily imports
`apps/web/src/native-boot.ts`, which loads one of:

| Runtime   | Boot module                                    | Plugin adapters                                     |
| --------- | ---------------------------------------------- | --------------------------------------------------- |
| Capacitor | `@flash/platform-capacitor/native` (`boot.ts`) | `packages/platform-capacitor/src/native/plugins.ts` |
| Tauri     | `@flash/platform-tauri/native` (`boot.ts`)     | `packages/platform-tauri/src/native/plugins.ts`     |

Both build on `createWebPlatform()` through `composeNativePlatform()`
(`@flash/platform-web/native-support`). Native plugins replace storage, auth, files, the
picker bridge, handwriting and purchases. The browser services keep running inside the
WebView: Drive/Sheets REST clients (re-bound to the native token), packs, strokes,
dictionaries, media, TTS and the replay worker. The native code is split into separate lazy
chunks, so the PWA's initial study-screen JS stays the same size (`pnpm size`).

Build the web bundle first. Every native build copies it:

```powershell
pnpm install
pnpm --filter @flash/web build
```

Native-only settings are build-time `VITE_*` variables. They are listed in `.env.example`:
`VITE_PICKER_PAGE_URL`, `VITE_GOOGLE_IOS_CLIENT_ID`, `VITE_GOOGLE_DESKTOP_CLIENT_ID` and
`VITE_GOOGLE_DESKTOP_CLIENT_SECRET`.

## Android (Capacitor 8): Windows, macOS or Linux

Prerequisites: Android Studio (latest stable), which bundles JDK 21 and the Android SDK.
Set `ANDROID_HOME` (for example `%LOCALAPPDATA%\Android\Sdk`) and put the bundled JBR on
`JAVA_HOME` if you build from the command line.

```powershell
pnpm --filter @flash/mobile exec cap sync android
```

```powershell
pnpm --filter @flash/mobile exec cap open android
```

Alternatively, build from the command line with `apps/mobile/android/gradlew.bat assembleDebug`.

Android-specific wiring that is checked in:

- `android/app/src/main/AndroidManifest.xml` has a `VIEW` intent-filter for
  `flashcards://picker-callback`. `launchMode="singleTask"` delivers the callback to
  `App.addListener('appUrlOpen')`.
- A second `VIEW` intent-filter catches `flashcards://oauth` (the OneDrive redirect
  `flashcards://oauth/microsoft`). OneDrive sign-in runs in Chrome Custom Tabs, and
  `@capgo/capacitor-social-login` takes the redirect in `handleOnNewIntent`, checks `state` and
  redeems the code with its PKCE verifier. The picker's `appUrlOpen` listener matches scheme and
  host exactly, so it ignores this redirect. Both checks (`src/native/deep-links.ts`) are plain
  string comparisons, not `new URL(...)`: Android System WebViews older than Chromium 130 parse
  custom-scheme URLs differently (empty `host`).
- `launchCustomTabs` hands the sign-in page to whichever browser handles it (Custom Tabs when the
  browser supports them, a normal browser tab otherwise). Only when the phone has no browser at all
  (`ActivityNotFoundException`) does the plugin fall back to its own in-app WebView
  (`OAuth2Provider.java` lines 537–545 and 886–899 in 8.7.13). That fallback still checks `state`
  and PKCE, but the user types their Microsoft password into an embedded view, which RFC 8252
  advises against. We accept it because the alternative on such a phone is no OneDrive at all.
- `android:fullBackupContent` (`res/xml/backup_rules.xml`, Android 6–11) and
  `android:dataExtractionRules` (`res/xml/data_extraction_rules.xml`, Android 12+) keep three
  SharedPreferences files out of Auto Backup and device transfer: `CapgoOAuth2ProviderPrefs` and
  `GOOGLE_LOGIN_F13oz0I_SHARED_PERF` (the sign-in plugin's plaintext tokens, which exist briefly
  before the app deletes them, plus the PKCE verifier during a sign-in) and
  `app.flashcards.securestorage` (Keystore ciphertext, useless without this phone's key). Everything
  else, the flashcards database included, is still backed up. Keep the two files in sync.
- `MainActivity.java` implements `ModifiedMainActivityForSocialLoginPlugin`, which
  `@capgo/capacitor-social-login` requires before it lets you request the Drive scopes.
- Google Sign-In uses Credential Manager. Register the app's SHA-1 (debug and release) on an
  **Android** OAuth client in the same GCP project as `VITE_GOOGLE_CLIENT_ID`. The Web client
  ID is used as the server client ID.

## iOS (Capacitor 8): macOS only

`apps/mobile/ios/` is generated and checked in. Capacitor 8 uses Swift Package Manager, so
no CocoaPods step is needed. On a Mac with Xcode 26+:

```powershell
pnpm --filter @flash/mobile exec cap sync ios
```

```powershell
pnpm --filter @flash/mobile exec cap open ios
```

Before the first device build:

- Set your signing team in Xcode.
- Create an **iOS** OAuth client and build the web bundle with `VITE_GOOGLE_IOS_CLIENT_ID`.
- Add that client's reversed client ID as a second URL scheme in `ios/App/App/Info.plist`.
  `flashcards` is already registered for the picker callback.
- Add the In-App Purchase capability for StoreKit 2.
- For iCloud Drive sync, in the Apple Developer account enable **iCloud** for the
  `app.flashcards.localfirst` App ID and create the container `iCloud.app.flashcards.localfirst`.
  `ios/App/App/App.entitlements` already requests it (iCloud Documents), and Xcode's automatic
  signing picks it up once the App ID has it. Without it, "Use iCloud Drive" reports that iCloud
  Drive is off.

iCloud Drive sync is the app's own Swift plugin, `ios/App/App/ICloudDocumentsPlugin.swift`
(JS name `ICloudDocuments`), registered by `MainViewController.swift`, which `Main.storyboard`
uses in place of `CAPBridgeViewController`. It is not an npm package, so `cap sync` neither
adds nor removes it. Files live in the iCloud container outside `Documents/`, so they stay out
of the Files app:

- `listFiles` merges an `NSMetadataQuery` (sees files not downloaded to this device yet) with a
  local directory walk (sees files written moments ago, before iCloud indexes them).
- `readFile` starts the download when needed, waits up to 60 s, then reads under
  `NSFileCoordinator`.
- `writeFile` writes under `NSFileCoordinator`; `ifAbsent` is an exclusive create that fails
  with `ALREADY_EXISTS`. That check is per device: two devices creating the same file while
  offline both succeed, and iCloud keeps the later copy. Segments and snapshots have
  per-device paths and media files are named by content hash, so the one real race is two
  devices creating `manifest.json` for the first time while offline. Connect the first device
  and let it sync before connecting the second.

## Phone secure storage (Capacitor)

Sign-in secrets on Android and iOS live only in the Keychain or Keystore (§16 compliance
checklist). The store is the workspace plugin `packages/capacitor-secure-storage`
(`@flash/capacitor-secure-storage`, JS name `FlashSecureStorage`), a dependency of
`apps/mobile`, so `cap sync` wires it into Gradle and `CapApp-SPM` like any npm plugin:

- **iOS:** one generic-password Keychain item per key, service `<bundle id>.secure-storage`,
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronized to iCloud Keychain.
- **Android:** AES-256-GCM with a key generated in `AndroidKeyStore`
  (`app.flashcards.securestorage.aes.v1`). Only ciphertext goes to the app-private SharedPreferences
  file `app.flashcards.securestorage` (excluded from backups). A value that cannot be decrypted is
  deleted, and the user signs in again. If the Keystore key itself becomes unusable (some devices
  invalidate keys after an OS update: `UnrecoverableKeyException` or `InvalidKeyException`), the
  plugin deletes the key and every stored value, `get` returns `null`, and the next `set` creates a
  new key, so signing in again always works.
- **Web:** the plugin rejects every call. There is no insecure fallback.

What is kept there (`packages/platform-capacitor/src/secure/`):

| Secret                                        | Before                                           | Now                                                |
| --------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| OneDrive refresh token                        | Sign-in plugin: UserDefaults / SharedPreferences | Secure store, key `microsoft_refresh_token_v1`     |
| OneDrive access token + scopes (session)      | SQLite KV `onedrive_native_session_v1`           | Secure store, key `kv.onedrive_native_session_v1`  |
| Google access token (session)                 | SQLite KV `capacitor_google_session_v1`          | Secure store, key `kv.capacitor_google_session_v1` |
| Bring-your-own cloud TTS API key (TTS config) | SQLite KV `tts_config_v1`                        | Secure store, key `kv.tts_config_v1`               |

`createSecureKvRouting` wraps the SQLite `Storage`, so the auth classes keep calling
`getKv` / `setKv` and never notice. "Reset Local Device Data" (`clearAll`) deletes the secrets too.
Decrypted values are cached in memory for the session, so a token read costs one Keychain or
Keystore call per launch. A unit test checks that `SECURE_KV_KEYS` uses the adapters' own key
constants and that signing in to Google and OneDrive writes no KV row to SQLite, so renaming a key
cannot quietly send a secret back to SQLite.

What `@capgo/capacitor-social-login` 8.7.13 persists by itself, and what the app does about it:

- **Microsoft (generic `oauth2` provider).** After every login or refresh it writes access, refresh
  and ID tokens in plaintext: Android `OAuth2Provider.java` `persistTokens()` (line 1446, called
  from `completeLogin()` at line 1371) into SharedPreferences `CapgoOAuth2ProviderPrefs`, key
  `OAuth2Tokens_<providerId>` (lines 39–40); iOS `OAuth2Provider.swift` `persistTokens()` (line 752,
  called from `completeLogin()` at line 689) into `UserDefaults.standard`, key
  `CapgoOAuth2ProviderTokens_<providerId>` (line 75). There is no option to turn this off. So the
  app copies the refresh token to the secure store right after sign-in and calls
  `SocialLogin.logout` (no `logoutUrl` is configured, so it only deletes the stored tokens).
  Refreshes skip the plugin and post to the token endpoint with `CapacitorHttp`. During a Custom
  Tabs sign-in the plugin also keeps `state` and the PKCE verifier in the same file until the
  redirect arrives (lines 902–929). That is a one-time, unredeemed value, not a token.
- **Google on Android.** `GoogleProvider.java` `persistState()` (line 622, called from
  `resolveOnlineLogin()` at line 295) writes the ID token and access token (no refresh token) to
  SharedPreferences `GOOGLE_LOGIN_F13oz0I_SHARED_PERF` (lines 68–69). The app deletes that entry
  after every sign-in (`afterLogin` in `createGoogleSignIn`, `src/auth/google-social-login.ts`;
  the hook comes from `googleSignInCleanup`) and at launch, through
  `FlashSecureStorage.removeLegacyPreference`. That native method only deletes the plugin's own
  token entries (Android: `CapgoOAuth2ProviderPrefs` / `OAuth2Tokens_*` and
  `GOOGLE_LOGIN_F13oz0I_SHARED_PERF` / `GOOGLE_LOGIN_GOOGLE_DATA_*`; iOS:
  `CapgoOAuth2ProviderTokens_*`) and rejects any other file or key. Nothing reads it back: a token refresh is a silent
  sign-in through Credential Manager, and the long-lived credential stays with Google Play
  services. Calling `SocialLogin.logout` instead would clear Credential Manager state and break
  silent sign-in.
- **Google on iOS.** `GoogleProvider.swift` does not touch UserDefaults. The GoogleSignIn SDK
  keeps its session, including the refresh token, in the Keychain. The plugin returns that refresh
  token to JavaScript (`createOnlineLoginResponse()`, line 234), but the app ignores it.

At launch (`native/boot.ts`):

1. On a fresh database (first launch after install) the app deletes leftover secrets, because iOS
   keeps Keychain items when an app is deleted. Otherwise it moves any secret KV row an older build
   left in SQLite into the secure store and deletes the row. This sweep runs once per database (the
   plain SQLite flag `secure_kv_migrated_v1`); a row that turns up later, for example after a
   downgrade, is moved the first time it is read.
2. In the background it deletes the Google copy on Android. If OneDrive is connected, it starts the
   OneDrive bridge, which moves a refresh token still held by the plugin into the secure store
   (the secure copy wins if both exist) and then deletes the plugin's copy. If OneDrive is not
   connected, it deletes the plugin's Microsoft copy directly. A failed delete is logged and never
   blocks OneDrive; the next launch tries again.

The key names of the plugin's plaintext entries are internal to version 8.7.x. Check them again
when upgrading `@capgo/capacitor-social-login` (`SOCIAL_LOGIN_GOOGLE_ANDROID_COPY` and
`socialLoginOAuth2Copy` in `src/secure/secure-store.ts`). The Microsoft migration itself uses only
the plugin's public API.

## Desktop (Tauri 2): Windows, macOS or Linux

Prerequisites:

- Rust stable (`rustup`, 1.85 or later).
- Windows: Visual Studio Build Tools with the "Desktop development with C++" workload, and
  WebView2 (preinstalled on Windows 11).
- macOS: Xcode Command Line Tools.
- Linux: the WebKitGTK 4.1 development packages listed in the Tauri prerequisites guide.

```powershell
pnpm --filter @flash/desktop build
```

This runs `tauri build`: it builds `apps/web` (`beforeBuildCommand`), compiles
`apps/desktop/src-tauri` in release mode and writes installers to
`apps/desktop/src-tauri/target/release/bundle/` (MSI and NSIS on Windows). For a quicker
unbundled debug binary, run `pnpm --filter @flash/desktop build:debug`. For hot reload
against the Vite dev server, run `pnpm --filter @flash/desktop dev`.

The root `pnpm build` skips `@flash/desktop` so that CI does not need Rust.

Rust plugins registered in `src-tauri/src/lib.rs`, with their permissions in
`src-tauri/capabilities/default.json`:

| Plugin                                       | Used for                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `tauri-plugin-sql` (sqlite)                  | `TauriSqliteStorage` (`sqlite:flashcards.db` in the app config dir)    |
| `tauri-plugin-fs` (`watch`)                  | `TauriFsBridge`: linked folders, `Inbox/` watcher, local-folder sync   |
| `tauri-plugin-persisted-scope`               | Keeps user-picked folders in the fs scope across restarts              |
| `tauri-plugin-dialog`                        | Folder, file-open and save dialogs                                     |
| `tauri-plugin-deep-link` + `single-instance` | `flashcards://picker-callback` from the system browser                 |
| `tauri-plugin-opener`                        | Opens the Google consent page and `picker.html` in the system browser  |
| `tauri-plugin-oauth`                         | Loopback `127.0.0.1` redirect server for Google OAuth (PKCE, RFC 8252) |
| `tauri-plugin-http`                          | Token exchange from Rust (avoids WebView CORS)                         |
| `keyring` crate (app commands)               | `secure_store_*` commands in `src/secure_store.rs`: OS keychain        |

Google OAuth on desktop needs a **Desktop app** client
(`VITE_GOOGLE_DESKTOP_CLIENT_ID` / `_SECRET`).

The Google refresh token is kept in the OS keychain (Windows Credential Manager, macOS
Keychain, Linux Secret Service) under service `app.flashcards.localfirst`, account
`google-refresh-token`. The Rust commands only accept that account name. On first start after
the upgrade, a token left in the old `oauth_refresh_tokens` SQLite table is moved to the
keychain and the table is dropped. When no keychain is available (Linux without GNOME Keyring,
KWallet or another Secret Service), the token stays in SQLite and Settings shows a warning that
it is not in a secure store. Linux builds need the D-Bus development package (`libdbus-1-dev`).
`cargo test -- --ignored` in `src-tauri` round-trips a value through the real keychain.

## Interfaces still waiting on a native plugin

| Interface               | Status                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MlKitDigitalInkPlugin` | **Wired** to `@capacitor-mlkit/digital-ink-recognition` (Capawesome). `zh-Hans`/`zh-Hant` map to ML Kit `zh-Hani-CN`/`zh-Hani-TW`. The web stroke matcher is the fallback.  |
| `StoreBillingPlugin`    | **Wired** to `@capgo/native-purchases` (StoreKit 2 / Play Billing 7, non-consumable `INAPP`).                                                                               |
| `ICloudDocumentPlugin`  | **Wired** to the local Swift plugin `ios/App/App/ICloudDocumentsPlugin.swift` (iOS only; see the iOS section).                                                              |
| Desktop refresh token   | **Done.** Kept in the OS keychain (see the Desktop section).                                                                                                                |
| Phone sign-in tokens    | **Done.** Kept in the Keychain / Keystore by `@flash/capacitor-secure-storage` (see Phone secure storage). Gradle and Xcode builds not yet run; not yet tested on a device. |
