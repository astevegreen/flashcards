# Follow-ups

Open items left after the Phase 14 batch (Streams A–D, 2026-11-22). The owner's decisions of 2026-11-22 are recorded below; items marked **To build** are approved work. Tick an item off, or delete it, once it is resolved. Product decisions belong to the owner. Until one is made, the shipped default is the least-committal, reversible option described here.

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

## Owner decisions from the Phase 14 batch (decided 2026-11-22)

The owner answered every open decision on 2026-11-22. **To build** marks work that is now approved. **Kept** marks a shipped default that stays. Tick a To build item once it is merged.

### Starter decks

- [x] **Japanese starter deck: kept.** It keeps the sample decks. JMdict/EDICT and KANJIDIC2 (CC BY-SA 4.0) and the Unihan-only kanji deck were both turned down for now.
- [x] **Mandarin: kept.** Common characters from Unihan (Unicode License v3), not HSK words under CC BY-SA.
- [x] **Korean is NIKL level A (beginner), not TOPIK I: kept.**
- [x] **Deck size of about 150 notes (`STARTER_DECK_SIZE`): kept.**
- [ ] **To build: gloss spot-check report.** List the vague, encyclopedic or wrong Wikidata glosses (개 "domestic animal") and terse Unihan `kDefinition` glosses in both starter decks, each with a suggested fix and the licence of the fix's source. Nothing is hand-edited: the owner reviews the report first, and fixes have to go through `scripts/build-starter-decks.mjs`.
- [x] **Korean homographs** (그, 이, 일, 팔): kept as they are. The `vocab-ko` template doesn't change.
- [x] **Attribution placement: kept.** The per-card credit in Notes stays. Nothing is added to Settings > About or to onboarding.
- [x] **English starter deck: kept.** It keeps the sample deck, and no source research is planned.

### Sync and add-device

- [ ] **To build: native add-device QR code and link with a `flashcards://add-device` deep link.** It needs no domain. It uses the same payload (the provider code and the manifest `collection_id`) and the same allow-list parsing and URL stripping as the web build. Register the scheme for Android (intent filter), iOS (`CFBundleURLTypes`) and Tauri (deep-link plugin). Show the QR code in native shells. App Links and universal links wait for the §16 domain decision.
- [ ] **To build: macOS iCloud transport** for the Tauri desktop app, matching the iOS iCloud Drive transport (the ubiquity container and the same file layout, so iOS and macOS share one collection). Once it exists, iCloud becomes the "Sync my devices" default on macOS. It can't be built or signed on the Windows machine: compile it in macOS CI, and list the entitlements and Apple-side setup the owner has to do.
- [ ] **To build: merge the duplicate Google Drive entry.** Keep "Sync my devices" at the top, and hide a provider's own Connect button while that provider is the active sync choice.
- [ ] **To build: ask before adopting a different collection.** On a collection mismatch, offer "Use the synced collection" or "Keep this device's cards" before the engine switches. Both choices keep every event, so either can be undone.
- [x] **A device with cards opened from an add-device link** goes to Settings once per page load: kept.

### Import

- [x] **Anki pre-import summary (2026-11-22).** A picked or detected `.apkg` is read once (with its review history) and converted as a dry run. The summary lists notes, decks (new or existing), note types, media, suspended cards and how many reviews could come along. Nothing is imported until Import is pressed, and "Include review history" stays off unless ticked. Import converts again against the current collection. The Library's "Import Anki (.apkg)" panel works the same way.
- [ ] **To build: keep ruby for `kana:` / `kanji:` and add a render flag.** Import stores the full ruby. A per-layout flag (readings only, bases only or both) decides what's shown, so no text is lost. Cards imported before the change keep their reduced text.
- [x] **Column-mapping step (2026-11-22)** for CSV/TSV, Flashcards Deluxe, Excel `.xlsx` (first sheet), rows pasted into the Bring my cards text box, and Google Sheets.
  - **The guess** (`@flash/core/import-mapping`): header names first (field keys and labels, then English and Korean synonyms, so `word / definition / example / category1-3` maps with no changes). Then the first 20 rows (script, length, repeated values, media URLs). Then column order.
  - **The note type and language** of a new deck are guessed from the script of the rows. Whether row 1 holds column names is guessed too, and can be switched.
  - **On screen:** every column can be changed, and a preview shows the first notes as stored.
  - **Unmapped columns and categories:** columns nobody could place go to Notes as `Header: value` lines; empty ones are skipped. Category columns become flat tags, one per value.
  - **Saved mapping:** a Sheet's mapping is saved on its deck as `SourceRef.column_map` (through `DeckCreated` / `SourceLinked`), so it syncs and applies on every refresh. A column added later falls back to matching by name.
  - **Removed from the Library:** the Paste CSV / TSV form, the "Import CSV/TSV" button and its "Anki furigana" toggle. The toggle is now on the mapping screen.
  - Builds from before this change ignore `column_map`. When one of them refreshes a Sheet, its `SourceLinked` drops the saved mapping, which then needs linking again from Bring my cards.
- [x] **Imported suspensions use reason `manual`: kept.**
- [x] **A pasted Google Sheets link that returns 404** under `drive.file`, followed by the Picker hint: kept.

### Phone secure storage

- [ ] **To build: say why after a lost Keystore key.** When stored secrets are dropped because the Keystore or Keychain key is gone, tell the user once why they have to sign in again, instead of signing them out silently. Moving the BYO TTS key and wiping leftover Keychain items on a fresh install stay as they are.
- [x] The plugin's WebView fallback, used only when no browser at all can open the sign-in page: kept.
- [x] The SQLite database stays in Android backups; only the token files are excluded: kept.

### UX feedback (owner, 2026-11-22)

- [x] **#1 Remove "Paste CSV / TSV":** done in the column-mapping change (PR #14).
- [ ] **To build: #2 language-aware menus and settings.** Options that apply only to one language (furigana and `kana:`/`kanji:` import options, Hanja, pinyin, stroke order, per-language TTS voices and so on) appear only when that language is in the collection or was chosen at onboarding. Adding a language later brings its options back. Nothing is deleted, and an imported deck in a new language counts as adding that language.
- [ ] **To build: #3 explain tags.** Add a short "How tags work" panel in the tag manager and Browse. It covers tags as categories, the `::` hierarchy, and filtering Browse and Study sets. Add a hint on the import mapping step where category columns become tags.
- [x] **#4 Linked sources on PC:** this was never a PC limit. Linked OneDrive sources hadn't been built yet. They're now To build (see "OneDrive" below).
- [x] **#5 Dictionary browsing without typing, in both directions:** done in PR #13.
- [x] **#6 Differently structured files:** done in the column-mapping step (PR #14).

## Not verified on real devices or services

Only Chromium Playwright with faked endpoints has covered these.

- [ ] **`@flash/capacitor-secure-storage` on devices.** Its Java and Swift code now compiles in CI (`.github/workflows/native.yml`: Gradle `assembleDebug` and an unsigned Simulator `xcodebuild`, PR #10). It has never run on a device. Still to check there: the Keychain/Keystore round trip, the Custom Tabs OneDrive redirect (including a WebView older than Chromium M130), migration of an existing plaintext token on upgrade, backup exclusions, and the CapacitorHttp refresh against real Entra.
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

### Anki extras (owner accepted the proposed defaults, 2026-11-22)

- [x] **Current scheduling:** seed FSRS from Anki's due/interval/ease when review history isn't imported. Proposed: no for now, because the mapping from SM-2 state is lossy.
- [x] **`.colpkg` full backups.** Proposed: later. Bring my cards currently routes a raw `.colpkg` to the Anki importer.
- [x] **Older builds and `NoteTagsAdded`.** Builds from before `NoteTagsAdded` keep the event as unknown and don't show the tag. Acceptable before launch.

### OneDrive

- [ ] **To build (approved 2026-11-22): linked OneDrive sources** for `.xlsx` and `.csv` files that refresh like Google Sheets sources, reusing the column-mapping step and `SourceRef.column_map`. Today the picker is a one-shot import.
- Not planned: a web fallback without the token-helper, and Microsoft's hosted File Picker v8.

## Phase 10 remainder (audited 2026-11-22)

### Done

- KRDict pack: per-sense English, POS, level, pronunciation, conjugations, Hanja (원어), homonyms, up to 3 examples per sense, and topics (see below).
- Korean search: inflected forms (irregulars included), particles and the copula, romanization, 초성, jamo prefixes, English → Korean, and romanization capped below real translations.
- Per-sense source badge, About attribution, and draw-to-lookup on Hanja.
- Add to Deck: word, Hanja, meaning, first example; POS, level and pronunciation go into Notes (the Korean vocabulary note type has no fields for them).
- **Browse without typing** (`feat/dictionary-browse`): the dictionary opens with recent lookups, levels, topics, grades, a Hanja grid and an all-words list. Lists are in 가나다 order with a 초성 jump bar and POS filters. The 한국어 → English / English → 한국어 toggle stops reading English as romanization. Grades also cover KANJIDIC2, JMdict and CC-CEDICT.
- **Hanja ↔ word links:** a word's Hanja are tappable; a Hanja lookup lists "Words written with …".

### Still open

- [ ] **Check the KRDict topic attribute names on a real export.** The parser accepts `subjectCategory` / `semanticCategory` and the Korean labels (`주제 및 상황 범주`, `의미 범주`). If the first `build-packs.mjs --full` run gives no topics, find the real names in the XML and add them to `KRDICT_SUBJECT_CATEGORY_ATTS` / `KRDICT_SEMANTIC_CATEGORY_ATTS` in `scripts/packs/upstream-parsers.mjs`.
- [ ] **Measure the full KRDict pack.** It has never been built here. Packs over 25 MiB fail the build; first-syllable sharding isn't written.
- [ ] **KRDict audio licence:** not checked. Audio is skipped, and the dictionary has no speaker button, so the TTS fallback isn't wired either.
- [ ] **Related, synonym and antonym links:** not parsed yet.
- [ ] **Korean definitions (`definitionNative`):** parsed but not shown.
- [ ] **Japanese deinflection** (`食べた` → `食べる`) and Korean-style ranking for `ja` / `zh-Hans`. English lookup there uses the generic meaning tokens.
- [ ] **Owner decision, licences:** 우리말샘, 표준국어대사전 (CC BY-SA 2.0 KR) and Kaikki Wiktionary (CC BY-SA 4.0) are share-alike, and kengdic's licence is unclear. None goes in without the owner's OK. With one source, there is nothing for the merge pipeline (unify, rank, dedupe) to do yet.
- [ ] **Owner decision:** whether to license a commercial Korean–English dataset as a premium pack.
