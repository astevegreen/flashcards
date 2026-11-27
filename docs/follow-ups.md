# Follow-ups

Open items left after the Phase 14 batch (Streams A–D, 2026-11-22). The owner's decisions of 2026-11-22 are recorded below; items marked **To build** are approved work. Tick an item off, or delete it, once it is resolved. Product decisions belong to the owner. Until one is made, the shipped default is the least-committal, reversible option described here.

## Phase 14 batch: what landed (2026-11-22)

- [x] **Secure-store bridge for phone tokens (release blocker): code complete, not yet built natively.** `@flash/capacitor-secure-storage` (`packages/capacitor-secure-storage`): iOS Keychain (after first unlock, this device only, no iCloud sync) and an Android Keystore AES-GCM key over app-private SharedPreferences. The Microsoft refresh token, the Google and OneDrive session access tokens and the BYO TTS config live only there. Older copies are migrated at launch. Phone OneDrive refreshes go through CapacitorHttp, because the capgo plugin writes refreshed tokens back to plaintext storage. Google on Android had the same problem: the plugin writes the ID and access token, but no refresh token, to plaintext SharedPreferences, and the app now deletes that copy. Google on iOS uses the SDK's Keychain. Evidence with file and line: `docs/native-shells.md` "Phone secure storage".
- [x] **Android Microsoft redirect:** Custom Tabs (`androidUseCustomTabs`) plus a `flashcards://oauth` intent filter. The plugin checks state and PKCE natively. Android Auto Backup now excludes the token SharedPreferences files.
- [x] **"Sync my devices":** one button in Settings, on the empty screen and in the one-time prompt. iCloud is the default where an iCloud transport exists (iOS only today); Google Drive is the default elsewhere. The other providers are listed below it.
- [x] **Add-device QR code and link (web build):** they carry the provider code and the manifest `collection_id` only. The receiving device parses them against an allow-list, strips them from the URL, and never shows onboarding while it joins a collection. Native shells first showed text instructions only; they now show a QR code and a `flashcards://add-device` link too (PR #20, see below).
- [x] **Guided "Bring my cards" import** in the Library. Detection reads the content, not the extension: Flashcards Deluxe/plain CSV and TSV, Anki `.apkg` (anki2/anki21/anki21b), `.flashpkg`, and Google Sheets links. It routes to the existing importers. Non-UTF-8 CSV and `.xls` files get a "Save as CSV UTF-8" hint.
- [x] **Curated starter decks (partial):** "Korean Starter: Beginner Words" (145 notes: the NIKL 2003 level-A list under KOGL Type 1, with English meanings from Wikidata lexemes under CC0) and "Mandarin Basics: Common Characters" (150 characters from Unihan 17.0.0 under the Unicode License v3). Both are built by `scripts/build-starter-decks.mjs`, load lazily, and are attributed at deck level (deck description, Settings > About & Open Data Licenses, `THIRD-PARTY-NOTICES.txt`); since 1.2.0 no card carries a credit in its Notes field. Japanese and English keep their sample decks (see the decisions below).
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

- Moved to "Needs the owner (hands-on)", under "Real devices and services".

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

### Perf batch notes (PR #69, P2-P7 of the 2026-11-25 review)

- [x] `packages/core/tests/deck-organization.test.ts` "two devices' concurrent edits reach every member deck" fails on main too with seed -751377563, path "20:1:9:9" (counterexample: A sets `max_reviews_per_day` 1, B sets 200, no weights): a deck's settings don't match the merged preset. Find the merge-order bug, then pin the seed as a regression case. Fixed: an edit skipped its deck copy where the deck already held the new value (200 is the default), so A's concurrent copy won on the decks while B won on the preset. Edits now always copy the fields they change; the case is pinned in the same file.
- [x] P6: with no stroke pack installed, the recognizer's cache key is the deck-stroke count, so re-caching a character with corrected strokes keeps the old index until reload. Key it by count plus latest `updatedAt`. Fixed in #82: with no stroke pack the key is the count plus the latest deck-stroke write (a kv row that `putSingleStroke` keeps current), tested with the fake and with real Dexie.
- [x] P4: no test pins that a shared ts-fsrs scheduler stays deterministic with `enable_fuzz: true` (same inputs in a different call order give the same output). Add one before the next ts-fsrs upgrade. Added in #82: a shared scheduler with `enable_fuzz: true` gives the same results whatever the call order.
- [x] P3: only `keepSyncStateIfUnchanged` is tested; a render-count test of `useApp()` consumers on an unchanged sync tick would cover the wiring. Added in #90.
- [x] The P2 and P4 perf tests log timings but assert none, and replay 20k cards on every `pnpm test`. Shrink them or move the timings to a bench script. Done in #82: `pnpm test` now checks a read-count bound on 2k cards, and the 20k-card timings run in `pnpm bench` (`vitest.bench.config.ts`).

### Agent tooling: agy merge-gate gaps (agy's notes on PR #65, 2026-11-25)

These live in code ported from Terminal Dusk, so fix them when the four agy copies are brought to one version:

- [x] `tools/gemini/rails.mjs` `findings()`/`decide()`: a review whose tags don't start a line ("Blocker:", "**blocker**") reads as no findings and merges. Return `retry` when no tagged line is found and the answer is not "No findings." Done in #94: an answer with no tagged line that is not "No findings." now retries.
- [x] `railHits` reads only the `b/` path of `diff --git`, so renaming a rail out of its folder (say `.githooks/pre-push` to `docs/`) skips the rail audit. Check the `a/` path too. Done in #94: `railHits` checks the `a/` path of a rename too.
- [x] `tools/gemini-audit.mjs` puts a linked issue's body into agy's material without checking its author. Port Terminal Dusk's `github-trust.mjs` filter. Done in #94: a linked issue is trusted only from the owner and write, maintain or admin collaborators.
- [x] `tools/gemini/agy.mjs`: `DEEP_PATHS` defaults to Terminal Dusk's paths (the audit passes Flashcards' list, so there is no effect today), and `newerFirst` uses `localeCompare` (pinned to `en`, tooling only). Fix both or comment why. Done in #94: both fixed.
- [ ] The prepare script's shared `core.hooksPath` reaches every worktree, including a branch cut before `.githooks/` existed, which then runs no hooks. Fine once those branches merge main.

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

- Moved to "Needs the owner (hands-on)": the real export check.
- Moved to "Needs the owner (hands-on)": the upstream download and measurement.
- Moved to "Needs the owner (hands-on)": KRDict audio licence.
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
  - Moved to "Needs the owner (hands-on)": the Apple developer account.
- [x] **#18, provenance (PR #28):** an "App" badge, with attribution tooltips on every badge. the 춥다 and 먹다 rewording is accepted. Hand-written definitions get their own badge instead of KRDict's.
- [x] **Starter-deck gloss report (#16), applied in PR #28:** `content/starters/gloss-overrides.json`, decks at 1.1.0; four readings corrected after review (아니, 长, 呐, 地). Not reviewed by a native speaker. accept every suggested fix in `docs/starter-gloss-review.md`, applied through `scripts/build-starter-decks.mjs` (never by hand-editing the generated decks).
- [x] **Dependabot PR #4 (TypeScript 6):** merged (`05af924`).
- Moved to "Needs the owner (hands-on)": KRDict audio licence.
- [ ] **Share-alike dictionary sources. Approved:** 우리말샘 (`dict-urimalsam`, CC BY-SA 2.0 KR) and Kaikki Wiktionary Korean (`dict-kaikki-ko`, CC BY-SA 4.0) as optional, separately licensed download packs with attribution (their share-alike terms apply to those packs, not the app). 표준국어대사전 is not approved yet. **kengdic stays out** (unclear licence). **Pipeline built** (schema, attributions, UI sense badges, `parseUrimalsamJson`/`parseUrimalsamXml`/`parseKaikkiKoJsonl`, `fetch-upstream-packs.mjs`, `build-packs.mjs --full` with automatic sharding); still needs manual upstream downloads in `.cache/upstream-open-data/{urimalsam,kaikki-ko}/` to build and publish the full packs.
- [ ] **Commercial Korean–English dataset as a premium pack:** deferred until after launch.
- [x] **Auto-archive on PR close:** turned back on.

## Anki feature gap: owner decisions (2026-11-23)

On 2026-11-23 an agent compared the app with Anki, about 25 features. This section leaves out items already decided: raw HTML/CSS templates (the security rule), `.colpkg` and seeding FSRS from Anki scheduling (see "Anki extras" above). Ruby, furigana and pinyin already exist (`packages/core/src/parsers/`). The owner has not yet discussed card-level controls (forget, set due date, reposition, bury, flags, card info), the FSRS extras (editable steps, easy days, load balancing, simulator, answer timer) or a typed search syntax. The approved items were built on 2026-11-23 in PRs #33–#42; see "Next after the Anki-gap batch" at the end of this section.

### To build

- [x] **Automatic rolling backups (first priority of this list).** Sync is not a backup: a deletion or a bad import syncs to every device and to the cloud copy. Built in `packages/core/src/backup/` and Settings > Automatic backups (`packages/ui/src/backups/`):
  - A dated snapshot about once a day the app is used, only when the collection changed. The newest 14 are kept, plus the newest full one. A snapshot is a valid `.flashpkg` (any build imports it) with `backup/state.json`, the full state with review history, beside it.
  - Daily snapshots carry no media. They list the content hashes they use, and media cleanup must keep those. A weekly full snapshot packs the media, when it totals 100 MB or less.
  - Restore is previewed and confirmed. It appends new events from this device that bring the collection back to the backup, so it syncs like any edit. Nothing is deleted: decks and notes the backup lacks are archived. A `pre-restore` snapshot is taken first, so a restore can be reverted. Reviews made after the backup are always kept.
  - Optional copy in the sync folder (`backups/v1/<device>/day-<weekday>.flashpkg`, no media). The 7 weekday slots overwrite, so no transport needs a delete. Settings lists every device's copies for restore.
  - Web: backups live in IndexedDB and persistent storage is requested. OPFS was not used: it shares IndexedDB's quota and eviction, so it adds nothing. The off-device copies are a downloaded file and the sync folder.
  - The reminder still shows for users who don't sync. Automatic snapshots never count as a backup for it; downloading one does. "Export Backup" now writes the same format with media, so a manual backup keeps review history too.
- [x] **Check media and check database.** Built in `packages/core/src/check/` and Settings > Check collection (`packages/ui/src/check/`):
  - Check media lists stored files nothing uses and files notes or pages reference that this device lacks. A file counts as used when any note (archived too), page, deck, note type, layout, course or option mentions `media:<sha256>`. Cached spoken audio is never offered.
  - Removing unused files is confirmed. A new `MediaRemoved` event takes them out of the collection on every device (a later `MediaAdded` of the same file wins, in any order). The stored file is deleted unless a kept backup lists it; it goes once that backup rolls off.
  - An edit that starts using a file adds it again (`MediaAdded`) right after the edit, so the newer use beats a removal another device decided before the edit synced. Check media also lists used files the collection no longer lists ("Add back to the collection") and, with sync on, offers "Sync now and check again" for missing ones.
  - Check database rebuilds the collection from the event log and lists differences by area. When the log lacks history another device folded into a snapshot, it rebuilds from the saved snapshot instead and says so. After a full rebuild with differences, "Rebuild from history" saves it as this device's starting point and reloads. The log itself is never changed.
  - Not done: unused files are not deleted from the sync folder, since the transport has no delete. Empty-cards cleanup only if optional cards (below) ship.
- [x] **Optional cards (PR #34).** One rule per layout: make this card only when field X is filled (`Layout.required_field`, set in Library > deck Options > "Layouts: optional cards"). No template conditionals. A card with active reviews whose field is emptied is kept: it is hidden from Study, has only the Empty state in Browse (badge and "Empty" filter), and comes back with its schedule when the field is filled again. Reviews stay in the event log in every case. A rule on a field the note type lacks, or on a cloze layout's own text, is ignored (import drops it with a warning; the settings list flags it). Snapshots saved by older builds are re-derived on load. Stroke data from the offline packs is per device, so it can't decide which cards exist; a writing card can only depend on a note field.
- [x] **Duplicate finder across decks (PR #36)**, on the note's key field, for imported lists (HSK, JLPT) that overlap the user's own decks. Browse > Find duplicates groups notes whose key field matches after NFC, trimming and ruby stripping (`@flash/core/duplicates`), with Open, Tag "duplicate" and Archive. No merge.

- [x] **Shared deck option presets.** Built: a deck uses a preset (new cards/day, max reviews/day, target retention, FSRS weights) or its own settings, and the optimizer can pool a preset's decks. Defaults under "Decisions needed (deck presets and folders)".
- [x] **Deck folders instead of Anki subdecks.** Built: one level of folders in the Library, with "Study folder". Daily limits stay per deck.
- [x] **Deck descriptions.** Built: a plain-text description per deck, edited in deck options and shown on an overview before study. Starter decks and `.flashpkg` packages (so Family Library decks) bring one. Defaults under "Decisions needed (deck descriptions)".
- [x] **Limited rich text in the field editor.** Strict inline markup in the plain field string: `{b:…}`, `{i:…}` and `{red:…}`, `{orange:…}`, `{green:…}`, `{blue:…}`, `{purple:…}`, parsed in `packages/core/src/parsers/rich-text.ts` and rendered as React elements by `RichText.tsx`, never as HTML. It works with ruby and cloze (`{b:日本[にほん]}`, `{{c1::{b:word}}}`, `{b:{{c1::word}}}`); notes without it render as before. Answer matching, TTS, choice dedupe and draw grading ignore it; `stripRichText` is exported for the export and duplicate-finder work. The editor has a B / I / colour toolbar under the focused field, Ctrl/Cmd+B and Ctrl/Cmd+I, and a preview line. Defaults under "Decisions needed (2026-11-23 field editor)".
- [x] **Paste images into fields.** Pasting or dropping an image on an image field's drop zone in `NoteEditDialog.tsx` goes through the same `processImage` → `addMedia` path as the file picker, with the same type and size checks (`editor-paste-image.spec.ts`). Defaults under "Decisions needed (2026-11-23 field editor)".
- [x] **Find and replace across notes.** Browse > select notes > **Find and replace…** (`FindReplacePanel.tsx`, lazy). Planned in `@flash/core/find-replace` and appended as one batch of `NoteUpserted` events carrying only the changed fields, with a live count and preview. **Undo replace** puts the old text back in each field that still holds the replaced text. Defaults under "Decisions needed (find and replace)".
- [x] **Redo after undo.** Study shows **Redo** after an Undo (also Ctrl/Cmd+Shift+Z and Ctrl+Y). `redoLastUndo` (`AppContext.tsx`) records the undone review again under a new id with its original time, answer and FSRS version, so replay gives the card the schedule it had before the Undo, and re-applies the leech suspend and tag that review made. Initial bundle +0.28 KB (156.32 KB gz).
  - [ ] Default: a new answer ends the redo history; redo is refused once the card has a newer review (for example, synced from another device); FSRS reviews only, practice sessions keep their one-way Undo; up to 50 entries, cleared with the undo stack after a restore.

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
- [x] **`.apkg` review history (follow-up):** the `.apkg` now carries one `revlog` row per active review and each card's scheduling and FSRS memory state from replay, so a user who leaves keeps their history and intervals (`packages/core/src/export/anki/scheduling.ts`). Defaults under "Decisions needed (Anki export)".

### Next after the Anki-gap batch (2026-11-23)

In priority order. Items already recorded elsewhere in this file are only pointed to here.

1. [x] **Size headroom first.** Initial study-screen JS is about 159.3 of 160 KB gz after #42. Before the next feature lands, move something out of the initial bundle (a lazy chunk for a Library-only panel, say) and get back to at least 3 KB headroom. Done: the web platform's on-demand service getters load from one lazy `lazy-services.ts`, and code only lazy screens use was split out of modules Study imports (filter presets and lists, snapshot upgrades, HLC merge, content hashes, UTF-8 decoder, add-device link building, pack languages). Now 156.01 KB gz (4.0 KB headroom).
2. [x] **Presets, folders and descriptions in `.flashpkg` and backups.** Built: the manifest carries the presets and folders the exported decks use (`packages/core/src/import/flashpkg-groups.ts`), and restore now plans presets, folders, deck placement and descriptions (`packages/core/src/backup/restore.ts`; before, `state.json` held them but restore wrote nothing for them). Rules under "Not in `.flashpkg`" (now "Packages") in presets and folders, "Packages" in deck descriptions, and "Restore of presets, folders and descriptions" in rolling backups.
3. [x] **Rich text in duplicate keys and Anki export (#45).** `normalizeDuplicateKey` strips the markup, so `{b:학교}` matches `학교`. The Anki CSV and `.apkg` writers convert it by default with `ankiRichTextToHtml` (`packages/core/src/export/anki/rich-text-html.ts`). Plain CSV keeps the markup, the same as ruby and cloze, so it round-trips into this app; `exportCsv({ stripRichText: true })` is an opt-in that nothing in the UI sets.
4. [x] **`.apkg` review history.** The revlog item above.
5. [x] **Streaming export on native.** New optional `Files.saveStream(name, mime)` returns a `FileSink` (`write`/`close`/`abort`). Tauri asks for a save location, then appends each chunk with the fs plugin; abort truncates the file to empty; Capacitor appends to a cache file (chunks joined to about 512 KB per bridge call), then opens the share sheet. The Anki CSV zip and `.apkg` exports use it when there is no `downloadBlob` (web is unchanged); others keep `downloadFile`. The backup `.flashpkg` download is streamed too since item 8. Not run on a device: item 7 below.
   - [ ] Default: cancelling the save dialog shows "Export cancelled." as a status line, not an error (`ExportCancelledError`, `packages/ui/src/export/exportCancelled.ts`), for the Anki exports, both Export Backup buttons and a snapshot's Download.
   - [x] Library > Export Backup writes the same backup file as Settings (`saveFullBackupFile`: `backup/state.json` with review history, streamed on native). Before, it wrote a plain `.flashpkg` without history.
   - [x] **Backpressure (2026-11-23):** `emit` may return a promise. `AnkiZipWriter.flush()` waits for every pending one, and the `.apkg` and Anki CSV writers flush before reading the next media file, so a disk slower than the zip holds at most one media file in memory. `saveStreamedZip` returns its write queue from `emit`.
   - [ ] Default: a cancelled or failed desktop export leaves an empty file at the chosen path. No `fs:allow-remove` capability was added, since the app avoids delete powers in the user's folders. Capacitor deletes its cache file.
6. [x] **Missing tests:** `whenSaved()` and the reload prompt (backups), an e2e test with two image fields on one note, and the duplicate panel recompute (see that item). Done as e2e specs `rebuild-reload-prompt`, `editor-paste-two-image-fields` and `duplicate-finder-live`. The queue behind `whenSaved()` moved to `packages/ui/src/state/persistQueue.ts` and has unit tests (`persist-queue.test.ts`: whenSaved waits for a slow write, for writes queued meanwhile, and survives a failed write).
7. [ ] **Real-world checks no CI run covers:** import both exports into real Anki (desktop and AnkiDroid); backups and media check on a real phone; two-device sync of presets, folders, descriptions and `MediaRemoved` through a real cloud folder.
8. [x] **Leftovers from items 1–6 (2026-11-23), done the same day:**
   - [x] **Backup download streamed.** `packBackupStream` and `withBackupMediaStream` (`packages/core/src/backup/archive.ts`) hand each chunk to a sink and wait for it before packing more; `packBackupAsync` and `withBackupMedia` keep their one-array results. Settings > Export Backup (`saveFullBackupFile`) and a kept backup's Download (`saveStoredBackupFile`, `packages/ui/src/backups/backupRunner.ts`) go through `saveStreamedZip`: Blob parts on web, `Files.saveStream` on desktop and phones. A snapshot that already holds its media is passed on in 512 KB slices. The media itself is still read into memory before packing, as before. Not run on a device.
   - [x] **`.apkg` day anchor.** `planAnkiApkgExport` takes `tzOffsetMinutes` (minutes east), and the UI passes `-new Date(nowMs).getTimezoneOffset()`, so `crt` and due days use the offset at export. Without it (CLI, tests) the latest review's offset is used, as before.
   - Size: the initial study-screen JS is 156.03 of 160 KB gz (unchanged by this batch). The next ~0.7 KB would mean touching boot code, not just moving lazy-only code (#44).
   - [x] **Dependabot alerts 1 and 2 (glob, minimatch):** `pnpm-workspace.yaml` overrides `workbox-build>glob` to `^14.0.2` (workbox-build pinned glob 11, whose minimatch 10 was also flagged). glob 14 keeps the `globSync` API workbox-build calls; the PWA build is unchanged.
   - Moved to "Needs the owner (hands-on)": the `glib` alert.

## Decisions needed (2026-11-23 batch)

Defaults the 2026-11-23 agents picked. Each stays shipped until the owner decides.

- [ ] **PR #27, iOS loss marker location:** the app's SQLite database, not UserDefaults (same backup behaviour, plain TypeScript). Markers are iOS-only; Android relies on its plugin's own Keystore-loss report.
- [ ] **PR #27, Mac entitlement check:** only checks that an iCloud entitlement exists, not that it names `iCloud.app.flashcards.localfirst`. A launch-probe timeout counts as unknown: Google Drive stays the default, with no "iCloud Drive looks off" hint.
- [ ] **PR #28, gloss choices:** 해 stays "year (counter)" without "sun"; every numeral is labelled native or Sino-Korean; 팔 fronts get no hint. Every sense in the hand-written starter KRDict fixture (dev and tests only) now gets the App badge, not just 먹다 and 춥다.
- [x] **PR #28, existing starter decks:** devices that already loaded the 1.0.0 starter decks keep the old glosses (there is no upgrade path). Done in #83: a launch step upgrades decks seeded from an older release (see "Burn-down wave 2 follow-ups" and "Decisions needed (burn-down, 2026-11-26)").
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
- [ ] **Not changed by the rich-text PR:** Browse search (`packages/core/src/tags/browse.ts`) still matches on the raw text, so a word inside a span is found but a phrase across a span edge isn't. `.flashpkg` keeps the markup as typed; plain CSV keeps it (opt-in strip exists) and the Anki exports map it to `<b>`/`<i>`/colour (see "Decisions needed (Anki export)").

## Decisions needed (optional cards and duplicate finder, 2026-11-23)

Defaults picked while building two items of the Anki feature gap list. Each stays shipped until the owner decides.

- [ ] **Optional cards, empty field:** a card is made only when the field has a non-whitespace character. A card with no active review is simply not made (nothing to lose); one with reviews is kept as Empty. Undoing an Empty card's last review removes it. Empty cards count in stats history but not in the due forecast. No built-in layout has a rule, so existing collections are unchanged.
- [ ] **Optional cards, scope:** the rule lives on the layout, so it applies to every deck that uses the layout (built-in layouts included), like the ruby setting. It is not per deck; the deck Options list says so.
- [ ] **Optional cards, cloze:** no rule on a cloze layout's text fields. Emptying the text would change which c1/c2 variants exist, so studied cloze cards could not be kept as Empty.
- [ ] **Empty-cards cleanup** (in "Check media and check database"): not built. Empty cards hold review history, so nothing is deleted; Browse lists them with the Empty filter.
- [ ] **Duplicate finder, what matches:** the key field is the note type's `sortKey` field (else the first field), so two note types of one language can share a group. Keys are compared after NFC, folding full-width Latin and digits, half-width katakana and Hangul, and compatibility jamo (NFKC on those runs only; circled numbers and unit squares stay as they are), ruby reduced to one side (the base, but the Hangul side in Korean decks, so `學校[학교]` matches `학교`), trimming and collapsing inner spaces; case is kept. Notes only match within one deck language (`学校` in a Japanese and a Chinese deck is not a duplicate). Archived notes and archived decks are left out.
- [ ] **Duplicate finder, scope:** "Only across decks" is on by default; unticking it also lists repeats inside one deck. The field editor's rich-text markup is stripped before comparing (`{b:학교}` matches `학교`, cloze answers included).
- [ ] **Duplicate finder, actions:** Open (the note editor), Tag "duplicate" on the whole group (set-union `NoteTagsAdded`, so a concurrent tag edit is never overwritten), and Archive per note (history kept, restorable). **No merge:** cards are keyed by note id, so merging two notes' review histories would need a new event, not a cheap or safe change.
- [x] **Follow-up:** the duplicate panel recomputes every group on each state change while it is open (`DuplicateFinderPanel.tsx`). Behaviour is now pinned by `duplicate-finder-live.spec.ts` (an edit that breaks or creates a duplicate updates the groups). The code is unchanged: grouping needs the whole collection, so a per-note memo is not a small change. Revisit only if large imports feel slow.

## Decisions needed (Anki export)

Defaults picked for "Export for Anki". Each stays shipped until the owner decides.

- [ ] **CSV columns:** GUID, note type, deck, one column per field (named after the field label, without the characters Anki forbids), tags. Header lines: `#separator`, `#html:true`, `#columns`, `#guid column`, `#notetype column`, `#deck column`, `#tags column`. No BOM, because the header lines must start the file.
- [ ] **Note type column:** names this app's note type. Anki skips rows whose note type it doesn't have (it creates missing decks, not note types), so the README says to create the note type first or to use `.apkg`. The other option: leave the column out, and Anki's import window asks for a note type.
- [ ] **GUID:** a note imported from Anki gets its original GUID back, so the profile it came from gets no duplicate. Anki updates it only when it arrives with the note type it has there; under another note type it is a conflict, and Anki skips it unless "Merge note types" is ticked. Other notes use their own id.
- [ ] **Media file names:** `<sha256>.<ext>`, in `collection.media/` inside the zip (Anki's text import copies no media). Media this device doesn't have is left out and counted in the message. Only the importers' media types (png, jpg, webp, gif, mp3, ogg, wav, m4a) are written; any other extension counts as missing. The zip is written one file at a time into Blob parts (stored media, deflated text), so a large audio deck is never held in memory twice; the native apps still get one array at the end.
- [ ] **Text as HTML:** `<`, `>`, `&`, `"` are escaped, line breaks become `<br>`, and literal `[` / `]` are written as `&#91;` / `&#93;`, so Anki's furigana filter can't turn `test[abc]` into ruby. Ruby becomes ` base[reading]`. A space of the text right before a base is written `&#32;` (Anki consumes the literal space as the base marker), and a space inside a base is `&#160;`.
- [ ] **Tags:** spaces inside a tag become `_` (Anki separates tags with spaces); `::` hierarchies are kept.
- [ ] **Rich text:** the Anki CSV and `.apkg` writers convert the field editor's markup by default (`ankiRichTextToHtml`, `packages/core/src/export/anki/rich-text-html.ts`): `{b:…}` to `<b>`, `{i:…}` to `<i>`, colours to `<span style="color: #xxxxxx">`; text stays HTML-escaped and ruby, cloze (`{{c1::<b>word</b>}}`) and media keep working. Plain CSV keeps the markup as typed, the same as ruby and cloze, so it round-trips through `buildEventsFromCsv`; `exportCsv` has an opt-in `stripRichText: true` for a copy other apps will read (nothing in the UI sets it yet). `.flashpkg` keeps it too.
- [ ] **Anki colours:** the light-theme shades of `.rich-*` are written inline: red `#dc2626`, orange `#c2410c`, green `#15803d`, blue `#2563eb`, purple `#7c3aed`. The dark-theme shades are not exported, because Anki fields carry no theme.
- [ ] **Anki cloze hints:** markup inside a cloze hint (`{{c1::a::{b:hint}}}`) is converted like the answer. Anki inserts the hint's HTML as is, so a hint with markup shows styled in Anki but unstyled in the app. Kept as is: the hint is still converted.
- [ ] **`.apkg` format:** the legacy `collection.anki2` (schema 11) plus the JSON `media` map. Every Anki since 2.1 (desktop, AnkiDroid, AnkiMobile) imports it; the newer `anki21b` needs zstd and protobuf writers for no gain here.
- [ ] **`.apkg` ids:** a note type imported from Anki gets its Anki id back (and its card types keep their Anki order), so in the profile it came from Anki can update those notes while the note type's fields and card types are unchanged. The export message says so when the package has notes from Anki. Other note types and all decks get ids hashed from this app's ids, so a second export of the same deck matches them in Anki. Note and card ids count up from the export time. GUIDs follow the CSV rule above.
- [ ] **`.apkg` templates:** one card template per layout enabled in the exported decks (all layouts if none is enabled). The front shows the front fields (`{{kanji:…}}` when a layout hides furigana on the front, `{{furigana:…}}` otherwise), typed layouts add `{{type:…}}`, the layout's spoken field gets `{{tts …}}` on the front or the answer, following when the layout speaks. Choice, listen and draw layouts become plain flip cards. A note type with a cloze layout becomes an Anki cloze note type with only that template, and the message warns when other layouts were dropped.
- [ ] **`.apkg` cards:** all new, in note order; suspended cards stay suspended. Parent decks are created for `::` names. Superseded by the review-history lines below, except for cards with no active review.
- [ ] **`.apkg` review history on by default:** `includeReviewHistory` defaults to true. The deck's Options menu runs the export straight away and has no dialog, so there is no "Include review history" tick; the message says how many reviews came along.
- [ ] **`.apkg` revlog rows:** one per active review (undone ones left out), in replay order `(reviewed_at, hlc, review_id)`. The id is the review time in ms, moved up 1 ms past the previous row on a collision. `ease` is the rating, `ivl` / `lastIvl` are days or negative seconds for (re)learning steps, `type` is 0 learn / 1 review / 2 relearn from the state before the answer. No type 3 (filtered) rows: practice answers (`PracticeRecorded`) never reach FSRS here, so they are left out. `time` is the answer time capped at 60 s (Anki's default `maxTaken`). `col.conf.schedVer` is 2, so Anki (and this app's importer) reads learning eases as 1-4.
- [ ] **`.apkg` card scheduling:** from replay. Learning and relearning cards are queue 1 with `due` in epoch seconds and `left` from the remaining ts-fsrs steps (1m 10m / 10m, the same as the exported deck options); review cards are queue 2 with `due` as a day number relative to `crt`, counted in the user's study days. A relearning card's `ivl` is its stability rounded, an approximation (its interval only at 90 % retention). `factor` is 2500 once a card has reached review, else 0; Anki's FSRS ignores it. `cards.data` is `{"s","d","dr","decay","lrt"}` (s to 4 places, d to 3, dr to 2, decay to 3 from `w[20]` or the FSRS-6 default 0.1542, `lrt` the last review in Unix seconds), which current Anki reads as the FSRS memory state. `dr` is the deck's current retention.
- [ ] **`.apkg` crt:** the start of the user's current study day, in one collection-wide offset (the latest active review's, else UTC) and `preferences.day_start_hour` (deck overrides ignored). `col.conf` gets `rollover` and `creationOffset` (minutes west), so Anki's "today" for the package is 0 and its importer's `source_today - target_today` shift lands review cards on the right day in any time zone.
- [ ] **`.apkg` Empty and buried cards:** a card marked empty (optional card whose field was cleared) is exported new, without its history. The app has no stored bury (sibling burying is worked out per day), so nothing is exported buried. When two cards share one Anki ord (a cloze note without markers), the one with more reviews keeps its history.
- [ ] **`.apkg` writer:** SQLite is written with sql.js in a short-lived Web Worker, reached through the existing lazy Anki service (`AnkiPackageReader.writeCollection`) rather than a new platform getter, so the study-screen bundle doesn't grow. A write that fails or doesn't answer within 5 minutes is stopped with an error. The package is streamed like the CSV zip and downloaded as `application/octet-stream`.
- [ ] **Importer:** `[ ] { } |` written as entities (`&#91;`, `&#124;`, …) in an Anki field never form ruby or cloze, as in Anki. They come back as the literal characters when that changes no ruby or cloze (so `test&#91;abc&#93;` stays `test[abc]`), and as fullwidth lookalikes (`［］｛｝｜`) when it would (`漢字&#91;かんじ&#93;` becomes `漢字［かんじ］`).

## Decisions needed (find and replace)

Defaults picked while building find and replace. Each stays shipped until the owner decides.

- [ ] **Scope:** the notes selected in Browse (select-all takes the visible list). Only text fields are searched (`text`, `reading`, `rich`), one field or all of them. Tags are not searched; the tag manager renames tags.
- [ ] **Media stays safe:** image and audio fields are never searched, and `media:<sha256>` references inside a text field are never matched or changed.
- [ ] **Literal by default:** case-insensitive, with **Match case** and **Regular expression** (JavaScript syntax, `$1` / `$<name>` / `$&` in the replacement). Ruby, cloze and rich-text markup are searched as typed, so a replace can change markup. A zero-length match (`^`, `x*`) replaces nothing. Find and replace text are NFC-normalized.
- [ ] **Undo:** one level, for the last replace while the panel is open. A field edited since (here or synced in) keeps its new text. Not the study undo stack.
- [ ] **Linked decks:** notes in decks fed by a Sheet, folder or package are changed too, with a warning that the next refresh may bring the old text back.
- [ ] **Provenance:** a replace leaves the note's provenance as it is (the note editor marks edited notes as reviewed).

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
- [ ] **Packages:** `.flashpkg` export writes the presets and folders the exported decks use (`manifest.presets`, `manifest.folders`, `decks[].preset_id`, `decks[].folder_id`; all optional, so older packages stay valid and older builds ignore them). Import never overwrites what the user has. Each package preset or folder resolves once: a live one with the same id is used as it is; else a live one with the same name (trimmed, exact match, first by name then id); else none if this collection once deleted that id (a delete is final); else a new one with the package's id and values. A deck the import creates joins the preset and folder; joining copies the preset into the deck as the Library does (limits, retention, shared weights). An existing deck never joins a package preset, since that would overwrite the limits, retention and weights the user tuned on it; it joins a folder only if it never had a folder assignment, even a cleared one. Saves an import writes are marked `from_package`: per field, any preset or folder save the user wrote wins over every package save, whatever their HLCs (as for descriptions), so an import on a device that has not synced the user's edits never overwrites them. Package weights must be a 17, 19 or 21 vector inside the FSRS-6 model bounds, or the preset comes in without them.
- [ ] **Packages, name match:** a package preset named like one of the user's (for example two "Daily" presets) joins the user's, with the user's values, rather than adding a second preset with the same name. Matching uses what each device has: two devices that import before syncing can resolve a name differently and leave one extra preset with the same name.
- [ ] **Catch-up:** after each sync, and when the Library opens, the app compares every deck in a preset with the preset and copies the preset into any deck that differs. This heals a deck that joined during an edit elsewhere, a retention copy racing a weights copy, and an older build editing a member deck (the preset wins). It writes only real differences, and devices that agree on the preset write the same values.
- [ ] **Bundle:** initial study-screen JS 156.43 KB gz before, 156.63 KB after. The 0.2 KB is the post-sync catch-up trigger and lazy-chunk names; presets, folders, the catch-up itself and their UI load with the Library or after a sync.

## Decisions needed (deck descriptions)

Defaults picked while building deck descriptions. Each stays shipped until the owner decides.

- [ ] **Plain text only**, up to 2,000 characters, line breaks kept. Markup is shown as typed, never rendered. The limited rich text from the field editor item could be reused later.
- [ ] **Stored as its own event, not a `Deck` field:** `DeckDescriptionChanged` is log-retained and folded on demand, like the Study Set events, so the study-screen bundle does not grow and older builds keep the events. Last writer wins per deck; an empty description clears it.
- [ ] **Starter decks** use the catalog's description (for example "Beginner (level A) Korean words from the NIKL learning vocabulary list…"). Starter decks added before this build get none; there is no backfill.
- [ ] **Packages and backups:** `.flashpkg` export writes the deck's description in the manifest. Import fills it only for a deck that never had a description event, so a package update never brings back a description the user cleared. Package and starter descriptions are marked as such, and any description the user wrote or cleared wins over them, even from a device that has not synced the user's text yet. A Family Library `index.json` entry's own description is not copied; the deck description comes from the package manifest. A restore from backup writes the backup's description (or a clear) as the user's own text, so it wins over package descriptions.
- [ ] **Overview:** only decks with a description show it. Study on any other deck starts at once, as before. "Study folder" and "All decks" skip the overview.

## Decisions needed (rolling backups, 2026-11-23)

Defaults picked while building automatic backups. Each stays shipped until the owner decides.

- [ ] **How many and how often:** keep 14 snapshots. A new one when the newest is 20 hours old and the collection changed. The first check runs 8 s after launch, then hourly and when the app returns to the foreground.
- [ ] **Full snapshots:** weekly, only when media totals 100 MB or less (the `.flashpkg` import cap). Above that every snapshot is daily, and the media store and the sync folder hold the files. The newest full snapshot is kept even when older than the 14.
- [ ] **Restore mechanism:** new events that move the collection to the backup, not a separate collection. Decks and notes the backup lacks are archived. Reviews made since are always kept: the "Also undo the reviews made after this backup" option was removed, because undoing those reviews could not itself be reversed. Not restorable: a review undone after the backup, pages the backup lacks (pages have no archive), Study Sets and practice sessions, and deck fields added after this PR.
- [ ] **Reset keeps backups:** "Reset Local Device Data" leaves the backups on the device, so a reset can be undone, and keeps the images and audio a kept backup lists, so a daily snapshot restores whole. There is no "Delete all backups" button yet. Settings > Automatic backups says when no kept snapshot holds the media.
- [ ] **Pre-restore snapshots:** kept apart from the rolling 14, newest 3 only. The backup being restored is never pruned to make room.
- [ ] **Wrong clocks:** a snapshot stamped more than 10 minutes in the future is ignored for "due" and for the kind, and is pruned first.
- [ ] **Low storage:** old snapshots are pruned only after a new one is stored. On web a snapshot is skipped when `navigator.storage.estimate()` leaves less than twice its size plus 50 MB free. Phones and desktop have no reliable free-space figure (the WebView estimate doesn't count the SQLite file), so there, after a failed snapshot, only daily snapshots (no media) are taken until one succeeds. A skipped or failed snapshot never touches the event log; Settings shows the last error until the next snapshot succeeds. A snapshot still running after 10 minutes with the app visible is stopped before it stores, prunes or copies anything (hidden time does not count, and a hidden tab starts no automatic snapshot).
- [ ] **Restore and other devices:** when sync is connected, a restore pulls first. The confirmation says edits on a device that has not synced yet may survive it. The study undo stack is cleared after a restore.
- [ ] **Backup files are checked:** `backup/state.json` is validated (Zod, `@flash/content-schema/backup-state`) before a preview; a malformed value rejects the whole backup.
- [ ] **Phone storage:** archives sit in 1 MB chunks (`backup_chunks`), so no single SQLite parameter carries a whole backup. A failed write removes its chunks, and chunks without a backup row are swept when the backups are first opened after launch. Snapshots are zipped on the main thread in steps (fflate's async zip needs a `blob:` worker, which the CSP refuses).
- [ ] **Sync-folder copy:** off by default. One copy per device per weekday, without media. A restore from the sync folder needs the media in the sync store, or in the full snapshot of the device it came from.
- [ ] **Web storage:** IndexedDB with `navigator.storage.persist()`, requested by the backup check at launch, no longer by `AppContext` directly. When the browser refuses, Settings warns that backups can be cleared, and a one-time notice says so outside Settings (not shown when sync is connected).
- [ ] **Downloads:** "Download" on a daily snapshot adds the media from this device to the file. Downloading counts as a backup for the reminder.
- [ ] **Restore of presets, folders and descriptions:** a restore brings back each backup preset and folder with its name and values, puts every backup deck back in its preset and folder (or none), and writes the backup's description (or a clear). A preset or folder deleted since the backup can't come back under its id (deletes are final), and a preset's weights can't be cleared, so those come back as a new preset or folder with an id derived from the old one. Presets and folders made since the backup stay (nothing is deleted); the backup's decks just leave them. The confirm step counts these under "other settings".

## Decisions needed (check media and check database, 2026-11-23)

Defaults picked while building the checks. Each stays shipped until the owner decides.

- [ ] **Removal is an event:** `MediaRemoved` is a new event type, so removing a file reaches every synced device. Older builds keep the event unapplied and still list the file. A snapshot an older build wrote is folded on load; if that build also saw the same file added again after the removal, the re-add is lost (rare).
- [ ] **What counts as used:** any `media:<sha256>` anywhere in notes (archived ones too), pages, decks, note types, layouts, courses and options. Spoken-audio caches are never offered for removal.
- [ ] **Backups win over cleanup:** a file a kept backup lists stays on the device after removal from the collection, until that backup rolls off.
- [ ] **Sync folder:** removed files stay in the sync folder (no delete in the transport). A device that downloads the history before the removal may store the file again; Check media there removes it.
- [ ] **Rebuild from history:** offered only after a full rebuild finds differences. It rewrites this device's local snapshot and reloads, without touching the event log or other devices. No automatic check runs at launch. The reload waits for this tab's queued writes. Other open tabs of the same device show a "Reload now" prompt instead of reloading, so an open draft is not lost, and from then on they stop syncing and their edits write no snapshot over the rebuild. The rebuild and the compare run in steps, so the screen keeps responding.
- [ ] **Re-add on edit:** every edit that starts using a `media:` file emits one `MediaAdded` for it, even when the file is still listed (one small event per newly used file). If the code for it or a stored-file lookup fails, that re-add waits and is tried again on the next edit or sync, three tries at most; after that Check media's "Add back to the collection" covers the file.
- [ ] **Snapshots from before media removal:** the collection snapshot format is now version 2. A version 1 snapshot with media is not used to start a new device from the cloud (the segments are replayed instead), and at launch this device replays its own log instead when the log is complete. Otherwise the version 1 snapshot is used, and saved again as version 2 right away so later launches don't read the whole log first. Loading it gives an add record at its newest change for each file: a removal decided after the add but before that snapshot, arriving late, then keeps the file here while a full replay drops it (the safe side: nothing a note uses is lost).

## Leftover nits and known limitations

### #17 Ruby for Anki `kana:` / `kanji:`

- [x] Typed answers accept what the layout shows: `both` or no flag accepts the bases or the readings (so kana alone passes), `readings` accepts the readings or the bases, `bases` accepts bases only. The one place to make this stricter is `rubyReductions()` in `answer-match.ts`.
- [x] `matchTypedAnswer` has tests (`ruby-display.test.ts`): no ruby, each flag, romaji, alternates, pinyin and the "Expected" text.
- [x] Choice dedupe and draw grading use the layout's ruby flag. Still on bases: the deck-level stroke coverage in the Library, which has no layout.
- [x] Browse search matches a phrase across ruby groups in all readings or all bases (`わたしはにほん`, `私は日本`); a mix of the two doesn't match.

### #18 Dictionary

- [x] An exact `altForm` (or reading) hit now counts toward the guessed-lemma cap.
- [x] Only hits in allowed packs count toward the cap.
- Moved to "Needs the owner (hands-on)": the upstream download and measurement.
- [ ] The `SenseRelation` attribute (`lemma` / `writtenForm`) is unverified against a real export.

### #19 Linked OneDrive sources

- [x] The 4 SonarCloud items: `handleApplyReconciliation`, `linkOneDriveFile` and `refreshSingleOneDriveSource` are split into helpers. The OneDrive refresh loop stays one file at a time on purpose (downloads of up to 50 MB, Graph throttling) and carries `NOSONAR (S9382)`. The complexity counts were done by hand; Sonar hasn't been run on it.
- [x] **Unlink syncs** through a new `SourceUnlinked` event, for Google Sheets, Google Docs, OneDrive and `.flashpkg` URLs. It shares the last-writer-wins slot with `SourceLinked`, and builds that don't know it keep it as unknown and fold it in when they load a snapshot. Folders and catalogs stay per device. Known gaps: a relink recorded by another device before it receives the unlink wins; builds without the event keep re-listing the source; a `.flashpkg` subscription saved on another device isn't pruned.
- [x] Refreshing or applying to an archived deck shows a "Deck archived" pill, and Refresh all lists it under "Not refreshed". Google Sheets on archived decks are no longer refreshed at all, the same rule as OneDrive. Linked local folders now skip the `.csv`/`.tsv`/`.xlsx` files of an archived deck too (a `deck_archived` warning, read again after a restore), and Apply & Import on one keeps the prompt and asks for a restore first.
- [ ] Real Microsoft Graph is unverified.
- [x] `.xlsx` links on phone and Tauri shells show a "Can't read here" pill and are listed under "Not refreshed". No error banner.

### Linked Google Drive files (Android testing follow-up, 2026-11-25)

- [x] **"Link from Google Drive"** (was "Link Google Sheet / Doc") picks Sheets, Docs, and `.csv` / `.tsv` / `.xlsx` / `.flashpkg` files with the same Picker and `drive.file` scope (web, Capacitor and Tauri through `picker.html?mode=drive_files`). Table files get the column-mapping step and refresh like linked OneDrive files (read-only, first-field matching, rename reconciliation, `md5Checksum` change check, 50 MB cap); a `.flashpkg` re-imports when it changes. Code: `packages/ui/src/sources/googleDriveFileSource.ts`, `packages/platform-web/src/sources/google-drive-files.ts`.
- [x] **Platform-aware Sources copy:** the description and the empty-list hint list only the providers available in this build (`sourceProviders.ts`). Dev builds (`isDevMode`) show missing providers (Google, OneDrive, Dropbox, the Picker key) as disabled buttons naming the env var; production builds hide them.
- [ ] Real Google Drive is unverified for plain files: the Picker MIME filter (especially how `.flashpkg` and Windows `.csv` uploads are typed), `alt=media` CORS from the Capacitor WebView, and `drive.file` access on a second device. Hosted `picker.html` (`mode=drive_files`, with CSP-safe external `picker.js`) is deployed at `https://flashcards-localfirst-dev.yodc.workers.dev/picker.html` and confirmed opening Google Picker from Windows Tauri.
- [x] `LinkedFileMapping.tsx` and `OneDriveLinkMapping.tsx` merged: `OneDrivePickerPanel.tsx` now uses `LinkedFileMapping.tsx` and `OneDriveLinkMapping.tsx` is removed.
- [x] Linking a `.flashpkg` from Drive now checks the free-tier deck limit against every new deck the package adds before storing media or emitting events (`pullDrivePackage` in `googleDriveFileSource.ts`).
- [x] Sign-in is checked per refresh; "Refresh all" skips Drive files (like Sheets) while Google is disconnected, without a row message. Done in #80: Refresh all lists a disconnected Drive file with a row message. Sheets and Docs still skip it silently (see the wave 2 follow-ups).

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

- [ ] On-device QR scans and Android/iOS deep links (Windows Tauri cold/warm `flashcards://add-device` verified 2026-11-24).
- [ ] Real iCloud sync and signed Mac builds.
- [ ] Real Graph/OneDrive.
- [ ] Real Dropbox App Folder OAuth + Linked Sources on web, Capacitor (`flashcards://oauth/dropbox`), and Tauri (`http://127.0.0.1:53682`). Only faked endpoints have been tested (`docs/setup-dropbox.md`).
- [ ] The Capacitor shell was not run interactively for #23 (Windows Tauri release verified 2026-11-24).

## Cross-platform gaps found on device & code review (2026-11-23)

Observed while bringing up the Capacitor Android debug build on a Pixel 9 Pro and auditing the platform adapters (`platform-capacitor`, `platform-tauri`, `platform-web`, `apps/web`, `apps/mobile`, `apps/desktop`).

### Native Device TTS (missed in initial build plan)

- [x] **Android native `TextToSpeech` bridge (`deviceSpeech`).** Added `AndroidTtsPlugin.java` (registered in `MainActivity.java`) and `CapacitorDeviceSpeechPlayer` (`packages/platform-capacitor/src/audio/native-device-speech.ts`), wired on Android in `bootCapacitorPlatform`, plus `DeviceSpeechPlayer.onVoicesChanged` so `SettingsScreen.tsx` refreshes voices without touching `window.speechSynthesis`. Launch init, `voicesChanged`, `isAvailable`, and `getVoices` verified on Android 16 (`SM_X400`, 2026-11-24); audible `speak()` check pending unlocked device test.
- [x] **Misleading error when `deviceSpeech` is unavailable.** `useAudioController.ts` now forwards `speechRes.message` on `unavailable` / `error` so `runTestTtsVoice` shows the real reason.
- [ ] **iOS `AVSpeechSynthesizer` vs. `WKWebView` `speechSynthesis`.** `WKWebView` exposes `window.speechSynthesis`, but behaviour under the iOS hardware silent switch, `voiceschanged` timing, and `localService` reporting has not been verified on a real iPhone; consider wrapping `AVSpeechSynthesizer` if `WKWebView` misreports local voices or respects the mute switch.
- [ ] **Desktop (Tauri) `speechSynthesis` on Linux WebKitGTK.** `platform-tauri` inherits `WebDeviceSpeechPlayer` too; Linux WebKitGTK builds without `speech-dispatcher` (or missing OS voice packages) have no `window.speechSynthesis` voices.

### Android (`apps/mobile/android`, `@flash/platform-capacitor`)

- [x] **Android hardware/gesture Back button.** Added `PlatformServices.onBackButton` (`createBackButtonSource` in `packages/platform-capacitor/src/native/plugins.ts`) and wired `ScreenRouter` (`FlashcardsApp.tsx`) to close the topmost open `<dialog>` / modal, else return to the Study tab, else minimize the app. Not yet run on a device.
- [ ] **Soft keyboard resize & Android 15/16 edge-to-edge (`targetSdkVersion = 36`).** Added `android:windowSoftInputMode="adjustResize"` in `AndroidManifest.xml`; still verify on device that typed-answer study, Browse search, and the note editor toolbar aren't covered by the soft keyboard, and verify `env(safe-area-inset-*)` padding in `AppShell.tsx` under gesture navigation and cutouts.
- [ ] **Verify reminders survive a reboot (`@capacitor/local-notifications`).** `local-notification-reminders.ts` schedules inexact `allowWhileIdle` alarms when the app opens. `dumpsys package` on Android 16 (`SM_X400`, 2026-11-24) confirmed `LocalNotificationRestoreReceiver` is registered for `BOOT_COMPLETED` / `LOCKED_BOOT_COMPLETED` with `RECEIVE_BOOT_COMPLETED` granted; still verify an actual scheduled reminder survives a device reboot.
- [x] **Export temp files accumulate in `Directory.Cache`.** `saveAndShareFile` and `openSaveStream` now write into `Directory.Cache/flashcards-exports/` and `bootCapacitorPlatform` sweeps leftover files from previous sessions in the background at launch (`sweepExportCache`).

### All native shells (Capacitor + Tauri)

- [x] **Disable PWA Service Worker (`sw.js`) inside native shells.** `VitePWA` now sets `injectRegister: null`; `apps/web/src/main.tsx` registers `/sw.js` only on pure web/PWA production builds and unregisters any leftover Service Worker when `Capacitor.isNativePlatform()` or `__TAURI_INTERNALS__` is detected.

### iOS (`apps/mobile/ios`, `@flash/platform-capacitor`)

- [ ] **`Info.plist` App Store / TestFlight readiness & `audioSession` check.** Added `ITSAppUsesNonExemptEncryption = false` to `apps/mobile/ios/App/App/Info.plist`. `navigator.audioSession.type = 'playback'` in `WebAudioPlayer` (`web-audio-player.ts`) still needs verification on a physical iPhone in `WKWebView` against the hardware silent switch.

### Desktop (`apps/desktop`, `@flash/platform-tauri`)

- [ ] **Background study reminders.** `boot.ts` (`platform-tauri`) uses `studyReminderDelivery: 'while-app-runs'` because `tauri-plugin-notification` cannot schedule OS notifications after quit (documented in Settings, no tray/daemon scheduler planned yet).
- [ ] **Linux WebKitGTK media codecs & keyring availability.** `<audio>` playback of MP3/M4A clips on Linux depends on host GStreamer plugins (`gst-plugins-good`/`bad`/`ugly`), and Linux without Secret Service (GNOME Keyring/KWallet) falls back to SQLite token storage with a Settings warning; neither Linux runtime has been smoke-tested on a real machine.

### Web / PWA (`apps/web`, `@flash/platform-web`)

- [ ] **Non-Chromium browser limits (Safari / iOS Safari / Firefox).** Local Folder Sync (`showDirectoryPicker`) is Chromium-only; Safari/iOS WebKit can evict unpersisted IndexedDB after 7 days without interaction when `navigator.storage.persist()` is refused (Home Screen install + sync/download reminders mitigate this); iOS Safari `speechSynthesis.getVoices()` commonly returns `[]` until `voiceschanged` or a user gesture, and `localService` reporting varies by browser/OS.

## Starter-deck content (Android testing follow-up, 2026-11-25)

- [x] **No licence credit on starter cards (decks 1.2.0).** The vocab layouts reveal `example` + `notes` last, so every starter card's "third side" showed only a credit line. The build now leaves `notes` for learner content (the Mandarin deck's "Also read: …"; empty otherwise) and fails if a credit lands in `notes` or `example`. Credits are deck-level: each deck description ends with a "Credits: …" line, Settings > About & Open Data Licenses lists every starter source with its licence attribution and changes (`packages/ui/src/packs/starterSourceCredits.ts`), and `THIRD-PARTY-NOTICES.txt` keeps the full notices. Per-note provenance (`meaningSource`, `meaningEdited`) is metadata in the generated module, not a field, and is not copied into events. Reasoning per licence: `content/starters/README.md`.
- [x] **Clean up the old credit on decks seeded before 1.2.0.** There is no starter update path: seeding happens once, at onboarding (`startOnboardingDeck`), and `presetCatchUp.ts` is about deck-option presets, not deck content. Existing users keep the credit line in Notes (and the 1.0.0 glosses, see PR #28 above). A future update step would, per starter note, emit a `NoteUpserted` that clears `notes` (or leaves "Also read: …") **only when the field still exactly equals the old generated credit**. The old text is reproducible from `meaningSource`/`meaningEdited` (formats in `content/starters/README.md`). It must merge with any user edit (only that field changes, timestamped now) and run once per deck version (`DeckCreated.source.package_version`). Owner decision: build this, or leave existing decks as they are. Done in #83 (`packages/core/src/starters/upgrade.ts`): per starter note, one `fields_only` `NoteUpserted` clears the 1.0.0 or 1.1.0 credit, and the 1.0.0 gloss is replaced by the current one. Edited fields stay.
- Moved to "Needs the owner (hands-on)": Tatoeba and example sentences.
- [x] **No empty reveal step.** The study screen already drops reveal steps whose fields are all empty, so a Korean starter card (empty `example` and `notes`) now reveals in one step, and a Mandarin card shows the last step only when it has "Also read: …".

### Review and consolidate tags (deferred by the user)

Candidate for a later review. **No tags were changed.**

Tags in use today:

- **Starter decks:** `nikl-a`; part of speech from the NIKL list: `noun`, `dependent-noun`, `pronoun`, `numeral`, `determiner`, `verb`, `adjective`, `adverb`, `interjection` (`proper-noun` is mapped but no level-A note uses it); `hanzi-common` (Mandarin deck).
- **Automatic:** `leech` (added when a card lapses too often).
- **Imports:** CSV/TSV `Tags` and `Category N` columns become tags; Anki imports bring their own tags (for example `marked`, `leech`).

Proposed scheme:

- Namespaced tags: `level::` (e.g. `level::a` for `nikl-a`), `pos::` with the nine NIKL parts of speech folded into five (noun incl. dependent noun and pronoun, verb, adjective, adverb, other incl. numeral, determiner and interjection), `topic::` for subject groups, and `leech` kept as is.
- Use the single word "tag" everywhere in the UI instead of "category" (the importer's `Category N` columns included).
- Needs: a migration for existing starter notes (tag rename events, only for tags the starter seeded), a mapping for imported Anki `leech`/`marked`, and a decision on how hierarchical `::` tags show in Browse and the study-set filter.

## Study method and card order (Android test notes #5, 2026-11-24)

- [x] **Study screen `Method · Order` chip (session only).** Spaced repetition or Practice (cram over the current deck / filter, never changes FSRS); Deck order, Random (seeded), and Hardest first for Practice. Choices reset when the Study deck selection changes or the app restarts. Practice runs as the existing custom-study practice session, so its filter chip (×) and "Clear filter" end it too.
- [x] **Settings › Study Preferences:** "Default study method" and "Card order (all decks)" (synced LWW preferences `study_method` / `study_order`; the order is also written to every deck's `new_card_order`). An "Apply to all" button appears when some decks use their own order.
- [ ] **New decks start with source order.** A deck created or imported after choosing "Random (all decks)" gets `new_card_order: 'source'` (the deck default) until "Apply to all" or its own deck options change it. Decide whether deck creation should copy the Settings default.
- [ ] **Review order is collection-wide.** `study_order` orders reviews in every deck; only new-card order can differ per deck. Add a per-deck review order only if users ask for it.
- [ ] **"Newest first" order** (suggested in the Android review) is not built; the three orders above cover the decided scope.

## Burn-down wave 2 follow-ups (2026-11-26)

Left over from #72–#75 and #79–#85, which burned down the 2026-11-25 code review. Each item is small and none blocks a release.

### Cloud transports and sign-in (#79, #74)

- [x] The 401 contract test doesn't prove that the token was force-refreshed. The fake ignores the Authorization header, and OneDrive's harness always returns the same token (`sync-transport-conformance.test.ts`). Done in #103: a token issuer rotates tokens in all three harnesses.
- [x] No per-call-site over-cap test for the image and audio processors, the picker downloads or the Docs export. Only the shared reader (`net/read-capped.ts`) is covered. Done in #103.
- [x] The 2 s interactive Retry-After ceiling is not tested in the OneDrive or Dropbox pickers. Done in #103.
- [ ] A token-helper reply with no token now returns 502, so web Google shows "helper unavailable" with tap-to-renew instead of AUTH_REQUIRED. Check that this is the wording we want.
- [ ] The 50 MB cap on Sheets `values.get` JSON is tighter than the same data as CSV.
- [ ] Behaviour changes to keep in mind: the 401 refresh no longer counts as an attempt for OneDrive and Dropbox (up to `maxAttempts + 1` requests), Google no longer retries 501, and the Dropbox picker's network-error text changed.
- [x] The native Dropbox and Microsoft auths keep their own `inFlightRefresh` (`dropbox-native-auth.ts`, `microsoft-native-auth.ts`). Move them onto `TokenRefresher`. Done in #97: both moved onto `TokenRefresher`.
- [ ] The Google Drive, Dropbox and OneDrive transport `read()`s still load the whole file into memory. Skipped in #103: it needs an interface change in six transports and a streaming codec; see the design note in #103.
- [ ] Run one real desktop sign-in per provider. The shared loopback helper (`platform-tauri/src/native/loopback-sign-in.ts`) has only mocks so far.
- [x] Picker deep link: require the `state` nonce once the hosted `picker.js` has been live a while. A callback with no `state` is still accepted (`native-picker-bridge.ts`). Done in #103: a callback with no `state` is refused.
- Moved to "Needs the owner (hands-on)": the Entra redirect URI.
- [x] `flash-cli audio --key-stdin` prints its prompt on stderr at a terminal. Check that it never echoes the key. Done in #103: raw mode at a terminal. Real terminals are unchecked (see "Needs the owner"); a lone Esc swallows the next key (see "Left over from the follow-ups batch 2").
- [x] `apps/desktop/.cargo/config.toml` (the `SQLITE_SECURE_DELETE` build flag) needs a comment that says why it sits in `apps/desktop/` and not in `src-tauri`. Done in #94: the comment says why it sits in `apps/desktop/`.

### Left from partly fixed review items (D11, S4, P3, §9)

- [x] D11 (review): the SQLite storages now append events and meta in one transaction. Done in #95.
- [x] D11 (review): two tabs of one browser profile could write at once and reuse `(device, seq)`. Done in #100: one writer per profile via Web Locks. A second tab shows "already open in another tab" with a "Use here instead" button, queued edits are saved before the handover, and a waiting tab takes over by itself when the writer closes.
- [ ] S4 (review): UI components still read `note.fields[key]` directly. Route them through `noteField`. #108 (in review) routes them through `noteField`.
- [x] P3 (review): a sync tick that changes `syncState` still re-renders every `useApp()` consumer. Move `syncState` out of the context value. Done in #104: `syncState` lives in its own store (`useSyncState()`).
- [x] §9 Native (review): event SQL runs only against `InMemorySqliteDriver`, never real SQLite. Run it against sql.js or a device. Done in #95: event SQL now also runs against sql.js and `node:sqlite`.

### Linked sources and refresh (#80, #72)

- [x] `markPermissionRequired` leaves an old `skipReason` in place. Done in #97: linked sources and refresh.
- [x] `applyCloudFileReconciliation` looks up the row outside `withSourcesLock`. It is harmless today, because it looks the row up again inside the lock. Done in #97: linked sources and refresh.
- [x] The new row-routing tests cover OneDrive and Dropbox only, not the Drive branch. Done in #97: linked sources and refresh.
- [x] Relinking without access leaves the row at `error`, not `permission_required`, until the next refresh. Done in #97: linked sources and refresh.
- [x] "Refresh all" still skips Google Sheets and Docs with no message while Google is disconnected. The Drive row message could apply to them too. Done in #97: linked sources and refresh.
- [x] A device that has synced linked decks but never opened Sources doesn't refresh them at launch. The launch check reads only the saved registry (`sources/hasLinkedSources.ts`). Done in #97: linked sources and refresh.
- [x] Local-folder `.xlsx` scans skip `canParseXlsx` (`sourceRunner.ts` ~1946). Done in #97: linked sources and refresh.

### Import, CSV and zip (#72, #85)

- [x] Export, then re-import into the same collection, adds a copy of a note that lost the record-id race, because it is now exported under its note id (`flashpkg.ts` ~732, `import/record-ids.ts`). Needs a package-origin deck that already holds duplicate keys to test. Done in #102: `existingNoteMatcher` matches each note once, so no copy is added.
- [x] Zip detection decodes entry names as UTF-8, while extraction decodes a name without the UTF-8 flag as Latin-1 (CP437 names; `zip-entries.ts` ~85). Test with a real Anki or Drive archive. Done in #102: detection and extraction share `decodeZipEntryName`. Real archives are still unchecked (see "Needs the owner").
- [x] A space before an opening quote is still part of the cell (`csv.ts` ~96). Done in #102: `a, "b"` reads like `a,"b"`.
- [x] A cell that holds only spaces inside quotes still reads as empty, so it doesn't round-trip. Done in #102: it imports as those spaces and round-trips.
- [x] The Bring my cards preview still trims quoted padded cells, because its grid has no quote flags. The import keeps them. Done in #102: `parseDelimitedTable` carries the quote flags into the preview.
- [x] The Card ID write-back still doesn't quote outer spaces, unlike `exportCsv`. Changing it would start preserving spaces in cells that were unquoted before. Done in #102: a comment in `tabular.ts` says why it stays as it is; behaviour unchanged.
- [x] `scripts/packs/zip-entry.mjs` doesn't reject `:` in entry names. Done in #94: `:` in entry names is rejected.
- [x] The Dropbox transport and picker accept `.` segments, while OneDrive rejects them. Done in #97: `.` segments are rejected.
- [x] The NUL check in Tauri `readRelativeMedia` is tested only through its helper (`hasTraversalSegment`). Done in #102: a command-level test.

### Sync, replay and snapshots (#75, #82, #83)

- [x] TTS-key restore approximation when a snapshot has no registers (`events/snapshot.ts` ~58). Done in #96: documented, behaviour unchanged; bounds are in the `snapshot.ts` comment.
- [x] The Anki reader's idle timeout also runs during the read itself. Use `quiet()` there. Done in #96: the read uses `quiet()`.
- [x] The hydrate branch (`syncRunner.ts` ~441) still moves the snapshot counter after its queued write. Done in #96: branch counter fixed.
- [x] The counter moves even when the persist later skips the write, so the next snapshot can be up to 200 events late. Done in #96: the claim is given back when persist skips.
- [x] A sync that pulls 100 or more events snapshots regardless of the counter. Done in #96: kept on purpose as `SYNC_PULL_SNAPSHOT_EVENTS`.
- [x] Retained `unknownEvents` are shared objects between the serialized input and the live state. Done in #96: they are copied now.
- Moved to "Needs the owner (hands-on)", under "Design calls": the starter-upgrade race (#83), where an unsynced edit of a still-old-text field loses to the upgrade.
- [x] Starter upgrade (#83): the `SyncRuntime` hook wiring is not render-tested. Done in #105 (and #106 after #104 moved the sync state into a store).
- [x] Starter upgrade (#83): `legacySeed` builds the old decks with today's seeding code, so a seeding change can drift from what older builds wrote. Done in #105: the output is frozen in a golden snapshot (made from current code, hash-checked).
- [ ] Run the Drive `ifAbsent` race fix (C23) against real Google Drive: `createdTime` and `appProperties` in `files.list`, and how fast a create shows up in a name lookup.

### Packs, backups and memory (#82, #85)

- [x] A `full` backup with `withMedia` and no `loadMedia` loader silently writes a `daily` manifest. Done in #96: it now throws.
- [x] `.gz` packs between 50 and 150 MB are read whole before the codec refuses them. Done in #103: the picker refuses them at 50 MB.
- [x] The pack codec's uncompressed cap relies on fflate's `ondata` throw alone. Done in #103: the ISIZE trailer is checked first, and the codec keeps its own counter.
- [x] The DictionaryPanel presence index costs k × N. Done in #103: one pass, N plus each deck's own notes.
- [ ] The picker `maxBytes` caps are unverified on Capacitor (`readData: false` path).
- [x] `loadMaterializedCards` is kept, but nothing reads that table at boot. Removed in #89 with the cache (P5).
- [x] The `--full` pack build (`publish-packs.yml`) is not reached by any gate. Done in #103: `full-packs-build.test.mjs` runs it on a synthetic fixture.
- [x] `pnpm bench` is missing from AGENTS.md "Commands". Done in #94: added to AGENTS.md "Commands".

### Study screen and accessibility (#81)

- [x] `choice-sync-stable.spec.ts` may fail on some days, because the ranking is hashed by study day. If it flakes, pin the study day. Done in #105: the study day is pinned.
- [x] The "only other notes change" unit test for the choice key is weak. The e2e is the real proof. Done in #105: a render test, `choice-question-stable.test.tsx`.
- [ ] The spoken count sentence exists only once the lazy announcer chunk has loaded.
- [ ] Tags are left out of the choice key on purpose, so a tag-only edit keeps the old options until the next card.

### Tests and tooling (#73, #84, #85)

- [x] Burn down `REACT_COMPILER_BASELINE` (88 sites in 37 files; `purity` is off in `StudyScreen`). Partly done in #108 (in review): about 36 files are left (see "Left over from the follow-ups batch 2").
- Moved to "Needs the owner (hands-on)": the required Security checks.
- [ ] CodeQL covers JavaScript, TypeScript and Actions only. Add Rust, Kotlin and Swift to `desktop.yml` and `native.yml` if wanted.
- [ ] Watch the first Gradle Dependabot PRs on the Capacitor project: `cap sync` rewrites `capacitor.build.gradle` and `capacitor.settings.gradle`.
- [x] The string-value `__proto__` test and the `({}).polluted` check can't fail. Done in #94: the check can fail now.
- [x] `phase5-audio.spec.ts` ~351: polling `getVoices` can pass before the key press reaches `speak`. Done in #105.
- [x] The front auto-speak absence check waits only two frames. Done in #105.
- [x] The `flash-cli mcp` child-process test has no explicit timeout or kill. Done in #94: explicit timeout and kill.
- [x] The retry reporter doesn't escape `%` in `::warning` messages, and has no automated test. Done in #94: `%` is escaped; the S4624 nested template literal followed in this batch.
- [x] The 26 MiB snapshot fixture is heavy: moved to "Left over from wave 3" (#90) below.
- [x] `sw-picker.spec.ts` matches the exact regex text of the denylist. Done in #105.
- [x] The `listFolderDecks` coverage (hide archived, name and id order) was dropped with the function. Dropped in #105: the function is gone, so there is nothing to test.
- [x] UI render tests still to write once `happy-dom` is in: `rateCard`, `undoLastReview`, `redoLastUndo`, `emitEvents` with a failed persist, the P3 render-count test, and the effect wiring in `ReminderRuntime`, `MediaImage` and Browse (see the decision below). Done in #90: 16 render tests.
- [x] A coverage threshold in `vitest.config.ts`, once `@vitest/coverage-v8` is in. Done in #90: 63/54/54/64, checked by `pnpm coverage` in CI.

### Left over from the dead-code pass (#85)

- [x] knip still lists 60 unused value exports and 121 unused type exports, mostly component prop types and module constants. Un-export them in a later pass. A few are `default` exports used through `lazy()`. Done in #108 (in review): the un-exports.
- [ ] R8 leftovers: the per-review FSRS loop (`stats.ts`, `replay.ts`), the `.flashpkg` layout and note-type payloads, and the device-speech wrappers.
- [ ] Moving the shared SQLite code out of `@flash/platform-capacitor` needs a new workspace package. `platform-tauri` also takes `isPickerCallback`, `SystemBrowserLauncher` and `ICloudDocumentPlugin` from it.
- Moved to "Needs the owner (hands-on)": owner chores.

### Korean 2 consolidation audit, app bugs (#93)

The audit (`docs/Audit.md`, untracked in the main checkout) was about the plan for merging the Korean sheets; four of its findings were app bugs.

- [x] **C8:** the Sentence, Cloze and Grammar presets now speak and render their target-language fields in the deck's language (`noteTypeForDeck`), and a linked sentence sheet's deck language comes from the script of its Sentence column.
- [x] **C9:** a `.flashpkg` deck file with two records sharing an `id` keeps the first and warns; records whose field keys match none of the note type's import blank and warn. Library and OneDrive/Dropbox `.flashpkg` imports now show package warnings.
- [x] **C1:** a CSV/TSV quote that never closes, or has text after its closing quote, is read as plain text, so the rows after it are kept.
- [ ] **C8 reaches only new links.** A Sentence deck already linked from a sheet keeps the language `en` it was given, so it still speaks English, and no screen changes a deck's language. Recommend offering, once, to set the language of a Sentence, Cloze or Grammar deck whose text is in another script (owner: design).
- [ ] C8 minors (#93 review): the `.apkg` export takes the `{{tts}}` language of a shared built-in note type from the first deck it exports, and has no test for it. A user's own `lang` on a built-in Sentence, Cloze or Grammar field is overridden by the deck's language. The import status-line warnings have no UI test.
- [ ] **C9, third point:** re-importing with archive-on-upgrade archives every note whose `id` changed, with its review progress. Recommend a preview that counts the notes it would archive.
- [x] Two CPU-heavy unit tests timed out under load and failed `pnpm gate` on main too: `backup-runner` "keeps pre-restore snapshots outside the rolling 14…" (~3.5 s alone, against the 5 s default) and `onedrive-transport` "retries a failed fragment…". Each now has a 30 s timeout.

### Left over from wave 3 (#87–#90)

- [x] #88 S6: the Export for Anki CSV leaves the GUID, note type, deck and tags columns unguarded. Try Anki's `#deck:` and `#notetype:` file headers for the deck and note type (check that Anki creates a missing deck), then record the remaining tag and GUID risk. Done in #102: the note type is a `#notetype:` header; the deck stays a column (see "Decisions needed (batch 2026-11-26b)"). The tag and GUID risk remains.
- [x] #88: the Anki path could entity-encode every leading `-` and drop the Hangul heuristic there. Done in #102: every leading `-` is an entity on the Anki path.
- [ ] #88: import an exported CSV into real Anki once, to check that `&#61;` and the like show as `=` and don't affect Anki's duplicate check or sort field.
- [x] #88: a UI now offers the "for other apps" CSV (`stripRichText: true`): the **For other apps** box in the Browse bar and the tag export (#93). Unticked, the CSV is the round-trip one, unguarded by design.
- [x] #88: fullwidth lookalikes (＝, ＋) are not guarded. Done in #102: guarded in both exports. Whether a spreadsheet runs them is unverified.
- [x] #89: `tests/e2e/sync.spec.ts` now compares event ids only, not each device's derived schedules. Add a state-level check (replay the stored logs, or read in-app state through a test hook). Done in #105: it also replays each device's stored events.
- [x] #90: shrink or lazily build the 26 MiB D12 snapshot fixture in `sync-engine.test.ts`, then the coverage-only 15 s `testTimeout` could go back toward 5 s. Mostly done in #105: built lazily once, 25 MiB + 1 byte, `testTimeout` 8 s. The floor is the codec cap.
- [x] #90: put a floor (≥ 50) on each threshold in `tools/hooks/settings.test.mjs`. Done in #94.
- [ ] #90: fake `Date` as well as timers in the web badge test (`packages/ui/tests/effect-wiring.test.tsx` ~39). Wait for a ready signal rather than `flush(5)` in the P3 render test. `apps/*` shell code sits in the coverage denominator.
- [ ] #90: `pnpm gate` runs plain `pnpm test`, so parallel branches can each pass and together drop under the coverage thresholds (like the bundle budget). Run `pnpm coverage` after merging main.

### Left over from the follow-ups batch (#94–#97)

- [x] `tools/gemini/rails.mjs`: a review with one tagged `[note]` line plus an untagged mid-line "Blocker: …" still reads as notes-only. Could also retry when an untagged line matches `blocker` (#94 review). Done in #105: an untagged line naming a blocker now retries. The plural "Blockers: X" still reads as merge (see "Left over from the follow-ups batch 2").
- [ ] Capacitor `executeSet(set, true)` rollback is unverified on a real Android or iOS device (#95).
- [ ] The Tauri `sql_execute_batch` command is unverified inside a running desktop app. Only the Rust function and the TypeScript side over `node:sqlite` are tested (#95).
- [ ] The native Dropbox and Microsoft auths on `TokenRefresher` are unverified on a device (#97).
- [ ] The launch refresh for synced linked decks is unverified in a two-device `?device=a` / `?device=b` session (#97).
- [ ] The Anki read with no idle limit is unverified on a large `.apkg` on a slow phone (#96).

## Decisions needed (burn-down, 2026-11-26)

The owner accepted every recommendation on 2026-11-26.

- [x] **Add `happy-dom` as a dev dependency for UI render tests.** Recommend yes. It unblocks the §9 `rateCard`, undo, redo and failed-persist tests, the P3 render-count test, and the effect wiring of #82 and #83. Done (#90).
- [x] **Add `@vitest/coverage-v8` and set a coverage threshold.** Recommend yes. Done (#90).
- [x] **Starter-deck upgrade defaults (#83).** The deck description is replaced unless the user wrote or cleared one. Notes is cleared when it equals either the 1.0.0 or the 1.1.0 credit. The upgrade runs silently, with no notice and no undo entry. Archived starter notes are upgraded too. Recommend keep all four. Decided 2026-11-26: keep.
- [x] **Starter upgrade does not rewrite `source.package_version` (#83).** The release lives in the `StarterDeckUpgraded` event, and no screen shows a native deck's version. Recommend keep. Decided 2026-11-26: keep.
- [x] **Accepted limitation (#83).** A device on an older build ignores `fields_only` and can bake the upgrade's `deck_id` into its snapshots. A concurrent move can then stay lost there, and on devices that bootstrap from that snapshot. Recommend accept. Decided 2026-11-26: accept.
- Moved to "Needs the owner (hands-on)": the licence key.
- [x] **CSV tag backslash escaping (#72).** `exportCsv` writes the tag `a,b` as `a\,b`, so Flashcards Deluxe or Excel show the backslash. Recommend accept; the other way breaks the tested `daily; topik-1` import. Decided 2026-11-26: keep.
- [x] **Licence keys bought outside the stores stay off for store builds (#74).** Decided: in-app purchase only. Keep `VITE_STORE_LICENSE_KEYS` off and keep this recorded, because App Store guideline 3.1.1 restricts key unlocks. Already decided: keep.
- [x] **Screen-reader live region wording (#81).** It names the event only ("Next card.", "Answer shown."), not the card's text. Recommend keep, and add the front text only if screen-reader users ask. Decided 2026-11-26: keep.
- [x] **Reminder badge lag and media retry (#82).** The web badge lags up to 2 s after a rating (`BADGE_CHANGE_DEBOUNCE_MS`), and a missing image is retried at most every 5 s (`MISSING_MEDIA_RETRY_MS`). Recommend keep both. Decided 2026-11-26: keep.
- [x] **A full backup that finds no media keeps the `daily` manifest (#82).** Pinned by a test. Recommend keep. Decided 2026-11-26: keep.
- [x] **P5 (review): the materialized card cache is write-only.** Every persist writes it and nothing reads it. Recommend measuring boot at 50k reviews first: if replay is fast enough, stop writing the cache; if not, read it at boot. Done (#89): boot at 50k reviews stays fast without the cache (`docs/perf-boot-50k.md`).
- [x] **D19 (review): a moved note's reviews replay under the new deck's FSRS params.** Recommend accept and document it. A card follows the settings of the deck it is in, as in Anki. Accepted and documented in `docs/design_blueprint.md` (§4.1).
- [x] **S6 (review): CSV export allows formula injection.** Recommend prefixing `'` to cells that start with `=`, `+`, `-` or `@` only in the "for other apps" export, and skipping `-` followed by a Hangul letter, so grammar entries like `-(으)ㄴ` stay as they are. Partly done (#88); see "Left over from wave 3".

### Left from the single-writer tab (#100)

- [x] No unit test covers the shell wiring in `apps/web/src/main.tsx` (`exposeWhenSaved` → `whenSaved`). The UI tests cover `AppProvider` and `FlashcardsApp`, and the e2e waits for each rating to land before "Use here instead", so deleting the shell link passes. Add an e2e that slows one write before the click. Done in #107: `single-writer-save-first.spec.ts`.
- [x] A take-over request that arrives after the lock is held but before the app mounts finds no persist queue. Boot-time writes such as `setDeviceMeta`, sample seeding and migrations then fail on blocked storage and `boot()` rejects unhandled before the reload. The write barrier keeps started transactions whole and the next boot re-runs them, so nothing is lost. Wait for boot to finish before honouring a request. Done in #107: the handoff waits for `booted`.
- [x] `packages/ui/tests/writer-handoff-wiring.test.tsx` imports `apps/web/src/writer-handoff.ts`, so a library test depends on the app. Replace it with a local stand-in that records `release` and awaits `whenSaved`. Done in #107: a local stand-in.
- [x] `blockWrites` replaces `storage.close` with a rejecting stub. If the lock is stolen while `yieldWriter` is still running, `stop()` calls that stub, which raises an unhandled rejection just before the reload and doesn't close the database (agy, #100). Done in #107: `close` stays real.
- [x] `pause` in `writer-handoff.ts` doesn't check `signal.aborted` before waiting. A tap on "Use here instead" after this tab has already won the lock, but before the app has rendered over the waiting screen, waits a full 3 s round and keeps sending take-over requests (agy, #100). Done in #107.
- [ ] Not verified in Safari, Firefox, Capacitor or Tauri, or in a real browser for a stolen lock or an old tab whose lazy chunk 404s after a deploy. Chromium 156 does reject a stolen holder's `request()` promise with `AbortError`, as the spec says.
- [x] Bundle: #100 takes initial study-screen JS to 159.95 of 160 KB. The next change that adds to the initial bundle needs a trim first. Done in #104: 156.69 KB of 160 KB after it, 156.73 KB after #107 (a re-measure from a fresh worktree is still wise).

## Decisions needed (wave 3, 2026-11-26)

Each default below stays shipped until the owner decides.

- [ ] **Tauri store builds accept licence keys whenever a public key is set (#87).** Only Capacitor checks `VITE_STORE_LICENSE_KEYS`. Recommend gating Tauri store builds the same way if a Mac App Store or Microsoft Store build ever ships.
- [ ] **Rotating the licence key locks out every key already issued (#87).** Recommend never rotating unless the private key leaks. If it does, ship the old public key alongside the new one for a transition.
- [ ] **An unguarded grammar entry like `-(으)ㄴ` may still show as `#NAME?` in Excel (#88, not verified).** It is in the "for other apps" CSV. Recommend checking once in Excel; if so, guard every leading `-` in that export too (the `'` prefix is invisible in Excel).

## Decisions needed (follow-ups batch, 2026-11-26)

The owner accepted every recommendation on 2026-11-26.

- [x] **Two tabs of one browser profile can still write at once and reuse `(device, seq)` (#95 left this open).** Renumbering seq in storage is not enough, because each tab keeps only its own events in memory. Fix: one writer per profile via Web Locks. Owner choice: what the second tab shows. Recommend an "already open in another tab" screen with a "Use here instead" button. Decided 2026-11-26: build it (**To build**, see D11).
- [x] **While Google is disconnected, linked Google Sheets and Docs rows now show "Connect Google to refresh this file." (permission needed)** instead of keeping their last state silently (#97). With the new launch refresh, a device that synced Sheets decks but never connected Google shows this after its first launch. Recommend keep. Decided 2026-11-26: keep.
- [x] **agy's linked-issue filter trusts only the owner and write, maintain or admin collaborators; triage is untrusted (#94).** Recommend keep. Decided 2026-11-26: keep.
- [x] **An agy review with no tagged line now retries rather than holds (#94).** Recommend keep. Decided 2026-11-26: keep.

## Left over from the follow-ups batch 2 (#102–#108)

Open items, grouped by PR. Dependabot and CI come last.

### #102

- [ ] The `#notetype:` omission and `headerValue` line-break handling have no tests.
- [ ] `csv.ts:174`: a first-row quoted all-space row is kept when `hasHeaderRow: false`.
- [ ] `safe-unzip.ts:220`: a flagged UTF-8 name that collides with a CP437 name fails closed, and that path has no test.
- [ ] `record-ids.ts:64`: `sameContent` (+2) outranks the replay pick (+1) during an upgrade.

### #103

- [ ] A lone Esc in `--key-stdin` swallows the next key (Enter, Ctrl-C).
- [ ] 3 SonarCloud minors.
- [ ] Item 4, streamed transport `read()`, was skipped; see the design note in #103.

### #104

- [ ] The anki-ruby fast-check alphabet lacks `}`, `\n` and astral Han.
- [ ] The `toggleDeckLayout` test in `library-actions.test.tsx:83` can pass without checking anything.
- [ ] `LaunchSyncEffects` now runs before AppProvider's effects. No known dependency on the old order.

### #105 (#106 fixed its clash with #104)

- [ ] The plural untagged "Blockers: X" still reads as merge (`rails.mjs:122`).
- [ ] The no-starter-deck test can't catch a `hasStarterDeck` that wrongly returns true.
- [ ] D12 fixture floor: 25 MiB + 1 byte, because the cap is a codec constant. `testTimeout` is 8 s.
- [ ] `listFolderDecks` coverage was skipped, because the function is gone.

### #107

- [ ] If the first render throws inside React, `booted` never resolves: `boot()` resolves before AppProvider's effect runs. The asking tab then gets the lock only by stealing it after 120 s.
- [ ] The `boot().catch(() => { markBooted(); throw err })` path has no test.
- [ ] Sonar S7785 (prefer top-level await) on `main.tsx` was left as a promise chain, plus 3 new Sonar minors.

### #108 (in review)

- [ ] About 36 files are left in `REACT_COMPILER_BASELINE`. All are genuine `purity`, `set-state-in-effect`, `refs` or `incompatible-library` findings, and clearing them needs behaviour-changing rewrites. `StudyScreen` `purity` was deliberately not forced.

### Dependabot and CI

- [x] Dependabot #66, #67 and #76 merged. #68 closed: @types/node 26, and Dependabot ignores that major because the runtime is Node 24.
- [ ] **Waiting on upstream:** #77 (sqlx 0.9) was closed until a tauri-plugin-sql release is built on sqlx 0.9.
- [ ] **Waiting on upstream:** #78 (Gradle 9.9) was closed until an Android Gradle Plugin supports Gradle 9.6+.
- [ ] CI: watch the next `publish-packs` run on main. wrangler-action 4 (#66) and actions/cache 6 (#67) haven't run there yet.

### Open on purpose

- [ ] R8 FSRS-loop refactors and the shared SQLite package split: big refactors with no user-visible gain. They stay listed (see "Left over from the dead-code pass (#85)").

## Decisions needed (batch 2026-11-26b)

Each default below stays shipped until the owner decides. All are **keep** unless noted.

- [ ] **Anki CSV: the deck stays a column, and the note type moved to a `#notetype:` header (#102).** A `#deck:` header would drop the deck for most users, who import into a fresh Anki. Recommend keep.
- [ ] **Zip names without the UTF-8 flag (#102):** read as UTF-8 when well-formed, else as CP437. Recommend keep.
- [ ] **Local pack files are capped at 50 MB, was 150 MB (#103).** The codec already refused more. Recommend keep; raise it only if a real pack needs more.
- [ ] **A stale cached `picker.js` callback without `state` is ignored (#103).** The user picks again. Recommend keep.
- [ ] **A Dexie ES2018 build alias (#104).** Technical. Recommend keep.
- [ ] **The launch source check fetches one small chunk about 50 ms after first paint (#104).** Recommend keep.
- [ ] **New UI APIs `useSyncState`, `useLibraryActions` and `getState` (#104).** Technical; for information only.
- [ ] **Single-writer `booted` has no timeout of its own (#107).** A hung boot is taken over after the asking tab's 120 s limit. Recommend keep.
- [ ] **When boot fails, the error is still rethrown after `markBooted()` (#107).** Recommend keep.
- [ ] **The knip un-exports in #108 (in review) also reach about 25 files outside `packages/ui`** (core, platform-web, platform-capacitor, platform-tauri), each only dropping an `export`. For information only.

## Needs the owner (hands-on)

Everything here needs a real device, a real account or sign-in, or a design call. Items moved here from other sections leave a one-line pointer where they were.

### Real devices and services

Only Chromium Playwright with faked endpoints has covered these (moved from "Not verified on real devices or services").

- [ ] **`@flash/capacitor-secure-storage` on devices.** Its Java and Swift code now compiles in CI (`.github/workflows/native.yml`: Gradle `assembleDebug` and an unsigned Simulator `xcodebuild`, PR #10). On a real Android 16 tablet (`SM_X400`, SDK 36, 2026-11-24), launch verified `FlashSecureStorage` initialization, legacy-pref cleanup (`GOOGLE_LOGIN_F13oz0I_SHARED_PERF.xml`, `CapgoOAuth2ProviderPrefs.xml`), and `app.flashcards.securestorage.xml` matching `backup_rules.xml` / `data_extraction_rules.xml`. Still to check on an unlocked device: interactive Keychain/Keystore set/get round trip, Custom Tabs OneDrive redirect (including WebView < M130), plaintext token migration on upgrade, and CapacitorHttp refresh against real Entra.
- [ ] Capacitor `pickFile({ maxBytes })`: `@capawesome/capacitor-file-picker` with `readData: false`, then `Filesystem.readFile` on the returned path (an Android `content://` URI or an iOS temporary file). Never run on a device.
- [ ] Recheck the capgo plugin's internal plaintext key names (`packages/platform-capacitor/src/secure/secure-store.ts` and the native allowlists) on every `@capgo/capacitor-social-login` upgrade. They are pinned for 8.7.x.
- [ ] Add-device QR codes scanned with a real phone camera, and the `flashcards://add-device` deep link opened on Android and iOS. **Windows Tauri release verified (2026-11-24):** `flashcards://` registered in `HKCU\Software\Classes\flashcards`, and both cold-start and warm-start (`tauri-plugin-single-instance` forwarding) `flashcards://add-device` links routed to Settings and displayed the provider prompt. Android intent filters (`picker-callback`, `oauth`, `add-device`) confirmed via `dumpsys package` on Android 16; interactive open still pending unlocked device test.
- [ ] Real iCloud Drive sync on macOS, and a signed Mac build (PR #22 is compiled in CI only).
- [ ] Capacitor shell running the language-aware menus (still pending unlocked device test). **Windows Tauri release verified (2026-11-24):** toggling Japanese in `Settings > Languages` dynamically revealed/hid Japanese typed-mode (`Hiragana = Katakana`) and Japanese language options.
- [ ] Second device fully synced within 2 minutes with one sign-in (the Phase 14 target). It has not been measured, because the e2e sign-in is faked.
- [ ] Tauri loopback Microsoft sign-in end to end, including whether `tauri-plugin-http` sends an `Origin` header that Entra rejects (AADSTS9002327).
- [ ] Capacitor Microsoft sign-in on Android and iOS. From reading the code, `SocialLogin.initialize` with only the oauth2 config re-creates only that provider and keeps the Google config, but this hasn't been seen on a device.
- [ ] OneDrive download and upload-session URLs allowing CORS from the Capacitor and Tauri WebView origins.
- [ ] Real Microsoft Graph and Entra behaviour, against a real app registration (`docs/setup-microsoft.md`).
- [x] Tauri attaching its CSP to Worker script responses, so the FSRS optimizer and the Anki SQLite WASM run under `'wasm-unsafe-eval'`. **Verified on Windows Tauri release (`flashcards-desktop.exe`, 2026-11-24):** both `apkg-writer.worker` (`sql-wasm-browser.wasm`, wrote valid `SQLite format 3` DB) and `fsrs-optimizer.worker` (`fsrs_browser_bg.wasm`, trained 660 items → 21 FSRS-6 weights) executed under live Tauri CSP with 0 CSP/console errors; also fixed `fsrs.free()` in `finally` not to mask WASM panic errors.
- [ ] iOS WKWebView module Workers loaded from the `capacitor://` scheme.
- [ ] Real Anki 23.x/24.x `anki21b` exports. The fixture is synthetic, and its schema-18 DDL was written from memory.
- [ ] Real Android, iOS, macOS, Windows and Linux shells.
- [ ] Safari and Firefox for the single-writer flow (#107 is Chromium e2e only).
- [ ] Real Google Drive, Dropbox, OneDrive and iCloud sign-ins and syncs.

### Accounts, keys and settings

- [ ] **Check the KRDict topic attribute names on a real export.** The parser accepts `subjectCategory` / `semanticCategory` and the Korean labels (`주제 및 상황 범주`, `의미 범주`). If the first `build-packs.mjs --full` run gives no topics, find the real names in the XML and add them to `KRDICT_SUBJECT_CATEGORY_ATTS` / `KRDICT_SEMANTIC_CATEGORY_ATTS` in `scripts/packs/upstream-parsers.mjs`.
- [ ] **Measure the full KRDict pack.** It has never been built here. `--full` now prints every file's size. **First-syllable sharding is written** (`docs/formats/packs.md`): a dictionary pack over 25 MiB gzipped (or with `--shard <id>`) becomes a version-2 index of search "stubs" plus `.sNN` shards cut at 초성 boundaries. All lookups work from the index; the shards behind the top results load lazily (at most 3 per lookup), and Settings > Packs has "Download all for offline". Still to check once built: that the index itself stays under 25 MiB (about 60% of the pack on the starter sample), and the shard count against the Pages 20k-file limit. Owner choices pending: lazy shards versus downloading them all at install, and the tunables (3-shard cap, top-12 completion, 2 MiB shards).
- [ ] **KRDict audio licence:** not checked. Audio is skipped, and the dictionary has no speaker button, so the TTS fallback isn't wired either.
- [ ] **KRDict audio licence: researched 2026-11-23, unclear, so audio stays out.** KRDict's copyright policy (https://krdict.korean.go.kr/eng/kboardPolicy/copyRightTermsInfo) puts text under CC BY-SA 2.0 KR (commercial use allowed, attribution and share-alike), which matches `packages/core/src/dictionary/licenses.ts`. Sounds and pronunciations are excluded from that grant: commercial use and modification are set per file, and no machine-readable flag or bulk audio download was found (the Open API has a `multimedia_info` link, unconfirmed without a key). To use it, the owner would need written confirmation from NIKL, or separately licensed audio. Owner decision pending.
- **Apple Developer account: the owner has none yet.** Signing, notarizing, wiring the entitlements and real iCloud tests wait until there is one. An account (Apple Developer Program) is also needed for any iOS or Mac store release, so it is on the launch path anyway.
- **Distribution: Developer ID** (outside the Mac App Store). Kept.
- **Done (PR #27):** hide "Use iCloud Drive" on unsigned Mac builds (no entitlement), so the misleading sign-in error can't appear.
- **Done (PR #27):** a Mac where iCloud was off at launch keeps iCloud Drive listed, with a hint to turn iCloud Drive on.
- The macOS App ID reuses `app.flashcards.localfirst`; it must be in the same Apple team as the iOS app. Kept, for when the account exists.
- [ ] **Dependabot alert 3 (`glib` 0.18.5, Rust, `apps/desktop/src-tauri/Cargo.lock`): no fix here.** It comes in through Tauri's Linux GTK stack (gtk-rs 0.18); the patched glib 0.20 needs Tauri/wry to move to gtk-rs 0.20+. The unsound API (`VariantStrIter`) is not called by app code. Bump when Tauri does, or dismiss the alert as tolerable risk (owner's call).
- [ ] KRDict full-pack measurement and the topic attribute check are not done; the upstream data is a manual download. First-syllable sharding is done (see "Phase 10 remainder").
- [ ] **Korean example sentences: not added (no compatible source).** The `example` field stays empty rather than invented. Checked 2026-11-25: Wikidata lexeme usage examples (P5831, CC0) exist on only 7 of the 204 pinned lexemes. KRDict 한국어기초사전 examples are CC BY-SA 2.0 KR (share-alike, rejected). Tatoeba is CC BY 2.0 FR (some CC0): no share-alike, but it needs per-sentence attribution, has no pinned release (weekly exports only), and matching inflected Korean to a NIKL headword needs morphological analysis; English translations are uneven. Owner decision: accept Tatoeba (CC BY) with a pinned snapshot and per-deck credits, or keep examples empty.
- [ ] Add `http://127.0.0.1` as a "Mobile and desktop" redirect URI on the Entra app, then switch `microsoft-loopback.ts` to `127.0.0.1` (review N8).
- [ ] Decide whether the Security jobs (`security.yml`) become required checks. That needs a `dependency-review` that tolerates a skip, because it runs only on pull requests.
- [ ] Owner chores: delete the empty untracked `packages\ui\src\utils` in the main checkout. (`Korean-w9-base` and `Korean-w9-main` were gone by 2026-11-26.)
- [ ] **Generate the Ed25519 licence key and set `VITE_LICENSE_PUBLIC_KEY`.** Keep the private key safe. Until then, licence keys are refused, with a warning where they are offered. Tooling done (#87): the owner generates the key and sets `VITE_LICENSE_PUBLIC_KEY`, see `docs/licensing.md`.

### Unverified from batch 2026-11-26b

- [ ] A real Anki import of the new CSV (#102): `#notetype:` with an existing and a missing note type, the deck column creating a missing deck, and `&#45;` showing as `-` without affecting the duplicate check.
- [ ] Real Drive, macOS or CP437 zips with non-ASCII names (#102).
- [ ] Whether Excel or Sheets treat fullwidth `＝` as a formula (#102).
- [ ] `--key-stdin` in a real terminal on Windows and macOS (#103).
- [ ] The picker `state` requirement on a real Android or iOS device (#103).
- [ ] Native shells and real sign-ins after #104 (Capacitor and Tauri were not run; neither were real Google, OneDrive or Dropbox sign-ins).
- [ ] A lock stolen in a real browser while `yieldWriter` runs (#107).
- [ ] A take-over arriving during boot in a real browser (#107).

### Design calls

- [ ] **Starter-upgrade race (#83).** An unsynced edit of a still-old-text field can lose to the upgrade. Fixing it in the UI would be a patch; it needs a new event. Recommend a `starter_upgraded` event, so replay can order the upgrade against local edits. Owner design call before anything is built.
