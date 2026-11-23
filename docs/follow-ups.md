# Follow-ups

Open items left after the Phase 14 batch (Streams A–D, 2026-11-22). Tick an item off, or delete it, once it is resolved. Product decisions belong to the owner. Until one is made, the shipped default is the least-committal, reversible option described here.

## Phase 14 batch: what landed (2026-11-22)

- [x] **Secure-store bridge for phone tokens (release blocker): code complete, not yet built natively.** `@flash/capacitor-secure-storage` (`packages/capacitor-secure-storage`): iOS Keychain (after first unlock, this device only, no iCloud sync) and an Android Keystore AES-GCM key over app-private SharedPreferences. The Microsoft refresh token, the Google and OneDrive session access tokens and the BYO TTS config live only there. Older copies are migrated at launch. Phone OneDrive refreshes go through CapacitorHttp, because the capgo plugin writes refreshed tokens back to plaintext storage. Google on Android had the same problem: the plugin writes the ID and access token, but no refresh token, to plaintext SharedPreferences, and the app now deletes that copy. Google on iOS uses the SDK's Keychain. Evidence with file and line: `docs/native-shells.md` "Phone secure storage".
- [x] **Android Microsoft redirect:** Custom Tabs (`androidUseCustomTabs`) plus a `flashcards://oauth` intent filter. The plugin checks state and PKCE natively. Android Auto Backup now excludes the token SharedPreferences files.
- [x] **"Sync my devices":** one button in Settings, on the empty screen and in the one-time prompt. iCloud is the default where an iCloud transport exists (iOS only today); Google Drive is the default elsewhere. The other providers are listed below it.
- [x] **Add-device QR code and link (web build):** they carry the provider code and the manifest `collection_id` only. The receiving device parses them against an allow-list, strips them from the URL, and never shows onboarding while it joins a collection. Native shells show text instructions only (see the decisions below).
- [x] **Guided "Bring my cards" import** in the Library. Detection reads the content, not the extension: Flashcards Deluxe/plain CSV and TSV, Anki `.apkg` (anki2/anki21/anki21b), `.flashpkg`, and Google Sheets links. It routes to the existing importers. Non-UTF-8 CSV and `.xls` files get a "Save as CSV UTF-8" hint.
- [x] **Curated starter decks (partial):** "Korean Starter: Beginner Words" (145 notes: the NIKL 2003 level-A list under KOGL Type 1, with English meanings from Wikidata lexemes under CC0) and "Mandarin Basics: Common Characters" (150 characters from Unihan 17.0.0 under the Unicode License v3). Both are built by `scripts/build-starter-decks.mjs`, load lazily, and are attributed on every card and in `THIRD-PARTY-NOTICES.txt`. Japanese and English keep their sample decks (see the decisions below).
- [x] **Cloudflare Pages `_headers`** is committed in `apps/web/public`. `apps/web/tests/headers.test.ts` keeps it in sync with `PRODUCTION_CSP` and with §6 of the setup guide.
- [x] **Anki `kana:` / `kanji:` fields** store readings only or bases only, like Anki. A field used with mixed filters keeps ruby.
- [x] **Anki field languages:** the detected language of each field is shown in the import summary, where it can be changed.
- [x] **Anki suspended state** (`queue = -1`) imports as `CardSuspended` (reason `manual`), unless the card already has suspend history in the app. Buried cards import as normal.
- [x] **Anki media:** every image and sound reference in a field is kept, up to 20 of each, with a warning when more are dropped.
- [x] **Onboarding:** Korean is listed first (English first on a Korean-locale device), with nothing preselected. Onboarding appears only on empty collections; existing users with no sync get the one-time "Sync my devices" prompt. Empty screen: "I already use this app: sync my devices" and "Bring my cards"; "Load Sample Decks" is removed. Reset Local Device Data clears `onboarding_v1`.
- [ ] `docs/onboarding-review.md`: it now holds a **developer-measured baseline** (Chromium Playwright on Windows: 2 taps; about 0.3 s on desktop and 1.1 s on a phone viewport) and templates for the real audit. The **tester audit on real devices** with non-technical testers is still to do, and it is the store-launch gate.

## Owner decisions from the Phase 14 batch (defaults shipped)

### Starter decks

- [ ] **Japanese starter deck: blocked by licences.** JMdict/EDICT and KANJIDIC2 are CC BY-SA 4.0. The tanos JLPT lists are unclear (the site is gone, and the glosses likely come from EDICT). Unihan kJapanese readings are under licence from CITPC. Options: (a) accept CC BY-SA JMdict for a separately licensed deck; (b) a Unihan-only kanji deck (kJoyoKanji + kJapaneseOn/Kun + kDefinition, all Unicode License v3; weaker, with no frequency field and Chinese-oriented glosses); (c) keep the sample decks (the current default).
- [ ] **Mandarin is common characters, not HSK 1.** Official HSK lists have no open licence, and HSK compilations embed CC-CEDICT glosses (CC BY-SA). Accept character cards, or allow HSK words under CC BY-SA?
- [ ] **Korean is NIKL level A (beginner), not an official TOPIK I list**, which has no open licence.
- [ ] **Deck size:** about 150 notes (`STARTER_DECK_SIZE` in `scripts/build-starter-decks.mjs`). The Korean deck has 145, because only that many level-A words had an unambiguous CC0 gloss.
- [ ] **Gloss quality:** the Wikidata glosses are never hand-edited, and some are vague or encyclopedic (개 "domestic animal"). Unihan's `kDefinition` is terse. Spot-check them.
- [ ] **Korean homographs** (그, 이, 일, 팔) have the same front and differ only on the back. Showing part of speech or hanja on the front would change the `vocab-ko` template.
- [ ] **Attribution placement:** a one-line credit is in every card's Notes field. Onboarding doesn't show the deck description or credits yet; `OnboardingDeckInfo` carries both. Consider listing the sources in Settings > About & Open Data Licenses too.
- [ ] **Any English starter deck?** No open source has been evaluated yet.

### Sync and add-device

- [ ] **Native add-device QR code and link.** Native shells (Capacitor, Tauri) show text instructions only, because their origins can't be shared and no app link exists. Options: a public app URL with Android App Links and iOS associated domains (blocked on the §16 domain decision), or a `flashcards://add-device` deep link.
- [ ] **macOS has no iCloud transport**, so the macOS desktop app defaults to Google Drive. Build one?
- [ ] **Duplicate Google Drive entry in Settings:** "Sync my devices (uses Google Drive)" sits above the existing "Connect Google Drive" button.
- [ ] **A collection mismatch only warns, with a Dismiss button.** The engine has already adopted the other collection.
- [ ] **A device with cards opened from an add-device link** is sent to Settings once per page load.

### Import

- [ ] **Bring my cards imports a detected `.apkg` right away**, with review history off (the owner default). To include history, tick the box and pick the file again. Show a pre-import summary with an Import button instead?
- [ ] **`kana:` / `kanji:` filters are applied at import time**, so the dropped text can't be recovered in the app. A reversible alternative is to keep ruby and add a per-layout "readings only" / "bases only" render flag.
- [ ] **Flashcards Deluxe / generic CSV mapping:** Bring my cards imports into a new deck with `preset:vocab-ko`, mapping columns by position. Add a Front/Back preset or a column-mapping step?
- [ ] **Imported suspensions use reason `manual`.** A separate `imported` reason would need an event schema change.
- [ ] **A pasted Google Sheets link** returns 404 under `drive.file` when the app was never granted that file; the UI then suggests the Picker. Acceptable?

### Phone secure storage

- [ ] The BYO cloud TTS key (`tts_config_v1`) also moved to Keychain/Keystore, beyond the spec. On a fresh install the app wipes leftover Keychain items, because iOS keeps them across reinstalls. If the Keystore key is lost, every stored secret is dropped and the user signs in again, with no message.
- [ ] The plugin's WebView fallback, used only when no browser at all can open the sign-in page, is kept.
- [ ] The SQLite database is still included in Android backups; only the token files are excluded.

## Not verified on real devices or services

Only Chromium Playwright with faked endpoints has covered these.

- [ ] **First Gradle and Xcode builds of `@flash/capacitor-secure-storage`.** The Java and Swift code has never been compiled: the build machine has no JDK, Android SDK or Xcode. Then on devices: the Keychain/Keystore round trip, the Custom Tabs OneDrive redirect (including a WebView older than Chromium M130), migration of an existing plaintext token on upgrade, backup exclusions, and the CapacitorHttp refresh against real Entra.
- [ ] Capacitor `pickFile({ maxBytes })`: `@capawesome/capacitor-file-picker` with `readData: false`, then `Filesystem.readFile` on the returned path (an Android `content://` URI or an iOS temporary file). Never run on a device.
- [ ] Recheck the capgo plugin's internal plaintext key names (`packages/platform-capacitor/src/secure/secure-store.ts` and the native allowlists) on every `@capgo/capacitor-social-login` upgrade. They are pinned for 8.7.x.
- [ ] Add-device QR codes scanned with a real phone camera.
- [ ] Second device fully synced within 2 minutes with one sign-in (the Phase 14 target). It has not been measured, because the e2e sign-in is faked.
- [ ] Tauri loopback Microsoft sign-in end to end, including whether `tauri-plugin-http` sends an `Origin` header that Entra rejects (AADSTS9002327).
- [ ] Capacitor Microsoft sign-in on Android and iOS. From reading the code, `SocialLogin.initialize` with only the oauth2 config re-creates only that provider and keeps the Google config, but this hasn't been seen on a device.
- [ ] OneDrive download and upload-session URLs allowing CORS from the Capacitor and Tauri WebView origins.
- [ ] Real Microsoft Graph and Entra behaviour, against a real app registration (`docs/setup-microsoft.md`).
- [ ] Tauri attaching its CSP to Worker script responses, so the FSRS optimizer and the Anki SQLite WASM run under `'wasm-unsafe-eval'`.
- [ ] iOS WKWebView module Workers loaded from the `capacitor://` scheme.
- [ ] Real Anki 23.x/24.x `anki21b` exports. The fixture is synthetic, and its schema-18 DDL was written from memory.

## Decided, no change needed (2026-11-22)

- **OneDrive accounts:** personal only (tenant `consumers`).
- **Leech tag lost to a concurrent edit from another device:** accepted. It is rare, state converges, and the leech filter still finds those cards by lapse count.
- **Leech backfill timing:** once per launch, after that launch's first sync. An offline launch waits for the next one.
- **Anki deck mapping:** one deck per (Anki deck, model) pair, because a deck has a single note type here.

## Still open

### Small code follow-ups

- [x] The OneDrive session KV key is defined once (`ONEDRIVE_NATIVE_SESSION_KV_KEY` in `packages/platform-web/src/auth/microsoft-native-session-key.ts`, exported from `@flash/platform-web/native-support`), and `secure-store.ts` imports it.
- [x] SQLite free pages are scrubbed: the phone database opens with `PRAGMA secure_delete = ON`, and the launch that first runs the secure-store migration sweep also runs `VACUUM` once (`prepareSecureStorageAtLaunch`). Not run on a device yet.
- [x] `packs/_headers` was dead in both places `scripts/build-packs.mjs` wrote it (the app's `public/packs` and the CDN's `dist-static/packs`), because Cloudflare Pages applies only the root `_headers`. The packs CDN gets its CORS headers from the root `_headers` that `publish-packs.yml` writes, and the app loads its own packs from the same origin. The file and its generator are removed.
- [ ] The byte-identical starter-deck rebuild is checked only where the upstream cache exists. Run `node scripts/build-starter-decks.mjs --check` before changing the generated decks.

### Final review nits from the Phase 14 batch (PR #9), resolved 2026-11-22

- [x] **Anki media past the 20-per-field cap:** not a bug. `capMedia` (`model-plan.ts`) cuts each field's references to the cap before any file is resolved or stored, and every field gets as many media keys as its largest note needs. A regression test now guards it (`media past the per-field cap is dropped and never stored`).
- [x] **A failed first sync hid onboarding until a reset.** Closing "Sync my devices" while the first sync is stuck (`error`, `reconnect_required`, `upgrade_required` or `offline`) now offers onboarding (`joinGivenUp` in `emptyCollectionPlan.ts`). It is latched on that tap, never on a sync result, so nothing swaps under the pointer. Covered by an e2e test with OneDrive answering 500.
- [x] **A stale refresh token could survive a new sign-in.** A sign-in that returns no refresh token now deletes the stored one, on phones (`microsoft-secure-bridge.ts`) and on desktop (Tauri OneDrive loopback and Google loopback). A refresh that rotates nothing still keeps the current token.
- [x] **Bring my cards read oversized files before checking them.** `Files.pickFile` takes `maxBytes`. Web and Tauri check the size first, and Capacitor picks with `readData: false`, checks the size, then reads the path with `Filesystem.readFile`. A file over 300 MB is never loaded. Files under the limit are still read in full, because the importers need the bytes (the drag-and-drop path already checked `file.size`).

### Anki extras (owner: no preference; proposed defaults)

- [ ] **Current scheduling:** seed FSRS from Anki's due/interval/ease when review history isn't imported. Proposed: no for now, because the mapping from SM-2 state is lossy.
- [ ] **`.colpkg` full backups.** Proposed: later. Bring my cards currently routes a raw `.colpkg` to the Anki importer.
- [ ] **Older builds and `NoteTagsAdded`.** Builds from before `NoteTagsAdded` keep the event as unknown and don't show the tag. Acceptable before launch.

### OneDrive later

- [ ] **Linked OneDrive sources** that refresh like Google Sheets sources (owner: yes, later). Today the picker is a one-shot import.
- Not planned: a web fallback without the token-helper, and Microsoft's hosted File Picker v8.

## Phase 10 remainder (to audit)

- [ ] Confirm what's left after the first slice in PR #5. Candidates: merging in the other dictionary sources (우리말샘, Wiktionary), Hanja ↔ word links, Add to Deck mapping, the KRDict audio licence check, and the same search treatment for `ja`/`zh-Hans`.
