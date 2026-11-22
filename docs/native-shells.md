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

| Interface               | Status                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MlKitDigitalInkPlugin` | **Wired** to `@capacitor-mlkit/digital-ink-recognition` (Capawesome). `zh-Hans`/`zh-Hant` map to ML Kit `zh-Hani-CN`/`zh-Hani-TW`. The web stroke matcher is the fallback. |
| `StoreBillingPlugin`    | **Wired** to `@capgo/native-purchases` (StoreKit 2 / Play Billing 7, non-consumable `INAPP`).                                                                              |
| `ICloudDocumentPlugin`  | **Wired** to the local Swift plugin `ios/App/App/ICloudDocumentsPlugin.swift` (iOS only; see the iOS section).                                                             |
| Desktop refresh token   | **Done.** Kept in the OS keychain (see the Desktop section).                                                                                                               |
