# Store Listing, Privacy Label, App Review Notes & Sunset Promise

Reference: [design_blueprint.md §11, §12, §15 Phase 8, §16](file:///c:/Antigravity/Korean/docs/design_blueprint.md)

---

## 1. Store Copy & Purchase Model (§12.1)

- **Title:** Flashcards — Local-First Language Study
- **Subtitle:** Offline FSRS flashcards for Japanese, Chinese, Korean & Hanja
- **Pricing Model:**
  - **Free Download (Starter Tier):** Up to 2 local decks, full offline study (`Flip`, `Typed`, `Choice`, `Cloze`, `Listen`, `Draw`), FSRS-6 scheduling, offline dictionaries & handwriting lookup, `.flashpkg` import/export.
  - **One-Time Unlock (`unlock_full` non-consumable IAP / Ed25519 desktop license key):** Unlimited decks, cross-device cloud sync (`Google Drive appDataFolder`, `Dropbox App Folder`, `OneDrive App Folder`, `iCloud Drive`, or local folder), Google Sheets/Docs live sync. Zero recurring subscriptions.
  - **Personal / Family Builds:** `VITE_ENABLE_LICENSE_GATE=false` (default in dev & personal builds) disables the license gate completely.

---

## 2. Privacy Label & Zero-Tracking Disclosure (§13)

- **Data Not Collected:** The developer operates zero backend databases, zero user accounts, and zero analytics or crash-telemetry SDKs.
- **User-Owned Storage Only:** Study history, decks, notes, media, and optional OAuth/API tokens stay strictly on the user's device and inside the user's own selected storage provider (`Google Drive appDataFolder`, `Dropbox App Folder`, `OneDrive App Folder`, `iCloud Drive`, or local folder).

---

## 3. App Store / Google Play Review Notes (§11)

- **Guideline 4.8 (Sign in with Apple):** Not applicable — the app has **no developer user accounts** or login wall. Google Drive, Dropbox and Microsoft OneDrive are optional user-initiated cloud storage connectors (the user can study 100% offline forever without connecting any cloud provider).
- **Google Picker on Native Shells:** Because Google Picker (`docs.google.com/picker`) is web-only, Capacitor Android/iOS and Tauri desktop shells open the static `/picker.html` page on the app's HTTPS domain in the system browser (`ASWebAuthenticationSession` / Custom Tabs) and return selected Drive `drive.file` file IDs via the `flashcards://picker-callback` deep link.
- **Native Handwriting:** On Capacitor mobile builds, `CapacitorMlKitInkRecognizer` delegates timestamped stroke data to on-device Google ML Kit Digital Ink Recognition with offline model caching.

---

## 4. Sunset Promise & EULA Clause (§12.2)

If active development or maintenance ever stops:

1. **Offline Forever:** Every installed copy continues functioning offline indefinitely. All FSRS scheduling, study modes, local storage (SQLite / IndexedDB), `.flashpkg` import/export, and local folder sync require zero developer servers.
2. **User-Owned Sync Continues:** Google Drive `appDataFolder`, Dropbox App Folder, OneDrive App Folder, iCloud Drive, and desktop folder sync operate directly between the user's device and the user's own cloud account. On Capacitor/Tauri native builds, Google and Microsoft OAuth refresh directly against Google's and Microsoft's OAuth servers with zero token-helper Worker dependency (OneDrive on the web/PWA does need the token-helper).
3. **Final Open & Unlocked Release:** The developer commits to publishing the complete source code and a final build with the `unlock_full` license gate removed.
4. **Open Documented Formats:** `.flashpkg`, `sync/v1/`, and event schema specifications remain documented in [`docs/formats/`](./formats/README.md).
