# Follow-ups

Open items left after the Phase 14 batch (Streams A–D, 2026-11-22). The owner's decisions of 2026-11-22 are recorded below; items marked **To build** are approved work. Tick an item off, or delete it, once it is resolved. Product decisions belong to the owner. Until one is made, the shipped default is the least-committal, reversible option described here.

## Phase 14 batch: what landed (2026-11-22)

- [x] **Secure-store bridge for phone tokens (release blocker): code complete, not yet built natively.** `@flash/capacitor-secure-storage` (`packages/capacitor-secure-storage`): iOS Keychain (after first unlock, this device only, no iCloud sync) and an Android Keystore AES-GCM key over app-private SharedPreferences. The Microsoft refresh token, the Google and OneDrive session access tokens and the BYO TTS config live only there. Older copies are migrated at launch. Phone OneDrive refreshes go through CapacitorHttp, because the capgo plugin writes refreshed tokens back to plaintext storage. Google on Android had the same problem: the plugin writes the ID and access token, but no refresh token, to plaintext SharedPreferences, and the app now deletes that copy. Google on iOS uses the SDK's Keychain. Evidence with file and line: `docs/native-shells.md` "Phone secure storage".
- [x] **Android Microsoft redirect:** Custom Tabs (`androidUseCustomTabs`) plus a `flashcards://oauth` intent filter. The plugin checks state and PKCE natively. Android Auto Backup now excludes the token SharedPreferences files.
- [x] **"Sync my devices":** one button in Settings, on the empty screen and in the one-time prompt. iCloud is the default where an iCloud transport exists (iOS only today); Google Drive is the default elsewhere. The other providers are listed below it.
- [x] **Add-device QR code and link (web build):** they carry the provider code and the manifest `collection_id` only. The receiving device parses them against an allow-list, strips them from the URL, and never shows onboarding while it joins a collection. Native shells first showed text instructions only; they now show a QR code and a `flashcards://add-device` link too (PR #20, see below).
- [x] **Guided "Bring my cards" import** in the Library. Detection reads the content, not the extension: Flashcards Deluxe/plain CSV and TSV, Anki `.apkg` (anki2/anki21/anki21b), `.flashpkg`, and Google Sheets links. It routes to the existing importers. Non-UTF-8 CSV and `.xls` files get a "Save as CSV UTF-8" hint.
- [x] **Curated starter decks (partial):** "Korean Starter: Beginner Words" (145 notes: the NIKL 2003 level-A list under KOGL Type 1, with English meanings from Wikidata lexemes under CC0) and "Mandarin Basics: Common Characters" (150 characters from Unihan 17.0.0 under the Unicode License v3). Both are built by `scripts/build-starter-decks.mjs`, load lazily, and are attributed on every card and in `THIRD-PARTY-NOTICES.txt`. Japanese and English keep their sample decks (see the decisions below).
- [x] **Cloudflare Pages `_headers`** is committed in `apps/web/public`. `apps/web/tests/headers.test.ts` keeps it in sync with `PRODUCTION_CSP` and with §6 of the setup guide.
- [x] **Anki `kana:` / `kanji:` fields** first stored readings only or bases only, like Anki. PR #17 (2026-11-23) replaced that: import keeps the full ruby, and a per-layout `ruby_display` flag decides what shows (see "Import" below).
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
- [x] **Gloss spot-check report (PR #16, 2026-11-23):** written as `docs/starter-gloss-review.md`. Still open: the owner reviews it and decides which fixes to take. No generated deck was edited, and accepted fixes have to go through `scripts/build-starter-decks.mjs`. Original brief: List the vague, encyclopedic or wrong Wikidata glosses (개 "domestic animal") and terse Unihan `kDefinition` glosses in both starter decks, each with a suggested fix and the licence of the fix's source. Nothing is hand-edited: the owner reviews the report first, and fixes have to go through `scripts/build-starter-decks.mjs`.
- [x] **Korean homographs** (그, 이, 일, 팔): kept as they are. The `vocab-ko` template doesn't change.
- [x] **Attribution placement: kept.** The per-card credit in Notes stays. Nothing is added to Settings > About or to onboarding.
- [x] **English starter deck: kept.** It keeps the sample deck, and no source research is planned.

### Sync and add-device

- [x] **Native add-device QR code and link with a `flashcards://add-device` deep link (PR #20, 2026-11-23).** Not yet tried on a real phone or desktop (see "Not verified"). Original brief: It needs no domain. It uses the same payload (the provider code and the manifest `collection_id`) and the same allow-list parsing and URL stripping as the web build. Register the scheme for Android (intent filter), iOS (`CFBundleURLTypes`) and Tauri (deep-link plugin). Show the QR code in native shells. App Links and universal links wait for the §16 domain decision.
- [ ] **macOS iCloud transport (PR #22, 2026-11-23): built, but unsigned and untested on a Mac.** The Tauri iCloud Drive transport and the new `.github/workflows/desktop.yml` unsigned macOS CI build are merged. Remaining: wire the entitlements into `tauri.conf.json` (needs a signing identity and provisioning profile), sign and notarize, and test real iCloud sync on a Mac (see "Owner decisions (2026-11-23)"; the owner has no Apple Developer account yet). Original brief: **macOS iCloud transport** for the Tauri desktop app, matching the iOS iCloud Drive transport (the ubiquity container and the same file layout, so iOS and macOS share one collection). Once it exists, iCloud becomes the "Sync my devices" default on macOS. It can't be built or signed on the Windows machine: compile it in macOS CI, and list the entitlements and Apple-side setup the owner has to do.
- [x] **Merged the duplicate Google Drive entry (PR #20, 2026-11-23).** Original brief: Keep "Sync my devices" at the top, and hide a provider's own Connect button while that provider is the active sync choice.
- [x] **Ask before adopting a different collection (PR #20, 2026-11-23).** Original brief: On a collection mismatch, offer "Use the synced collection" or "Keep this device's cards" before the engine switches. Both choices keep every event, so either can be undone.
- [x] **A device with cards opened from an add-device link** goes to Settings once per page load: kept.

### Import

- [x] **Anki pre-import summary (2026-11-22).** A picked or detected `.apkg` is read once (with its review history) and converted as a dry run. The summary lists notes, decks (new or existing), note types, media, suspended cards and how many reviews could come along. Nothing is imported until Import is pressed, and "Include review history" stays off unless ticked. Import converts again against the current collection. The Library's "Import Anki (.apkg)" panel works the same way.
- [x] **Keep ruby for `kana:` / `kanji:` and add a render flag (PR #17, 2026-11-23):** readings, bases or both, per layout (`ruby_display`). Original brief: Import stores the full ruby. A per-layout flag (readings only, bases only or both) decides what's shown, so no text is lost. Cards imported before the change keep their reduced text.
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

- [x] **Say why after a lost Keystore key: Android (PR #20) and iOS (PR #27), 2026-11-23.** iOS keeps a key-name-only marker per stored secret in the app database and shows the notice when a marker outlives its Keychain item; the fresh-install wipe, sign-out and Reset stay silent. Not run on a device. Original brief: When stored secrets are dropped because the Keystore or Keychain key is gone, tell the user once why they have to sign in again, instead of signing them out silently. Moving the BYO TTS key and wiping leftover Keychain items on a fresh install stay as they are.
- [x] The plugin's WebView fallback, used only when no browser at all can open the sign-in page: kept.
- [x] The SQLite database stays in Android backups; only the token files are excluded: kept.

### UX feedback (owner, 2026-11-22)

- [x] **#1 Remove "Paste CSV / TSV":** done in the column-mapping change (PR #14).
- [x] **#2 language-aware menus and settings (PR #23, finished in PR #29, 2026-11-23).** `deriveActiveLanguages` in core drives the menus and settings; PR #29 added Settings > Languages, pack filtering and the archived-deck rule. Original brief: Options that apply only to one language (furigana and `kana:`/`kanji:` import options, Hanja, pinyin, stroke order, per-language TTS voices and so on) appear only when that language is in the collection or was chosen at onboarding. Adding a language later brings its options back. Nothing is deleted, and an imported deck in a new language counts as adding that language.
- [x] **#3 explain tags (PR #21, 2026-11-23):** a "How tags work" panel and an import hint. Original brief: Add a short "How tags work" panel in the tag manager and Browse. It covers tags as categories, the `::` hierarchy, and filtering Browse and Study sets. Add a hint on the import mapping step where category columns become tags.
- [x] **#4 Linked sources on PC:** this was never a PC limit. Linked OneDrive sources hadn't been built yet. They're now To build (see "OneDrive" below).
- [x] **#5 Dictionary browsing without typing, in both directions:** done in PR #13.
- [x] **#6 Differently structured files:** done in the column-mapping step (PR #14).

## Not verified on real devices or services

Only Chromium Playwright with faked endpoints has covered these.

- [ ] **`@flash/capacitor-secure-storage` on devices.** Its Java and Swift code now compiles in CI (`.github/workflows/native.yml`: Gradle `assembleDebug` and an unsigned Simulator `xcodebuild`, PR #10). It has never run on a device. Still to check there: the Keychain/Keystore round trip, the Custom Tabs OneDrive redirect (including a WebView older than Chromium M130), migration of an existing plaintext token on upgrade, backup exclusions, and the CapacitorHttp refresh against real Entra.
- [ ] Capacitor `pickFile({ maxBytes })`: `@capawesome/capacitor-file-picker` with `readData: false`, then `Filesystem.readFile` on the returned path (an Android `content://` URI or an iOS temporary file). Never run on a device.
- [ ] Recheck the capgo plugin's internal plaintext key names (`packages/platform-capacitor/src/secure/secure-store.ts` and the native allowlists) on every `@capgo/capacitor-social-login` upgrade. They are pinned for 8.7.x.
- [ ] Add-device QR codes scanned with a real phone camera, and the `flashcards://add-device` deep link opened on Android, iOS and Tauri.
- [ ] Real iCloud Drive sync on macOS, and a signed Mac build (PR #22 is compiled in CI only).
- [ ] Capacitor and Tauri shells running the language-aware menus (PR #23 was checked in the web build only).
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

- [x] **Linked OneDrive sources (PR #19, 2026-11-23):** `.csv`, `.tsv` and `.xlsx` files refresh like Google Sheets, with the column-mapping step and rename reconciliation. Real Microsoft Graph is unverified (see "Not verified"). Original brief: **linked OneDrive sources** for `.xlsx` and `.csv` files that refresh like Google Sheets sources, reusing the column-mapping step and `SourceRef.column_map`. Today the picker is a one-shot import.
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
- [ ] **Measure the full KRDict pack.** It has never been built here. `--full` now prints every file's size. **First-syllable sharding is written** (`docs/formats/packs.md`): a dictionary pack over 25 MiB gzipped (or with `--shard <id>`) becomes a version-2 index of search "stubs" plus `.sNN` shards cut at 초성 boundaries. All lookups work from the index; the shards behind the top results load lazily (at most 3 per lookup), and Settings > Packs has "Download all for offline". Still to check once built: that the index itself stays under 25 MiB (about 60% of the pack on the starter sample), and the shard count against the Pages 20k-file limit. Owner choices pending: lazy shards versus downloading them all at install, and the tunables (3-shard cap, top-12 completion, 2 MiB shards).
- [ ] **KRDict audio licence:** not checked. Audio is skipped, and the dictionary has no speaker button, so the TTS fallback isn't wired either.
- [x] **Related, synonym and antonym links (PR #18, 2026-11-23):** parsed from KRDict and shown as links. The `SenseRelation` attribute names (`lemma` / `writtenForm`) are unverified against a real export.
- [x] **Korean definitions (`definitionNative`) (PR #18, 2026-11-23):** now shown.
- [x] **Japanese deinflection** (`食べた` → `食べる`) and Korean-style ranking for `ja` / `zh-Hans` (PR #18, 2026-11-23).
- [x] **Owner decision, licences (2026-11-23):** 우리말샘 and Kaikki approved as optional separately licensed packs; kengdic stays out (see "Owner decisions (2026-11-23)"). Original: 우리말샘, 표준국어대사전 (CC BY-SA 2.0 KR) and Kaikki Wiktionary (CC BY-SA 4.0) are share-alike, and kengdic's licence is unclear. None goes in without the owner's OK. With one source, there is nothing for the merge pipeline (unify, rank, dedupe) to do yet.
- [x] **Owner decision (2026-11-23): deferred until after launch.** Whether to license a commercial Korean–English dataset as a premium pack.

## Owner decisions (2026-11-23)

The owner answered every overnight question on 2026-11-23. **To build** marks approved work; tick it once merged. **Kept** marks a shipped default that stays.

- [x] **#23, archived decks and language (PR #29):** archived decks no longer count toward a language. Archiving the only Japanese deck hides furigana; un-archiving brings it back. Nothing is deleted.
- [x] **#23, "add a language" control (PR #29):** synced preference `preferences.languages` (per-language last-writer-wins through `PreferencesChanged`). a Languages list in Settings, with a tick box per language. Ticking one brings its options back before any deck in it exists.
- [x] **#23, offline pack manager and Hanja/Kanji dictionary pack tabs (PR #29):** filtered by active language, with a "Show all languages" switch.
- [x] **#23, Ruby for Korean (PR #29, owner changed the default):** the dev Korean sample deck is now plain Hanja too. remove ruby for Korean and Hanja. Korean no longer switches on the Ruby toggle or the per-layout ruby selector; Chinese keeps them for pinyin, Japanese for furigana. No stored data is rewritten.
- [x] **#6/#21, tag copy (PR #26):** "nested tags" replaces "subcategories". say "tag" everywhere. "Category" appears only in one explainer line ("tags work like categories") and in the import hint where category columns become tags. **Kept:** the How tags work panel stays open by default until first dismissed.
- [x] **#20, iOS Keychain loss (PR #27):** detect it on iOS and show the same one-time notice as Android.
- [ ] **#22, macOS iCloud setup:**
  - **Apple Developer account: the owner has none yet.** Signing, notarizing, wiring the entitlements and real iCloud tests wait until there is one. An account (Apple Developer Program) is also needed for any iOS or Mac store release, so it is on the launch path anyway.
  - **Distribution: Developer ID** (outside the Mac App Store). Kept.
  - **Done (PR #27):** hide "Use iCloud Drive" on unsigned Mac builds (no entitlement), so the misleading sign-in error can't appear.
  - **Done (PR #27):** a Mac where iCloud was off at launch keeps iCloud Drive listed, with a hint to turn iCloud Drive on.
  - The macOS App ID reuses `app.flashcards.localfirst`; it must be in the same Apple team as the iOS app. Kept, for when the account exists.
- [x] **#18, provenance (PR #28):** an "App" badge, with attribution tooltips on every badge. the 춥다 and 먹다 rewording is accepted. Hand-written definitions get their own badge instead of KRDict's.
- [x] **Starter-deck gloss report (#16), applied in PR #28:** `content/starters/gloss-overrides.json`, decks at 1.1.0; four readings corrected after review (아니, 长, 呐, 地). Not reviewed by a native speaker. accept every suggested fix in `docs/starter-gloss-review.md`, applied through `scripts/build-starter-decks.mjs` (never by hand-editing the generated decks).
- [x] **Dependabot PR #4 (TypeScript 6):** merged (`05af924`).
- [ ] **KRDict audio licence: researched 2026-11-23, unclear, so audio stays out.** KRDict's copyright policy (https://krdict.korean.go.kr/eng/kboardPolicy/copyRightTermsInfo) puts text under CC BY-SA 2.0 KR (commercial use allowed, attribution and share-alike), which matches `packages/core/src/dictionary/licenses.ts`. Sounds and pronunciations are excluded from that grant: commercial use and modification are set per file, and no machine-readable flag or bulk audio download was found (the Open API has a `multimedia_info` link, unconfirmed without a key). To use it, the owner would need written confirmation from NIKL, or separately licensed audio. Owner decision pending.
- [ ] **Share-alike dictionary sources. Approved:** 우리말샘 and Kaikki Wiktionary as optional, separately licensed download packs with attribution (their share-alike terms apply to those packs, not the app). 표준국어대사전 is not approved yet. **kengdic stays out** (unclear licence). Building the packs is a separate task: the upstream data needs manual download.
- [ ] **Commercial Korean–English dataset as a premium pack:** deferred until after launch.
- [x] **Auto-archive on PR close:** turned back on.

## Anki feature gap: owner decisions (2026-11-23)

On 2026-11-23 an agent compared the app with Anki, about 25 features. This section leaves out items already decided: raw HTML/CSS templates (the security rule), `.colpkg` and seeding FSRS from Anki scheduling (see "Anki extras" above). Ruby, furigana and pinyin already exist (`packages/core/src/parsers/`). The owner has not yet discussed card-level controls (forget, set due date, reposition, bury, flags, card info), the FSRS extras (editable steps, easy days, load balancing, simulator, answer timer) or a typed search syntax. Approved items below are not scheduled yet.

### To build

- [x] **Automatic rolling backups (first priority of this list).** Sync is not a backup: a deletion or a bad import syncs to every device and to the cloud copy. Built in `packages/core/src/backup/` and Settings > Automatic backups (`packages/ui/src/backups/`):
  - A dated snapshot about once a day the app is used, only when the collection changed. The newest 14 are kept, plus the newest full one. A snapshot is a valid `.flashpkg` (any build imports it) with `backup/state.json`, the full state with review history, beside it.
  - Daily snapshots carry no media. They list the content hashes they use, and media cleanup must keep those. A weekly full snapshot packs the media, when it totals 100 MB or less.
  - Restore is previewed and confirmed. It appends new events from this device that bring the collection back to the backup, so it syncs like any edit. Nothing is deleted: decks and notes the backup lacks are archived. A `pre-restore` snapshot is taken first, so a restore can be reverted. Reviews made after the backup are always kept.
  - Optional copy in the sync folder (`backups/v1/<device>/day-<weekday>.flashpkg`, no media). The 7 weekday slots overwrite, so no transport needs a delete. Settings lists every device's copies for restore.
  - Web: backups live in IndexedDB and persistent storage is requested. OPFS was not used: it shares IndexedDB's quota and eviction, so it adds nothing. The off-device copies are a downloaded file and the sync folder.
  - The reminder still shows for users who don't sync. Automatic snapshots never count as a backup for it; downloading one does. "Export Backup" now writes the same format with media, so a manual backup keeps review history too.
- [ ] **Check media and check database.**
  - Check media lists media that no note uses and media that notes reference but is missing. It offers to remove unused files, because they count against the user's own Drive or Dropbox quota.
  - Check database rebuilds state from the event log and reports any difference.
  - Empty-cards cleanup only if optional cards (below) ship.
- [x] **Optional cards (PR #34).** One rule per layout: make this card only when field X is filled (`Layout.required_field`, set in Library > deck Options > "Layouts: optional cards"). No template conditionals. A card with active reviews whose field is emptied is kept: it is hidden from Study, has only the Empty state in Browse (badge and "Empty" filter), and comes back with its schedule when the field is filled again. Reviews stay in the event log in every case. A rule on a field the note type lacks, or on a cloze layout's own text, is ignored (import drops it with a warning; the settings list flags it). Snapshots saved by older builds are re-derived on load. Stroke data from the offline packs is per device, so it can't decide which cards exist; a writing card can only depend on a note field.
- [x] **Duplicate finder across decks (PR #36)**, on the note's key field, for imported lists (HSK, JLPT) that overlap the user's own decks. Browse > Find duplicates groups notes whose key field matches after NFC, trimming and ruby stripping (`@flash/core/duplicates`), with Open, Tag "duplicate" and Archive. No merge.

- [x] **Shared deck option presets.** Built: a deck uses a preset (new cards/day, max reviews/day, target retention, FSRS weights) or its own settings, and the optimizer can pool a preset's decks. Defaults under "Decisions needed (deck presets and folders)".
- [x] **Deck folders instead of Anki subdecks.** Built: one level of folders in the Library, with "Study folder". Daily limits stay per deck.
- [x] **Deck descriptions.** Built: a plain-text description per deck, edited in deck options and shown on an overview before study. Starter decks and `.flashpkg` packages (so Family Library decks) bring one. Defaults under "Decisions needed (deck descriptions)".
- [x] **Limited rich text in the field editor.** Strict inline markup in the plain field string: `{b:…}`, `{i:…}` and `{red:…}`, `{orange:…}`, `{green:…}`, `{blue:…}`, `{purple:…}`, parsed in `packages/core/src/parsers/rich-text.ts` and rendered as React elements by `RichText.tsx`, never as HTML. It works with ruby and cloze (`{b:日本[にほん]}`, `{{c1::{b:word}}}`, `{b:{{c1::word}}}`); notes without it render as before. Answer matching, TTS, choice dedupe and draw grading ignore it; `stripRichText` is exported for the export and duplicate-finder work. The editor has a B / I / colour toolbar under the focused field, Ctrl/Cmd+B and Ctrl/Cmd+I, and a preview line. Defaults under "Decisions needed (2026-11-23 field editor)".
- [x] **Paste images into fields.** Pasting or dropping an image on an image field's drop zone in `NoteEditDialog.tsx` goes through the same `processImage` → `addMedia` path as the file picker, with the same type and size checks (`editor-paste-image.spec.ts`). Defaults under "Decisions needed (2026-11-23 field editor)".
- [ ] **Later:** find and replace across notes. The event log makes it undoable.
- [ ] **Later, if cheap:** redo after undo. Undo appends `ReviewUndone` (`undoLastReview`, `AppContext.tsx`).

### Waiting for customer feedback

- [ ] **Recording audio.** This covers recording into a field while editing, and recording yourself during review to compare with the native audio. The owner deferred it until customers ask for it. If built, one recorder serves both uses, and recordings stay out of sync by default to save the user's quota.
- [ ] **Multiple profiles on one device**, for example a family tablet. A possible future build item, depending on feedback. Today a device holds one collection (`collection_id`); each profile would need its own event log and its own sync connection.

### Not planned

- **Add-ons or a plugin system.** It conflicts with the no-raw-HTML rule, iOS restricts downloaded code, and a public API would need maintaining forever.
- **A public shared-deck site like AnkiWeb.** It needs an always-on server, which breaks the zero-server design. It also brings moderation work and copyright risk. Sharing stays with `.flashpkg` files, shared folders, starter decks and Family Library catalogs.
- **Image occlusion and LaTeX/MathJax.** Little value for language study.

### Export to other apps (owner approved, 2026-11-23)

No open format with media and review history is widely adopted. CSV/TSV is the common format that most apps import, but it carries no media and no history. `.apkg` is in practice the main exchange format: Anki on every platform reads it, and some other apps import it too. **To build**, in this order:

- [x] **"Export for Anki" option on CSV export.** Browse > select notes > tick **For Anki** > Export CSV. The zip holds the CSV with Anki's header lines, a `collection.media/` folder and a README. Ruby becomes Anki furigana, `media:` references become `<img>` / `[sound:]`. Plain CSV stays the default, because other apps would read those header lines as data. Defaults under "Decisions needed (Anki export)".
- [x] **`.apkg` export** of notes, media and tags. Library > a deck's Options > **Export for Anki (.apkg)**. One Anki note type per note type, one card template per layout, every card new. Defaults under "Decisions needed (Anki export)".
- [ ] **`.apkg` review history (follow-up):** write `revlog` rows and card scheduling from the review events, so a user who leaves keeps their intervals. The `revlog` table is already created, empty.

## Decisions needed (2026-11-23 batch)

Defaults the 2026-11-23 agents picked. Each stays shipped until the owner decides.

- [ ] **PR #27, iOS loss marker location:** the app's SQLite database, not UserDefaults (same backup behaviour, plain TypeScript). Markers are iOS-only; Android relies on its plugin's own Keystore-loss report.
- [ ] **PR #27, Mac entitlement check:** only checks that an iCloud entitlement exists, not that it names `iCloud.app.flashcards.localfirst`. A launch-probe timeout counts as unknown: Google Drive stays the default, with no "iCloud Drive looks off" hint.
- [ ] **PR #28, gloss choices:** 해 stays "year (counter)" without "sun"; every numeral is labelled native or Sino-Korean; 팔 fronts get no hint. Every sense in the hand-written starter KRDict fixture (dev and tests only) now gets the App badge, not just 먹다 and 춥다.
- [ ] **PR #28, existing starter decks:** devices that already loaded the 1.0.0 starter decks keep the old glosses (there is no upgrade path).
- [ ] **PR #29, Languages:** "Show all languages" is one per-device switch for the pack manager and the dictionary. Unticking a language also drops its onboarding choice. Unticking everything (with no decks) shows no language options. Cloze, Sentence and Grammar are language-neutral, so a mis-tagged neutral deck no longer counts through its fields. A Korean card that already stores ruby on a layout that hides it on the front keeps the Ruby toggle. Dev collections seeded with the old Korean sample keep its ruby.

### Leftover nits from the 2026-11-23 batch

- [x] `node scripts/build-starter-decks.mjs --check` now runs in CI as its own `starter-decks` job in `ci.yml`. The fetched sources are cached, keyed on the pinned source files. If every fetch retry fails, the job warns and skips the check; a real drift still fails it.
- [x] Every sense in the dev/test starter KRDict fixture is hand-written, so all of them now carry the App badge. The full KRDict pack keeps the KRDict badge.
- [x] PR #27: at launch on iOS, every stored secret is read once, so a secret never read between upgrade and backup gets its marker (`markStoredSecretsAtLaunch`). Not run on a device. Still open: a downgrade to a build without markers, then sign-out, leaves a stale marker (TestFlight only).
- [x] `CategoryExportPanel.tsx` comments say "tag" / "nested tags"; the export file-name fallback is `tag`.
- [x] The two local e2e flakes. `sync.spec.ts` went offline before the service worker had precached, so a lazy chunk failed and the app went blank. The test now waits for the service worker (7 of 12 failed before, 16 of 16 pass after). `phase13-onboarding` now waits for the starter deck to reach IndexedDB before reloading. That flake never reproduced, so this fix is the likely cause, not a proven one.

## Decisions needed (2026-11-23 nits batch)

Defaults picked while clearing the leftover nits. Each stays shipped until the owner decides.

- [ ] **Lazy chunks:** every `React.lazy` in `packages/ui` goes through `lazyWithRetry`: 2 retries (300 ms, then 1.2 s), and a retry as soon as the browser is back online. A chunk that still can't load shows "This part of the app isn't available offline yet. Reconnect and try again." with Retry, and Close on dialogs. Other errors inside a lazy part now show "This part of the app couldn't open. Try again." in place, instead of blanking the whole app. Card images and audio that can't load show nothing. Found through the `sync.spec.ts` flake: going offline before the first precache blanked the app.
- [ ] **Sidebar badge** while a collection choice is pending: "Choose" (amber), tooltip "Choose a collection in Settings".
- [ ] **Starter-deck CI check:** skips with a warning when every fetch of the pinned sources fails, rather than failing the job.
- [ ] **`initialDrawOpen` with no CJK language:** the pad opens on Korean (Hanja).
- [ ] **Furigana default:** based on the deck's language, not on whether Japanese is active anywhere in the collection.
- [ ] **Typed-answer strictness with ruby:** `both` and `readings` layouts also accept the other form (see "#17" below).
- [ ] **macOS temp sweep:** temp files must be at least an hour old before they're deleted.
- [ ] **Dictionary shards:** loaded lazily, with an opt-in "Download all for offline" (see "Phase 10 remainder").

## Decisions needed (2026-11-23 field editor)

Defaults picked while building the field editor items of "Anki feature gap" above. Each stays shipped until the owner decides.

- [ ] **Pasted images, where they go:** a paste or drop on an image field's drop zone goes to that field. Anywhere else in the editor, an image with no text alongside it goes to the note's only image field; with no image field, or two or more, it is ignored. A file dropped anywhere else in the editor never opens in the browser tab.
- [ ] **Pasted images, size cap:** a pasted or dropped file over 20 MiB is refused before it is read, the same cap `processImage` applies. The file picker still reads the file first.
- [ ] **Rich-text syntax:** `{mark:content}` with exactly seven marks: `b`, `i`, `red`, `orange`, `green`, `blue`, `purple`. Lower case only; spans nest up to 8 deep; an empty span (`{b:}`) or an unclosed one stays literal. There is no escape for a literal `{b:x}`, the same as ruby.
- [ ] **Rich text with ruby and cloze:** a span can't cut through ruby or cloze braces; the editor refuses such a selection with a hint. Inside a cloze, a span styles the revealed answer. A cloze hint shows its text unstyled.
- [ ] **Palette:** red, orange, green, blue, purple, each with a light and a dark-theme shade (`.rich-*` in `apps/web/src/styles.css`). Bold renders as `<strong>`, italic as `<em>`.
- [ ] **Editor:** the toolbar shows only under the focused text field, not under the pronunciation override or tags. Colours have no shortcut. Pressing the same mark on a selected span removes it; another colour on a coloured span swaps the colour. A preview line shows under any field that holds markup.
- [ ] **Not changed by the rich-text PR:** Browse search (`packages/core/src/tags/browse.ts`) still matches on the raw text, so a word inside a span is found but a phrase across a span edge isn't. `.flashpkg` and CSV export keep the markup as is; the Anki export work decides whether to strip it or map it to `<b>`/`<i>`/colour.

## Decisions needed (optional cards and duplicate finder, 2026-11-23)

Defaults picked while building two items of the Anki feature gap list. Each stays shipped until the owner decides.

- [ ] **Optional cards, empty field:** a card is made only when the field has a non-whitespace character. A card with no active review is simply not made (nothing to lose); one with reviews is kept as Empty. Undoing an Empty card's last review removes it. Empty cards count in stats history but not in the due forecast. No built-in layout has a rule, so existing collections are unchanged.
- [ ] **Optional cards, scope:** the rule lives on the layout, so it applies to every deck that uses the layout (built-in layouts included), like the ruby setting. It is not per deck; the deck Options list says so.
- [ ] **Optional cards, cloze:** no rule on a cloze layout's text fields. Emptying the text would change which c1/c2 variants exist, so studied cloze cards could not be kept as Empty.
- [ ] **Empty-cards cleanup** (in "Check media and check database"): not built. Empty cards hold review history, so nothing is deleted; Browse lists them with the Empty filter.
- [ ] **Duplicate finder, what matches:** the key field is the note type's `sortKey` field (else the first field), so two note types of one language can share a group. Keys are compared after NFC, folding full-width Latin and digits, half-width katakana and Hangul, and compatibility jamo (NFKC on those runs only; circled numbers and unit squares stay as they are), ruby reduced to one side (the base, but the Hangul side in Korean decks, so `學校[학교]` matches `학교`), trimming and collapsing inner spaces; case is kept. Notes only match within one deck language (`学校` in a Japanese and a Chinese deck is not a duplicate). Archived notes and archived decks are left out.
- [ ] **Duplicate finder, scope:** "Only across decks" is on by default; unticking it also lists repeats inside one deck. The rich-text markup from the field editor is not stripped yet (a TODO in `normalizeDuplicateKey` until its parser lands).
- [ ] **Duplicate finder, actions:** Open (the note editor), Tag "duplicate" on the whole group (set-union `NoteTagsAdded`, so a concurrent tag edit is never overwritten), and Archive per note (history kept, restorable). **No merge:** cards are keyed by note id, so merging two notes' review histories would need a new event, not a cheap or safe change.
- [ ] **Follow-up:** the duplicate panel recomputes every group on each state change while it is open (`DuplicateFinderPanel.tsx`). Fine for typical collections; memoize per note if large imports feel slow.

## Decisions needed (Anki export)

Defaults picked for "Export for Anki". Each stays shipped until the owner decides.

- [ ] **CSV columns:** GUID, note type, deck, one column per field (named after the field label, without the characters Anki forbids), tags. Header lines: `#separator`, `#html:true`, `#columns`, `#guid column`, `#notetype column`, `#deck column`, `#tags column`. No BOM, because the header lines must start the file.
- [ ] **Note type column:** names this app's note type. Anki skips rows whose note type it doesn't have (it creates missing decks, not note types), so the README says to create the note type first or to use `.apkg`. The other option: leave the column out, and Anki's import window asks for a note type.
- [ ] **GUID:** a note imported from Anki gets its original GUID back, so the profile it came from gets no duplicate. Anki updates it only when it arrives with the note type it has there; under another note type it is a conflict, and Anki skips it unless "Merge note types" is ticked. Other notes use their own id.
- [ ] **Media file names:** `<sha256>.<ext>`, in `collection.media/` inside the zip (Anki's text import copies no media). Media this device doesn't have is left out and counted in the message. Only the importers' media types (png, jpg, webp, gif, mp3, ogg, wav, m4a) are written; any other extension counts as missing. The zip is written one file at a time into Blob parts (stored media, deflated text), so a large audio deck is never held in memory twice; the native apps still get one array at the end.
- [ ] **Text as HTML:** `<`, `>`, `&`, `"` are escaped, line breaks become `<br>`, and literal `[` / `]` are written as `&#91;` / `&#93;`, so Anki's furigana filter can't turn `test[abc]` into ruby. Ruby becomes ` base[reading]`. A space of the text right before a base is written `&#32;` (Anki consumes the literal space as the base marker), and a space inside a base is `&#160;`.
- [ ] **Tags:** spaces inside a tag become `_` (Anki separates tags with spaces); `::` hierarchies are kept.
- [ ] **Rich text (follow-up):** the field editor's markup from PR #38 (`{b:…}`, `{i:…}`, `{red:…}` and the other colours, nesting) isn't converted yet. `AnkiRichTextConverter` (`packages/core/src/export/anki/field-html.ts`) is the hook: once #38 is on main it should turn the markup into `<b>`, `<i>` and `<span style="color: …">`. Plain CSV export should then strip it with `stripRichText`. The `.apkg` export takes the same hook.
- [ ] **`.apkg` format:** the legacy `collection.anki2` (schema 11) plus the JSON `media` map. Every Anki since 2.1 (desktop, AnkiDroid, AnkiMobile) imports it; the newer `anki21b` needs zstd and protobuf writers for no gain here.
- [ ] **`.apkg` ids:** a note type imported from Anki gets its Anki id back (and its card types keep their Anki order), so in the profile it came from Anki can update those notes while the note type's fields and card types are unchanged. The export message says so when the package has notes from Anki. Other note types and all decks get ids hashed from this app's ids, so a second export of the same deck matches them in Anki. Note and card ids count up from the export time. GUIDs follow the CSV rule above.
- [ ] **`.apkg` templates:** one card template per layout enabled in the exported decks (all layouts if none is enabled). The front shows the front fields (`{{kanji:…}}` when a layout hides furigana on the front, `{{furigana:…}}` otherwise), typed layouts add `{{type:…}}`, the layout's spoken field gets `{{tts …}}` on the front or the answer, following when the layout speaks. Choice, listen and draw layouts become plain flip cards. A note type with a cloze layout becomes an Anki cloze note type with only that template, and the message warns when other layouts were dropped.
- [ ] **`.apkg` cards:** all new, in note order; suspended cards stay suspended. Parent decks are created for `::` names.
- [ ] **`.apkg` writer:** SQLite is written with sql.js in a short-lived Web Worker, reached through the existing lazy Anki service (`AnkiPackageReader.writeCollection`) rather than a new platform getter, so the study-screen bundle doesn't grow. A write that fails or doesn't answer within 5 minutes is stopped with an error. The package is streamed like the CSV zip and downloaded as `application/octet-stream`.
- [ ] **Importer:** `[ ] { } |` written as entities (`&#91;`, `&#124;`, …) in an Anki field never form ruby or cloze, as in Anki. They come back as the literal characters when that changes no ruby or cloze (so `test&#91;abc&#93;` stays `test[abc]`), and as fullwidth lookalikes (`［］｛｝｜`) when it would (`漢字&#91;かんじ&#93;` becomes `漢字［かんじ］`).

## Decisions needed (deck presets and folders)

Defaults picked while building presets and folders. Each stays shipped until the owner decides.

- [ ] **Migration:** existing decks keep their own settings. No "Default" preset is created; a deck joins a preset only when the user picks one.
- [ ] **What a preset holds:** new cards/day, max reviews/day, target retention and FSRS weights. New card order, layouts and the study-day start stay per deck.
- [ ] **Limits:** each deck in a preset gets the preset's limits on its own count (20 new/day means 20 per deck), as in Anki. There is no pooled limit for the whole preset or folder. The app copies the preset's limits and retention into each member deck's own settings (ordinary `DeckSettingsChanged` events), so the study queue never reads presets.
- [ ] **Weights:** a preset without optimized weights leaves each deck its own weights; the first pooled optimization sets the same weights on every deck in it. The pooled optimizer needs the usual 400 eligible reviews, counted across the preset's decks. Its "Current" estimate scores each deck with the weights it uses today, and it warns when the decks use different weights.
- [ ] **Applying a preset:** joining a preset copies all its values into the deck; an edit copies only the fields it changed. Changing retention or weights writes one new FSRS parameters version per deck for future reviews. Existing due dates change only if the optimizer's "Reschedule existing cards" box is ticked.
- [ ] **FSRS versions from presets** are numbered `time in ms × 1000 + a device number` instead of "active + 1", so two devices copying at once never write the same version and neither copy is lost. The optimizer's "Saved … as FSRS parameters v…" message then shows a long number for such decks.
- [ ] **Leaving or deleting a preset:** the deck keeps the preset's limits and retention as its own settings.
- [ ] **Deletes are final:** a deleted preset or folder never comes back, even if another device edited or renamed it later at the same time. Deleting writes nothing per deck, so a concurrent move of a deck to another folder or preset still stands.
- [ ] **New presets:** "Save these settings as a preset" copies the deck's limits, retention and weights; a preset made in the Library panel starts at 20 / 200 / 0.90.
- [ ] **Folders:** one level. With no folders the deck list looks as before; once one exists, unfiled decks show under "Not in a folder". Deleting a folder leaves its decks unfiled. "Study folder" is one session over the folder's decks (shown as a Study filter), each deck with its own limits.
- [ ] **Not in `.flashpkg`:** presets and folders are not exported or imported yet.
- [ ] **Catch-up:** after each sync, and when the Library opens, the app compares every deck in a preset with the preset and copies the preset into any deck that differs. This heals a deck that joined during an edit elsewhere, a retention copy racing a weights copy, and an older build editing a member deck (the preset wins). It writes only real differences, and devices that agree on the preset write the same values.
- [ ] **Bundle:** initial study-screen JS 156.43 KB gz before, 156.63 KB after. The 0.2 KB is the post-sync catch-up trigger and lazy-chunk names; presets, folders, the catch-up itself and their UI load with the Library or after a sync.

## Decisions needed (deck descriptions)

Defaults picked while building deck descriptions. Each stays shipped until the owner decides.

- [ ] **Plain text only**, up to 2,000 characters, line breaks kept. Markup is shown as typed, never rendered. The limited rich text from the field editor item could be reused later.
- [ ] **Stored as its own event, not a `Deck` field:** `DeckDescriptionChanged` is log-retained and folded on demand, like the Study Set events, so the study-screen bundle does not grow and older builds keep the events. Last writer wins per deck; an empty description clears it.
- [ ] **Starter decks** use the catalog's description (for example "Beginner (level A) Korean words from the NIKL learning vocabulary list…"). Starter decks added before this build get none; there is no backfill.
- [ ] **Packages:** `.flashpkg` export writes the deck's description in the manifest. Import fills it only for a deck that never had a description event, so a package update never brings back a description the user cleared. Package and starter descriptions are marked as such, and any description the user wrote or cleared wins over them, even from a device that has not synced the user's text yet. A Family Library `index.json` entry's own description is not copied; the deck description comes from the package manifest.
- [ ] **Overview:** only decks with a description show it. Study on any other deck starts at once, as before. "Study folder" and "All decks" skip the overview.

## Decisions needed (rolling backups, 2026-11-23)

Defaults picked while building automatic backups. Each stays shipped until the owner decides.

- [ ] **How many and how often:** keep 14 snapshots. A new one when the newest is 20 hours old and the collection changed. The first check runs 8 s after launch, then hourly and when the app returns to the foreground.
- [ ] **Full snapshots:** weekly, only when media totals 100 MB or less (the `.flashpkg` import cap). Above that every snapshot is daily, and the media store and the sync folder hold the files. The newest full snapshot is kept even when older than the 14.
- [ ] **Restore mechanism:** new events that move the collection to the backup, not a separate collection. Decks and notes the backup lacks are archived. Reviews made since are always kept: the "Also undo the reviews made after this backup" option was removed, because undoing those reviews could not itself be reversed. Not restorable: a review undone after the backup, pages the backup lacks (pages have no archive), Study Sets and practice sessions, and deck fields added after this PR.
- [ ] **Reset keeps backups:** "Reset Local Device Data" leaves the backups on the device, so a reset can be undone, and keeps the images and audio a kept backup lists, so a daily snapshot restores whole. There is no "Delete all backups" button yet. Settings > Automatic backups says when no kept snapshot holds the media.
- [ ] **Pre-restore snapshots:** kept apart from the rolling 14, newest 3 only. The backup being restored is never pruned to make room.
- [ ] **Wrong clocks:** a snapshot stamped more than 10 minutes in the future is ignored for "due" and for the kind, and is pruned first.
- [ ] **Low storage:** old snapshots are pruned only after a new one is stored. On web a snapshot is skipped when `navigator.storage.estimate()` leaves less than twice its size plus 50 MB free. Phones and desktop have no reliable free-space figure (the WebView estimate doesn't count the SQLite file), so there, after a failed snapshot, only daily snapshots (no media) are taken until one succeeds. A skipped or failed snapshot never touches the event log; Settings shows the last error until the next snapshot succeeds. A snapshot that hasn't finished after 10 minutes is given up on.
- [ ] **Restore and other devices:** when sync is connected, a restore pulls first. The confirmation says edits on a device that has not synced yet may survive it. The study undo stack is cleared after a restore.
- [ ] **Backup files are checked:** `backup/state.json` is validated (Zod, `@flash/content-schema/backup-state`) before a preview; a malformed value rejects the whole backup.
- [ ] **Phone storage:** archives sit in 1 MB chunks (`backup_chunks`), so no single SQLite parameter carries a whole backup. A failed write removes its chunks, and chunks without a backup row are swept when the backups are first opened after launch. Snapshots are zipped on the main thread in steps (fflate's async zip needs a `blob:` worker, which the CSP refuses).
- [ ] **Sync-folder copy:** off by default. One copy per device per weekday, without media. A restore from the sync folder needs the media in the sync store, or in the full snapshot of the device it came from.
- [ ] **Web storage:** IndexedDB with `navigator.storage.persist()`, requested by the backup check at launch, no longer by `AppContext` directly. When the browser refuses, Settings warns that backups can be cleared, and a one-time notice says so outside Settings (not shown when sync is connected).
- [ ] **Downloads:** "Download" on a daily snapshot adds the media from this device to the file. Downloading counts as a backup for the reminder.

## Leftover nits and known limitations

### #17 Ruby for Anki `kana:` / `kanji:`

- [x] Typed answers accept what the layout shows: `both` or no flag accepts the bases or the readings (so kana alone passes), `readings` accepts the readings or the bases, `bases` accepts bases only. The one place to make this stricter is `rubyReductions()` in `answer-match.ts`.
- [x] `matchTypedAnswer` has tests (`ruby-display.test.ts`): no ruby, each flag, romaji, alternates, pinyin and the "Expected" text.
- [x] Choice dedupe and draw grading use the layout's ruby flag. Still on bases: the deck-level stroke coverage in the Library, which has no layout.
- [x] Browse search matches a phrase across ruby groups in all readings or all bases (`わたしはにほん`, `私は日本`); a mix of the two doesn't match.

### #18 Dictionary

- [x] An exact `altForm` (or reading) hit now counts toward the guessed-lemma cap.
- [x] Only hits in allowed packs count toward the cap.
- [ ] KRDict full-pack measurement and the topic attribute check are not done; the upstream data is a manual download. First-syllable sharding is done (see "Phase 10 remainder").
- [ ] The `SenseRelation` attribute (`lemma` / `writtenForm`) is unverified against a real export.

### #19 Linked OneDrive sources

- [x] The 4 SonarCloud items: `handleApplyReconciliation`, `linkOneDriveFile` and `refreshSingleOneDriveSource` are split into helpers. The OneDrive refresh loop stays one file at a time on purpose (downloads of up to 50 MB, Graph throttling) and carries `NOSONAR (S9382)`. The complexity counts were done by hand; Sonar hasn't been run on it.
- [x] **Unlink syncs** through a new `SourceUnlinked` event, for Google Sheets, Google Docs, OneDrive and `.flashpkg` URLs. It shares the last-writer-wins slot with `SourceLinked`, and builds that don't know it keep it as unknown and fold it in when they load a snapshot. Folders and catalogs stay per device. Known gaps: a relink recorded by another device before it receives the unlink wins; builds without the event keep re-listing the source; a `.flashpkg` subscription saved on another device isn't pruned.
- [x] Refreshing or applying to an archived deck shows a "Deck archived" pill, and Refresh all lists it under "Not refreshed". Google Sheets on archived decks are no longer refreshed at all, the same rule as OneDrive. Linked local folders now skip the `.csv`/`.tsv`/`.xlsx` files of an archived deck too (a `deck_archived` warning, read again after a restore), and Apply & Import on one keeps the prompt and asks for a restore first.
- [ ] Real Microsoft Graph is unverified.
- [x] `.xlsx` links on phone and Tauri shells show a "Can't read here" pill and are listed under "Not refreshed". No error banner.

### #20 Sync and devices

- [x] The AppContext comment says Keystore/Keychain, but the notice is Android-only. Fixed in PR #27.
- [x] While a collection choice is pending, the sidebar badge reads "Choose" (amber, tooltip "Choose a collection in Settings") and opens Settings. Pull-to-refresh still syncs and asks again.
- [x] An answered collection choice latches: a sync that started before the answer drops its stale "choice required" result.

### #21 How tags work

- [x] The Browse guide reappears after the tag manager closes. Fixed in PR #26.
- [x] Heading level in the tag manager panel. Fixed in PR #26.
- [x] The import hint shows even when there is no tags column. Fixed in PR #26.
- [x] No phone-width (320-360 px) test. Fixed in PR #26.

### #22 macOS iCloud Drive

- [ ] No `NSFileCoordinator`, and a directory walk instead of `NSMetadataQuery` (untested on a Mac). Not attempted: it needs `block2`, a run loop and a real Mac to test. The iOS Swift plugin is the model.
- [ ] Placeholder timestamps are still approximate, because the `.icloud` property list holds no modification date. **Size fixed:** a placeholder reports the real size from `NSURLFileSizeKey` (binary or XML plist), or 0 if it can't be read. It's unconfirmed that real macOS placeholders store the key this way.
- [x] Stale temp files are swept at each listing: only `.flashcards-tmp/<digits>-<digits>.tmp` (and its placeholder), at least an hour old. Rust unit tests pass on Windows; the macOS build is checked only by CI.
- [x] `docs/native-shells.md` lists four app commands; there are now five (add `icloud_supported`). Fixed in PR #27.

### #23 Language-aware menus

- [x] The built-in Cloze and Sentence note types tag their fields ja/en Fixed in PR #29., so Korean and Chinese cloze/sentence decks wrongly activate the ja/en options.
- [x] New flip layouts get `hide_furigana_on_front: true` only for a Japanese deck that isn't typed or draw mode. Stored layouts are unchanged.
- [x] `useActiveLanguages` shares one module-level import, which resets if the chunk fails to load.
- [x] An explicit `initialDrawOpen` shows the draw pad even with no CJK language active; the pad defaults to Korean (Hanja). No caller passes it today.

### Unverified overall

- [ ] On-device QR scans and deep links.
- [ ] Real iCloud sync and signed Mac builds.
- [ ] Real Graph/OneDrive.
- [ ] The Capacitor and Tauri shells were not run for #23.
