# Code review (2026-11-25)

A read-only review of the whole repo at commit `0ae9b0e`, plus the uncommitted `fsrs-optimizer.worker.ts` change. Seven parallel reviewers each covered one area: core engine, core untrusted input, UI shell and study, UI feature screens, platform-web, native shells with the web shell and token helper, and tooling/CI. I then checked the highest-severity findings against the code myself, and ran the mechanical checks below.

**How to read the tags:**

- **✔** I re-read the code and confirmed the finding.
- **CONFIRMED** The reviewer traced the path.
- **PLAUSIBLE** The mechanism is real, but the trigger or the impact hasn't been seen.

Nothing in `docs/follow-ups.md` is repeated here unless the code contradicts it.

## Mechanical checks

| Check                     | Result                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`          | Pass. But no test file outside `apps/web` is ever typechecked: a scratch tsconfig over the tests finds 115 errors (see T1).                               |
| `pnpm lint`               | Pass.                                                                                                                                                     |
| `pnpm test`               | 150 files and 1,413 tests pass; 5 are skipped on purpose (missing pack cache).                                                                            |
| `pnpm audit`              | 0 known vulnerabilities.                                                                                                                                  |
| `pnpm build && pnpm size` | **159.70 KB of the 160 KB budget**: `index` 118.21 + `core-runtime` 41.07 + runtime 0.42. About 0.3 KB of headroom is left (it was 3.7 KB on 2026-11-23). |
| Raw HTML sinks            | None. The only `innerHTML` writes clear a container to `''`.                                                                                              |
| Orphan-export scan        | 9 values and 6 types are referenced nowhere; 10 production functions are called only by tests (see X1–X2).                                                |
| Copy-paste scan           | Duplication clusters in `ui/src/sources`, the answer modes, and the OAuth/PKCE helpers (see R1–R8).                                                       |

## Fix first

These are ranked by user impact. The IDs point to the full entries below.

1. **D1** ✔ Dropbox sync can never start on an empty App Folder. Missing-file reads return 409, which is never mapped to NOT_FOUND.
2. **D2** ✔ A sync pull that hits a missing segment skips past it, moves the watermark beyond the gap, and loses those events for good.
3. **D3** ✔ A failed storage write is only logged. The UI keeps going, and a reload loses every review since.
4. **D4** One malformed event from another device (bad rating, NaN time, retention out of range) throws during replay, so the collection fails to load on every device.
5. **D5** ✔ `.flashpkg` import overwrites the user's note types, layouts and courses by id, built-in presets included.
6. **D6** ✔ `.flashpkg` import reuses any deck whose id matches, whatever package it came from, and can rewrite and archive its notes.
7. **D7** ✔ Saving the note editor rewrites every field and tag, which overwrites edits made on another device that haven't synced yet.
8. **N1** ✔ Desktop Dropbox sign-in always fails when an OS keychain is present: the Rust allowlist lacks `dropbox-refresh-token`.
9. **N2** ✔ The iOS `SceneDelegate` bypasses `MainViewController`, so the iCloud plugin (the iOS sync default) is never registered.
10. **N3** ✔ The PWA service worker answers every navigation with `index.html`, `picker.html` included. Link from Google Drive breaks on Android and desktop.
11. **C1** ✔ Holding or repeating a key keeps rating cards the user hasn't seen. Nothing checks `e.repeat`.
12. **D8** The sources registry has no lock. The launch refresh's final save can overwrite a folder or catalog the user just linked.
13. **C2** There is no app-level error boundary, so one card that throws during render blanks the app on every launch.
14. **S1** ✔ In production builds, `?device=x` turns on dev mode, and the URL can then swap the licence public key and the starter catalogue.
15. **T1** ✔ Tests are never typechecked. A scratch check finds 115 errors, most of them real.
16. **P1** ✔ The bundle budget has 0.3 KB left, so almost any addition to the initial chunk will fail CI.

---

## 1. Data integrity and sync

**D1 [Critical] ✔ Dropbox sync can't initialise or tolerate any missing file** — `packages/platform-web/src/sync/dropbox-transport.ts:146-151`

- **The bug:** Dropbox answers a missing file on `/files/download` with HTTP 409 `path/not_found`. `read()` throws a plain `DropboxTransportError("… failed (409)")`. That isn't a `SyncTransportError`, and its message doesn't match `/not found/i`, so `isNotFound` (`packages/core/src/sync/engine.ts:133-136`) returns false.
- **Effect:** the first sync rethrows on `manifest.json` instead of creating it, and every head, segment and media read that is allowed to be missing fails the same way. This breaks web, Capacitor and Tauri.
- **Why tests pass:** the fake in `packages/platform-web/tests/dropbox-transport.test.ts:69` returns 404.
- **Fix:** map Dropbox errors to `SyncTransportError` codes, reusing `dropboxFailure` / `codeForDropboxStatus` from `sources/dropbox-picker.ts:112-143`. Make the fake return a real 409 `path/not_found`.

**D1b [High] ✔ Dropbox `write({ifAbsent})` treats every 409 as success** — `dropbox-transport.ts:173-177`

- **Full storage:** `path/insufficient_space` counts as "already written". `head.json` then points at a segment that doesn't exist.
- **Manifest race:** when two devices create the manifest at once, the loser keeps its own `collection_id` instead of adopting the winner's, because core expects ALREADY_EXISTS here (`engine.ts:219-225`, `:528-541`).
- **Fix:** throw `ALREADY_EXISTS` only for `path/conflict`, and map every other 409 as an error.

**D1c [High] The Dropbox transport has no 401 refresh and no 429/5xx retry** — `dropbox-transport.ts:72-183`

- A revoked token shows a generic error rather than "reconnect required", because `syncRunner.ts:510` only checks for an AUTH_REQUIRED `SyncTransportError`.
- One 429 aborts the whole run.
- **Fix:** see R1.

**D2 [High] ✔ A missing segment is skipped, and the watermark jumps past it** — `packages/core/src/sync/engine.ts:397`, `:412`, `:415`

- **The bug:** on NOT_FOUND the loop `continue`s. Later segments still raise `maxPulledSeq`, and `remoteWatermarks[devId]` is set to that value. The cause can be list-read lag or a deleted file.
- **It spreads:** the next cloud snapshot carries the bad watermark, and every device that hydrates from it drops the gap through `isEventAlreadyCompacted`.
- **Fix:** stop at the first missing segment or the first seq gap (seqs are gapless), and set the watermark to the last contiguous seq.

**D3 [High] ✔ Persist failures are swallowed** — `packages/ui/src/state/persistQueue.ts:19-22`, `state/AppContext.tsx:396-447`

- **Silent:** `emitEvents` applies the events and bumps `meta.seq`, then queues `appendEvents`. A rejection (a full IndexedDB on an iOS PWA, a busy SQLite) only reaches `console.error`.
- **Effect:** the UI and Undo keep working, and a reload loses everything. `whenSaved()` still resolves, so `BackgroundRuntime`'s "Reload now" claims the data was saved.
- **Fix:** expose a failure state, show a persistent banner, and retry the failed batch.

**D4 [High] Remote events are applied without payload validation** — `packages/core/src/sync/codec.ts:261-273`, `events/replay.ts:1093`, `:1137-1162`, `fsrs/scheduler.ts:99-101`

- **What throws:** `decodeEventsSegment` checks only the envelope, and `v` is never read. ts-fsrs throws on a rating outside 1–4, a NaN or string `reviewed_at`, `request_retention` outside (0, 1], or a `w` of the wrong length. `NoteUpserted` without `fields` throws too.
- **Effect:** one bad event from a buggy or newer build makes boot replay throw on every device, permanently.
- **HLCs:** a malformed `maxRemoteHlc` throws in `parseHlc` and aborts all later syncs. An odd but parseable HLC (`"zzzz"`) wins every LWW comparison.
- **Fix:** add a per-type guard before apply, move invalid or `v > 1` events to `unknownEvents`, and validate the HLC format in the codec.
- CONFIRMED mechanism; the trigger is PLAUSIBLE.

**D5 [High] ✔ `.flashpkg` import overwrites note types, layouts and courses by id** — `packages/core/src/import/flashpkg.ts:555-577`, `:585-624`, `:857-888`; `events/replay.ts:766-806`

- **The bug:** every `note_types.json`, `layouts.json` and `courses.json` entry becomes a `NoteTypeChanged`, `LayoutChanged` or `CourseChanged` event at a new HLC. Every exported preset deck contains `preset:vocab-ko` and its layouts.
- **Effect:** importing a friend's deck replaces your Korean note type and layouts for all your Korean decks, so disabled layouts come back and removed fields return. A hostile package can set every layout to `enabled:false` and empty the queue.
- This contradicts the rule in follow-ups.md that import never overwrites what the user has. The Anki importer already gets it right (`anki/convert.ts:301-327`).
- **Fix:** keep existing ids (merge the way `mergedNoteType` does), or namespace them per package when the definitions differ.

**D6 [High] ✔ Deck matching ignores `package_id`** — `flashpkg.ts:662-686`

- **The bug:** `state.decks.get(deckEntry.id)` matches any deck with that id. The third branch, the package check, is unreachable.
- **Exposure:** starter and sample deck ids are public (`uuidv5(FLASH_NAMESPACE_UUID, slug)`). A package that lists `starterDeckId('ko-core')` renames and relinks the user's deck and rewrites notes with matching `source_key`. Through a linked source (`archiveRemovedOnUpgrade: true`), it also archives every note it doesn't list.
- **Fix:** reuse a deck only when `deck.source?.package_id === manifest.package_id` (or for an explicit own-backup restore); otherwise use `uuidv5(package_id, entry.id)`.

**D7 [High] ✔ The note editor sends every field and the whole tag list** — `packages/ui/src/components/NoteEditDialog.tsx:141`, `:324` → `state/AppContext.tsx:644-662`

- **The bug:** `draftFields` is a full copy taken when the dialog opens, and fields replay per-field LWW. So the unchanged fields win too.
- **Scenario:** device B edits `example`, or leech backfill adds a `leech` tag. Before that syncs, A fixes `meaning`. After sync, B's change is gone everywhere.
- **Fix:** emit only the keys that differ from the opening snapshot, and send `tags` only when they changed. Find and replace already works this way.

**D8 [High] No lock around the sources registry or refreshes** — `packages/ui/src/sources/sourceRunner.ts:2333`, `:2488`; `state/AppContext.tsx:495-525`; the load/save pairs in `components/SourcesPanel.tsx:527-742` and the picker panels

- **Lost links:** `refreshAllSources` loads the registry, runs for minutes, then saves the whole object. A folder or catalog linked meanwhile is overwritten. Those links live only on this device.
- **Double runs:** a manual refresh of the same Sheet during the launch refresh emits duplicate events, and the write-back guard reads the other run's Card IDs as a race.
- **Fix:** one module-level mutex around every load→mutate→save and refresh.

**D9 [High] Card ID write-back hides Sheet edits made during a refresh** — `sourceRunner.ts:936`, `:992`, `:1021-1030`, `:1117`

- **The bug:** after `writeSheetCells`, `grid.modifiedTime` is replaced with a fresh value and saved as `lastModifiedTime`. Edits made after the first read are covered by that newer time.
- **Effect:** the next refresh stops early at `:879` and never pulls those edits.
- **Fix:** keep the first read's `modifiedTime`, and accept one extra pull.

**D10 [High] Duplicate `DeckCreated` makes the archive state depend on delivery order** — `packages/core/src/events/replay.ts:850` vs `:862-882`, `:906`

- **The bug:** the new-deck path writes the archived register at the `DeckCreated` HLC; the existing-deck path doesn't. Starter and `.flashpkg` deck ids are deterministic, so two devices both emit `DeckCreated`.
- **Effect:** after A archives and B installs offline, A stays archived and B doesn't. A full replay on B also differs from its live state, so Check Database reports drift.
- **Fix:** treat `archived` and `created_at` the same in both paths, then merge the two functions.

**D11 [Medium] Events and device seq are written in separate transactions** — `packages/platform-web/src/storage/dexie-storage.ts:152-209` vs `:266-268`; `packages/platform-capacitor/src/storage/sqlite-storage.ts:454-475`, `:556-580`, `:788-809`

- **Web:** if the tab dies between `appendEvents` and `setDeviceMeta`, the next session reuses `(device, seq)`. The `[device+seq]` index isn't unique, and two tabs of one profile also overlap, because there's no tab lock.
- **Native:** Capacitor/Tauri SQLite has no transactions at all, despite the comment at `native/plugins.ts:69`. Each row autocommits, and a cold start with no snapshot makes one bridge call and one fsync per card.
- **Fix:** add `appendEventsWithMeta` in one transaction, wrap SQLite batches in `executeSet`/`BEGIN…COMMIT`, or rebuild seq from `max(seq)` at boot.
- PLAUSIBLE for seq reuse.

**D12 [Medium] Cloud snapshots outgrow the decoder's cap** — `packages/core/src/sync/codec.ts:16-17`, `:378`; `sync/engine.ts:296`, `:317`, `:709`

- **The bug:** decode caps snapshots at 10 MiB compressed / 25 MiB uncompressed. A `ReviewRecord` is about 280 B, so collections past roughly 90k reviews write snapshots that no device can read. Bootstrap silently skips them, and the writer keeps uploading one every 500 events.
- **Memory:** `encodeUtf8` (`ids.ts:38-71`) builds one JS number per byte, which risks running out of memory on phones.
- **Fix:** skip the upload when it's over the read limit, or raise the limit and encode into a `Uint8Array`.

**D13 [Medium] Snapshot bootstrap ignores `state.formatVersion`** — `sync/engine.ts:297-302`

- **The bug:** an older build can hydrate a newer state format and drop fields it doesn't know, while the watermarks suppress the events those fields came from.
- **Fix:** skip candidates whose format is newer, as `backup/archive.ts:399` does.

**D14 [Medium] Replacing the collection keeps a stale Redo stack** — `packages/ui/src/state/AppContext.tsx:336-343`, `:1017`

- **The bug:** `handleReplaceState` and `resetLocalData` clear only `undoStack`. With deterministic starter card ids, Redo can then record a review taken from the other collection.
- **Fix:** clear `redoStack` with every `setUndoStack([])`.

**D15 [Medium] Reinstalling a pack isn't atomic** — `packages/platform-web/src/packs/dexie-pack-storage.ts:128-142`, `packs/web-pack-manager.ts:209-233`, `:203-226`

- **The bug:** old entries are deleted, new ones are written in batches of 2,000, and the `packs` row is written last. An interrupted reinstall leaves the old row saying "installed" over partial entries, so search silently returns fewer results.
- **Fix:** mark the row as installing first, and write the final row last.

**D16 [Medium] "Remove unused media" can delete a file an import just stored** — `packages/ui/src/check/checkRunner.ts:80-100` vs `sourceRunner.ts:484`, `:1707`, `googleDriveFileSource.ts:643`

- **The bug:** `putMedia` runs seconds before `MediaAdded` and the notes. A check in that gap deletes the file.
- **Fix:** skip files younger than a few minutes, or share an "import running" flag.
- PLAUSIBLE.

**D17 [Medium] Dictionary "Add Card" on an existing entry resets the user's edits** — `packages/ui/src/dictionary/DictionaryPanel.tsx:1092-1118`, `:285-289`

- **The bug:** the note id is deterministic and the button stays enabled, so tapping it again overwrites the edited fields and tags.
- **Fix:** disable the button for entries already in the deck.

**D18 [Medium] The local snapshot is serialized later than its `localSeq`** — `AppContext.tsx:419-446`

- **The bug:** the watermarks are read at emit time, but the queue serializes the live, mutated state later. The snapshot can therefore already contain events that the stored `localSeq` predates, and boot re-applies them.
- **Effect:** none while every event type stays idempotent.
- **Fix:** serialize when the watermarks are read.
- PLAUSIBLE.

**D19 [Medium] A moved note's reviews replay under the new deck's FSRS params** — `packages/core/src/events/replay.ts:432-437`, `:319`

- **The bug:** `fsrs_params_version` numbers are per deck, but they are resolved against `card.deck_id`, the deck the note is in now. Moving a note silently reschedules its cards.
- **Next step:** decide the intended behaviour.
- PLAUSIBLE.

**D20 [Low] Smaller convergence issues**

- `MediaAdded` fields are written in arrival order, not by LWW (`replay.ts:1260-1271`).
- `EventFactory.setHlc` can move the clock backwards (`replay.ts:1815`); use `max`.
- `decodeUtf8` swallows 3 bytes after an invalid byte (`utf8-decode.ts:22-26`), which corrupts a JSONL segment and fails every sync. Emit U+FFFD and advance 1 byte.
- A sync hydrate drops a rating made during its await window (`ui/src/state/syncRunner.ts:389-409`).

## 2. Security

**S1 [Medium] ✔ `?device=` turns on dev overrides in production** — `apps/web/src/main.tsx:88`, `:117-125`

- **The bug:** `isDevMode = DEV || Boolean(resolved.slug)`. In a production build, `?device=x&licensePubKey=<own key>` lets a user sign their own licence for a gated build. `?starterCatalog=https://evil/…` feeds attacker-chosen starter decks into onboarding.
- **Fix:** allow those overrides only under `import.meta.env.DEV`, as `msClientId` already does.

**S2 [Medium] Token helper: missing Origin skips the allowlist, and there's no rate limit** — `apps/token-helper/src/index.ts:242-252`, `:67-69`

- **The bug:** a non-browser client gets full use of the confidential client secret for exchange and refresh. `request.text()` buffers any body size before the size check.
- **Fix:** require an allowed Origin on POST routes, add a Cloudflare rate-limit rule, and check `Content-Length` first.

**S3 [Medium] No `frame-ancestors` or `X-Frame-Options`** — `apps/web/public/_headers:1-3`

- A meta-tag CSP can't carry `frame-ancestors`, so the app can be framed and clickjacked into Reset or Disconnect.
- **Fix:** add `frame-ancestors 'none'` to the `_headers` CSP.

**S4 [Medium] Field keys that shadow `Object.prototype` crash replay** — `packages/core/src/import/anki/model-plan.ts:316`, `packages/content-schema/src/index.ts:7`; read at `audio/tts.ts:237`, `replay.ts:475`, `model/optional-cards.ts:55`, `study/choice.ts:66,80`

- **The bug:** an Anki field named "Constructor" or "toString", or a `.flashpkg` key `__proto__`, makes `note.fields[key]` return a function when the note leaves that field empty. `?.trim()` and `extractClozeNumbers` then throw inside replay.
- **Fix:** restrict keys to `^[a-z0-9_]+$` in the schema and `uniqueKey`, and read fields with `Object.hasOwn`.

**S5 [Medium] ReDoS in the page markdown sanitizer** — `packages/core/src/sources/pages.ts:138`, `:158`

- **Measured:** the time grows quadratically. 20k spaces after `<a` take 137 ms, and a 1 MB input would take minutes. The input comes from `.flashpkg` and Google Docs.
- **Fix:** use `\s[^<>]*` and an `indexOf` scan, or cap the page size first.

**S6 [Medium] CSV export allows formula injection** — `packages/core/src/import/csv-export.ts:69`, `export/anki/select.ts:40`, `sources/tabular.ts:1039`

- **The bug:** cells starting with `=`, `+`, `-` or `@` export as is, so `=HYPERLINK(...)` runs when the file is opened in Excel.
- **Trade-off:** Korean grammar entries like `-(으)ㄴ` legitimately start with `-`.
- **Fix:** prefix `'` only in the "for other apps" mode.

**S7 [Medium] ✔ The packs deploy action holding secrets is on a floating tag** — `.github/workflows/publish-packs.yml:159`

- `cloudflare/wrangler-action@v3` gets `CLOUDFLARE_API_TOKEN`, against the repo's own SHA-pinning rule.
- The same workflow also grants unneeded `pages: write` and `id-token: write`, has no `concurrency` group and no deploy timeout, and uses `@v4` for the `actions/*` steps where the other workflows use `@v7` (`:31-34`).

**S8 [Medium] Store refunds never revoke the unlock** — `packages/platform-capacitor/src/purchase/store-purchase.ts:59-70`, `:107-121`

- **The bug:** `restorePurchases` only ever sets the cached entitlement. `purchased: Boolean(tx.transactionId)` (`native/plugins.ts:364`) may also unlock a Play purchase that is still pending.
- **Fix:** clear the cache when the product is absent on restore, and check the purchase state.

**S9 [Medium] An MCP `propose_package` call can upgrade existing decks** — `tools/cli/src/mcp.ts:585`, `:630`

- **The bug:** the caller chooses `packageId` and note ids. A prompt-injected tool call that reuses an earlier package's id rewrites or restores notes when the Inbox auto-imports.
- **Fix:** always use `pkg:ai-proposal:<uuid>`.
- PLAUSIBLE.

**S10 [Low] Picker deep link**

- **No `state` nonce:** `packages/platform-capacitor/src/sources/native-picker-bridge.ts:93-135` accepts any `flashcards://picker-callback` that arrives while a pick is pending, and Tauri matches it by prefix (`platform-tauri/src/native/plugins.ts:249`).
- **Token in history:** the `#access_token` fragment stays in browser history. Call `history.replaceState` in `picker.js`.

**S11 [Low] API keys in URLs**

- The Google Cloud TTS key is sent as `?key=` (`platform-web/src/audio/tts-providers.ts:102`, `tools/cli/src/commands/audio.ts:98`); use the `X-Goog-Api-Key` header.
- The CLI takes the key only as `--key`, which puts it in shell history (`tools/cli/src/index.ts:181`).

**S12 [Low] Placeholder licence public key**

- The default key is a placeholder pattern (`platform-web/src/purchase/web-license-purchase.ts:18-19`, copied in `store-purchase.ts:28`). It fails closed, with no warning.
- Capacitor never receives a key or crypto provider (`platform-capacitor/src/index.ts:123-127`), so licence-key activation can't work on phones.

**S13 [Low] Smaller items**

- OAuth PKCE records never expire (`auth/google-oauth-web.ts:332`, `dropbox-oauth-web.ts:150`, `microsoft-oauth-web.ts:232`).
- `file_paths.xml` exposes the external-storage root; `cache-path` is enough.
- The upstream full packs aren't hash-pinned, and Unihan uses `latest` (`scripts/fetch-upstream-packs.mjs:72-81`).
- Pack manifest `license_url`/`source_url` aren't https-validated (`dictionary/pack-codec.ts:500-512`); that's latent today.
- One licence has four valid base64url spellings (`license/index.ts:87-121`).

## 3. Correctness and edge cases

**Study and app shell**

- **C1 [High] ✔ Key auto-repeat rates unseen cards** — `packages/ui/src/screens/StudyScreen.tsx:675-688`, `study/studyGestures.ts:173-180`
  - Holding ← rates several cards Good. A quick double `2` on a choice card picks option 2, then rates the card through the global shortcut. `z` auto-repeat undoes several reviews.
  - **Fix:** return early on `e.repeat`.
- **C2 [High] No app-level error boundary** — `packages/ui/src/FlashcardsApp.tsx:67-119`
  - The only boundary sits inside `lazyWithRetry`. A card that throws in `FlipMode` → `RichText` unmounts the root on every launch, because the same card comes first in the queue.
  - **Fix:** add one boundary around `ScreenRouter`, and a per-card boundary keyed by `card.id`.
- **C3 [Medium] Arrow keys rate the card while focus is on any other button** (Filter, Undo, the SRS chip, popover buttons) — `study/studyGestures.ts:119-134`. This breaks D-pad navigation.
- **C4 [Medium] The next card's answer flashes for a frame** when the card changes without a rating (a sync merge, a clock tick). The reveal state resets in `useEffect` (`StudyScreen.tsx:482-504`); use `useLayoutEffect`, or key the state by card id.
- **C5 [Medium] A queue left open across the day boundary never refreshes** (`StudyScreen.tsx:356-369`). Bump `clockTick` on `visibilitychange` and at the next rollover.
- **C6 [Medium] Reset Local Device Data has no confirmation in production** (`screens/SettingsScreen.tsx:1074-1083`).
- **C7 [Low] Sync can stick at "syncing"** if `syncRunner` fails to load (`state/useSyncController.ts:276-287`, no `catch`).
- **C8 [Low] Undo has no "newer review" guard**, and it silently pops entries from other decks (`AppContext.tsx:591-610`).
- **C9 [Low] A lazy answer mode's error sticks across cards** (key the mode element by `card.id`: `answerModes/registry.ts:282-305`).
- **C10 [Low] A card repeated back to back keeps its old state** (no Listen replay, stale typed input).
- **C11 [Low] Light dismiss of the note editor discards edits silently** (`NoteEditDialog.tsx:343`).
- **C12 [Low] The Android Back handler fakes Escape for ARIA modals**, so a modal that listens for Escape elsewhere can stop Back from ever minimizing the app (`FlashcardsApp.tsx:54-57`).

**Sources, import and dictionary**

- **C13 [Medium] ✔ The launch auto-refresh skips Dropbox and Drive file sources**: `hasAny` doesn't check `dropboxSources` or `googleDriveFiles` (`AppContext.tsx:500-505`).
- **C14 [Medium] The free-tier deck limit is checked only at link time**: folder scans and package refreshes add decks freely (`sourceRunner.ts:1700`, `:1762`, `:2036`, `:2189`).
- **C15 [Medium] Dictionary search results can arrive out of order** (no request token: `DictionaryPanel.tsx:1038-1065`).
- **C16 [Medium] ✔ `Math.max(...array)` throws past about 150k items**, so CSV export of large decks and Card ID write-back on large sheets fail (`csv-export.ts:98`, `sources/tabular.ts:1080`).
- **C17 [Low] CSV round trip isn't lossless.** Cells are trimmed (`csv.ts:283`), and tags containing `,` from `.flashpkg` or Anki split in two on re-import.
- **C18 [Low] Duplicate zip entry names: the last one wins**, and detection reads the central directory while import reads local headers (`safe-unzip.ts:128`).
- **C19 [Low] Anki HTML and cloze edge cases.** An unclosed `<rp>` drops the rest of the field (`anki/html.ts:510-512`). `{{c1::{a}}` is read as unclosed (`parsers/cloze.ts:252-281`). The exporter can write duplicate record ids (`flashpkg.ts:287`).
- **C20 [Low] Template-created Sheet left orphaned** if the first pull fails (`sourceRunner.ts:803-825`). The PERMISSION_DENIED fallback keeps stale race data (`:1032-1048`).
- **C21 [Low]** One-shot Dropbox and OneDrive `.xlsx` imports skip `canReadExcel`. Onboarding Back stays enabled while busy. Add-device copy for Local folder is wrong, and the dev QR points at localhost.

**Platform adapters**

- **C22 [Medium] Drive reports 403 `rateLimitExceeded` as PERMISSION_DENIED**, so throttled users are told to reconnect (`google-drive-transport.ts:133-139`, `google-sheets-docs.ts:134-140`).
- **C23 [Medium] Drive `ifAbsent` is check-then-create.** Two devices initialising at once can create two manifests (`google-drive-transport.ts:279-344`). PLAUSIBLE.
- **C24 [Medium] Inner lazy loaders cache a failed `import()` for good** (`lazy-services.ts:74-79`, `:95-109`; `index.ts:58`; `native-support.ts:180`). The outer loader already clears its cache on failure; copy that pattern.
- **C25 [Low] Several of these never settle.** The Anki reader and FSRS optimizer workers have no `onmessageerror` handler or timeout. `WebFiles.pickFile` hangs if `arrayBuffer()` rejects. `WebAudioPlayer.play(…, cacheHash)` swallows a playback failure.

**Tooling**

- **C26 [High] ✔ One non-object JSON line kills the MCP server** (`null` → TypeError on `req.id`: `tools/cli/src/mcp.ts:741`, `:767`). Batches, `"x"` and objects without `method` are dropped instead of getting a −32600 reply.
- **C27 [Medium] `flash-cli inbox` without `-o` moves the files to `imported/` and writes nothing.** Even with `-o`, it moves them before writing (`commands/inbox.ts:163-180`).
- **C28 [Low]** Boolean CLI flags swallow the next positional (`index.ts:31-38`). `audio` loses every paid synthesis when one request fails (`audio.ts:224`). MCP window arguments are unbounded (`mcp.ts:541-544`).

## 4. Native shells

- **N1 [High] ✔ Desktop Dropbox sign-in always fails when a keychain exists** — `apps/desktop/src-tauri/src/secure_store.rs:10` vs `packages/platform-tauri/src/native/boot.ts:156`
  - `ALLOWED_ACCOUNTS` lacks `dropbox-refresh-token`, so `secure_store_set` errors right after the user approves in the browser.
  - **Fix:** add the account, plus a test that keeps the Rust and TS lists in sync.
- **N2 [High] ✔ The iOS `SceneDelegate` builds a plain `CAPBridgeViewController()`** — `apps/mobile/ios/App/App/SceneDelegate.swift:10-11`
  - `ICloudDocumentsPlugin` is registered only in `MainViewController.capacitorDidLoad`, so iCloud sync, the iOS default, probably never works.
  - **Fix:** use `MainViewController()`.
  - Confirmed in code; not yet seen on a device.
- **N3 [High] ✔ The service worker's navigation fallback has no denylist** — `apps/web/vite.config.ts:141-160`; the built `sw.js` registers `NavigationRoute(index.html)`
  - Custom Tabs share Chrome's service worker. Once the PWA has been opened, `picker.html#access_token=…` loads the app instead of the Picker. The same happens to the `.txt` notice pages.
  - **Fix:** `navigateFallbackDenylist: [/^\/picker\./, /\.txt$/, /^\/packs\//]`.
- **N4 [Medium] Native Google refresh after a cold start asks for no scopes** (`lastScopes = []`: `platform-capacitor/src/auth/google-social-login.ts:154`, `:190`). Drive calls start failing about an hour after relaunch.
- **N5 [Medium] OneDrive and Dropbox overwrite each other's capgo oauth2 config on Android**. Each calls `SocialLogin.initialize` with one provider, and Android replaces the map entry (`native/microsoft-social-login.ts:56`, `native/dropbox-social-login.ts:75`).
- **N6 [Medium] Loopback OAuth and the system-browser picker wait forever** (no timeout or cancel). Dropbox's fixed ports stay bound, and `onUrl` isn't awaited before `openUrl` (`platform-tauri/src/native/plugins.ts:242-262`, `:343-366`, `microsoft-loopback.ts:304-321`, `dropbox-loopback.ts:108-125`).
- **N7 [Medium] The sync `secure_store_*` Tauri commands run on the UI thread.** A locked keychain freezes the window at boot. Make them `async` with `spawn_blocking`.
- **N8 [Low]**
  - The Inbox move overwrites an earlier import with the same name (`tauri-fs-watcher.ts:203-213`).
  - The folder watcher has no `.catch` (`plugins.ts:177-190`).
  - `AndroidTtsPlugin.speak` ignores `getMaxSpeechInputLength()`.
  - The Microsoft loopback redirects to `localhost` while listening on 127.0.0.1.
- **N9 [Low] The production fallback is a SQL emulator.** `InMemorySqliteDriver` (about 260 lines) is the silent fallback when no driver is passed, so a wiring mistake loses data without an error; move it to tests or throw. Tauri also lacks the `secure_delete`/VACUUM scrub that Capacitor does.

## 5. Performance

- **P1 [High] ✔ The bundle budget is exhausted**: 159.70 / 160 KB. `.size-limit.json` matches only `index-*.js` and reports 121 KB, so its "Size" line undercounts; the real gate is `scripts/check-no-fonts.mjs`. Before the next feature, either buy back headroom (moving any `core-runtime` module that the first paint doesn't need, or splitting AppContext) or get the owner's OK for a raise.
- **P2 [Medium] Each rating rebuilds the whole queue during render** (`StudyScreen.tsx:356-360`). `collectTodayActivity` walks every review of every card (`core/src/study/queue.ts:193-213`); skipping cards whose `last_reviewed_at` predates today's rollover removes most of the work. Measure with a 20k-card fixture against the 16 ms target.
- **P3 [Medium] The context value is rebuilt on every provider render.** `useSyncController` returns a new object each time, and `emitEvents` depends on it, so every sync tick re-renders every `useApp()` consumer (`state/useSyncController.ts:596-611`, `AppContext.tsx:449`, `:1073-1128`).
- **P4 [Medium] A new FSRS scheduler is built for each replayed review** (`fsrs/scheduler.ts:99`, `replay.ts:431-438`, `stats/stats.ts:433`). Cache one per `(deck, params_version)`.
- **P5 [Medium] The materialized card cache is write-only.** `loadMaterializedCards` and `getEventsForCard` have no production caller, but every persist writes the cache (`dexie-storage.ts:283-304`). Read it at boot (blueprint §191) or stop writing it.
- **P6 [Medium] The stroke recognizer reloads its whole index on every call**, and for Korean the whole Hanja dictionary too (`drawing/web-stroke-recognizer.ts:124-157`). Cache them by `installedAt`.
- **P7 [Medium] Find and replace runs the user's regex over every selected note on each keystroke** (`browse/FindReplacePanel.tsx:85-98`). Debounce it, and run the full plan only on Apply.
- **P8 [Medium] Unbounded reads into memory:**
  - The Anki, backup and pack pickers have no `maxBytes` (`AnkiImportPanel.tsx:322`, `BackupsPanel.tsx:226`, `PackManagerPanel.tsx:186`).
  - Full backup download loads all media first (`backupRunner.ts:136-148`).
  - Six HTTP downloads read whole chunked bodies before the size check (image/audio processors, Dropbox/OneDrive pickers, Sheets/Docs, stroke provider).
- **P9 [Low]**
  - `ReminderRuntime` rebuilds the queue after every review.
  - `DictionaryPanel` rebuilds its presence index on every `stateVersion`.
  - `sha256Hex` copies its whole input before hashing.
  - `rowsOf` builds one `Map` per Anki SQLite row.
  - `pushUnique` is O(n²) in the Anki template parser.
  - Retained events are deep-cloned on every hydrate.
  - `MediaImage` re-reads IndexedDB on every `stateVersion`.
  - Browse filters on every keystroke without `useDeferredValue`.

## 6. Redundancy

- **R1** Fetch-with-auth-retry is written five times: `google-drive-transport.ts:88-152` ≈ `google-sheets-docs.ts:87-153`, `graph-client.ts:126-144`, `dropbox-picker.ts:214-240`, and none in the Dropbox transport. One `AuthorizedHttpClient` would fix D1c and C22 too.
- **R2** Token refresh (`getValidAccessToken`/`performRefresh`/`inFlightRefresh`) is triplicated across the Google, Dropbox and Microsoft web auths.
- **R3** `base64Url` plus PKCE pair creation exist six times (three web auths and three Tauri loopbacks). The whole Tauri "start server, onUrl, openUrl" block is copied three times.
- **R4** The cloud sources:
  - `dropboxSourceRunner.ts` (455 lines) is the OneDrive half of `sourceRunner.ts:1145-1588` renamed. It redefines five helpers it already imports, through a circular import.
  - `googleDriveFileSource.ts:452-601` repeats the same flow a third time.
  - One runner parameterised by `{kind, idOf, getInfo, download}` would remove about 600 lines.
- **R5** `DropboxPickerPanel.tsx` and `OneDrivePickerPanel.tsx` (390 lines each) differ only in copy and crumbs. `DropboxLinkMapping.tsx` is a stale copy of `LinkedFileMapping.tsx`, which describes itself as shared by all three providers. `dropboxImport.ts` ≈ `oneDriveImport.ts`, and `dropboxLinkedDeck.ts` ≈ `oneDriveLinkedDeck.ts`.
- **R6** `preLocalizeHttpsImageUrls` ≈ `preLocalizeHttpsAudioUrls` (`sourceRunner.ts:438-638`, about 85 lines each).
- **R7** The answer modes share 12–24 line shells: `ChoiceMode.tsx:82-96` ≈ `TypedMode.tsx:44-58` ≈ `DrawMode.tsx:78-89`, and the rating footers in all five modes.
- **R8** Small helpers copied around:
  - a code-unit comparator, 12 or more times (`cmpStr` in nine core files, plus `compareRawKeys`, `compareLayouts`, `cmpCodeUnits`; use `compareCodeUnits`);
  - three CSV cell escapers with drifting rules;
  - three path validators with different rules;
  - three capped body readers;
  - four `bytesToBase64`/`base64ToBytes` (one concatenates per byte);
  - three `cardToRow`;
  - three `isNavigatorOnline`;
  - three map-set helpers;
  - "active reviews, filtered and sorted", five times;
  - the per-review FSRS loop, in both `stats.ts` and `replay.ts`;
  - the six-field deck-settings list, hand-kept in three places;
  - `safeSlug` = `ankiExportSlug`;
  - the layout and note-type payloads, copied between `.flashpkg` export and import;
  - the device-speech wrappers (`platform-capacitor/src/audio/native-device-speech.ts:29-41` ≈ `platform-web/src/audio/device-speech.ts:38-50`).
- **R9** Each of these sync/async pairs implements the same logic twice: `buildBackup`/`packBackup`/`withBackupMedia` and `compareCollectionStates`/`rebuildFromEvents`. Production uses only the async versions.
- **R10** Two independent snapshot counters (`lastLocalSnapEventsRef`, `lastLocalSnapshotCountRef`). There are about 20 dead `stateRef.current ?? collectionState` fallbacks.

## 7. Dead, orphaned and obsolete

- **X1 Referenced nowhere, tests included:**
  - `shouldUpgradePackage` (`core/src/sources/catalog.ts:115`)
  - `STUDY_METHODS`, `STUDY_ORDERS` (`study/card-order.ts:11-12`)
  - `STUDY_SET_MODES` (`study/custom-study.ts:41`)
  - `parseSegmentNumber` (`sync/codec.ts:129`)
  - `topicEnglishLabel` (`ui/src/dictionary/dictionary-home-model.ts:74`)
  - `createEmptySourcesRegistry` (`ui/src/sources/sourceRunner.ts:98`)
  - `listRegisteredAnswerModes` (`ui/src/study/answerModes/registry.ts:49`)
  - `encodeTextUtf8` (`tools/cli/src/commands/build.ts:427`)
  - six content-schema types and `LogRetainedEventType`
- **X2 Production code that only tests call:**
  - `listFolderDecks`, `summarizeDictionaryBrowse`, `getAttributionForPack`
  - `isStudyMethod`, `isPracticeOrder` (`replay.ts:1436-1450` inlines the same checks instead)
  - `getExtraNewCardsToday`, `formatThirdPartyNotice`, `buildFamilyCatalogJson`
  - `encodeLicenseKey` and `resetUuidv7StateForTesting` (both intended)
- **X3 Dead branches and fields:**
  - the third `find` in `flashpkg.ts:669-671` (D6)
  - the `exceeded` flag in `pack-codec.ts:114`, `:133`
  - `UndoEntry.deckId` (written, never read)
  - `!this.createAudioElement` (`web-audio-player.ts:82`)
  - the inert `studyDayIndex` memo (`StudyScreen.tsx:446-457`)
- **X4 Unused API surface:**
  - 11 `platform-web` `package.json` subpath exports have no importer: `./sync-drive`, `./sync-local-folder`, `./auth-google`, `./replay-worker`, `./sources-google`, `./sources-local`, `./sources-http`, `./media-image`, `./media-audio`, `./audio-tts`, `./sync-dropbox`. `sources/google-index.ts` exists only for one of them.
  - `Auth.needsInteractiveRenew`/`renewInteractively`, `Storage.getEventsForCard`, `loadMaterializedCards` and `getEvents(sinceHlc)` have no production caller.
  - `ui/src/index.ts` re-exports five symbols that nothing imports.
  - Core's `export *` leaks `@internal` helpers (`planNoteCards`, `rebuildCardsForNote`, `applyMediaRemoved`, …).
  - About 130 values and 315 types are exported but only used in their own file.
- **X5 Obsolete:**
  - `spikes/phase0/`: last touched 2026-11-21, still linted. `docs/setup-gcp-cloudflare.md:102-107` tells users to deploy it, and it asks for a TTS key in a public page. Close ADR 0001 and drop it.
  - `apps/mobile/android/app/src/main/res/xml/config.xml` is a Cordova leftover.
  - `packages/ui/src/utils/` is an empty folder.
- **X6 Unused dependencies:** `apps/desktop` (`@flash/core`, `@flash/platform`, `@flash/platform-tauri`) and `apps/mobile` (`@flash/core`, `@flash/platform`, `@flash/platform-capacitor`) have no JS source. `@flash/platform-tauri` depends on `@flash/platform-capacitor`, which pulls 11 Capacitor plugins into desktop; move the shared SQLite code into a neutral package.
- **X7 Stale comments and docs:**
  - `native/plugins.ts:69` claims BEGIN/COMMIT, but no transaction exists.
  - `getActiveFsrsParamsVersion` says "at `nowMs`", but takes no time (`replay.ts:365`).
  - `csv.ts:28` says "RFC 4180 compliant", but the parser is lenient.
  - README says "Phases 1–8".
  - AGENTS.md lists token-helper routes as `/exchange`, but the code uses `/auth/exchange`.
  - "Web Audio preloader" is wrong: there's no AudioContext.
  - AGENTS.md claims typecheck covers every package, but it skips the tests.
  - `apps/desktop` "typecheck" only parses JSON.

## 8. Tooling, CI and dependencies

- **T1 [High] ✔ Tests are never typechecked.** Every tsconfig except `apps/web` includes only `src/**`. A scratch config found 115 errors (44 are only the missing `@types/node`), for example `license.test.ts:113`, `sources.test.ts:34`, 33 in `anki-apkg-history.test.ts`, and `fc.TypeOf`. **Fix:** add a `tsconfig.test.json` per package (or one at the root), plus `@types/node`, and wire them into `pnpm typecheck`.
- **T2 [High] The weekly pack refresh never refreshes.** `restore-keys` restores last week's files, and the fetch script skips any existing file without a version. Only KanjiVG ever updates (`publish-packs.yml:58-68`, `fetch-upstream-packs.mjs:252-257`). **Fix:** pass `--force` on a cache miss.
- **T3 [Medium] ESLint has no type-aware rules** (`no-floating-promises`, `no-misused-promises`), which matters for an app this async. React hooks is wired with only two rules, and token-helper gets Node globals instead of Worker globals (`eslint.config.js:26`, `:120-123`, `:133`).
- **T4 [Medium] No dependency review, `pnpm audit` or CodeQL in CI**, and Dependabot skips `cargo` and `gradle` (`.github/dependabot.yml`).
- **T5 [Low] `ci.yml` cancels in-progress runs on `main`** (`cancel-in-progress: true`), so not every commit is verified.
- **T6 [Low] A regenerated starter pack fails `format:check`.** The committed stroke JSON was Prettier-formatted, but the generator writes minified JSON; add `apps/web/public/packs/` to `.prettierignore` and a `--check` mode.
- **T7 [Low] `fetch-starter-sources.mjs` caches the Wikidata JSON before verifying it** (`:139-149`).
- **T8 [Low] Engines and tsconfigs:**
  - `engines.pnpm >=10` vs `packageManager pnpm@12.18.0` and pnpm-12-only workspace settings.
  - The CLI uses a hand-written Node shim plus DOM types.
  - `erasableSyntaxOnly` is set only in core, though the CLI and content-schema also run through type stripping.
- **T9 [Low] Test-only dependencies are undeclared.** `vitest`, `fast-check`, `fake-indexeddb` and `sql.js` resolve only through root hoisting, and the scripts `createRequire` `fflate` from core.

## 9. Test gaps

- **No shared transport conformance test** (NOT_FOUND on read, ALREADY_EXISTS on `ifAbsent`, 401, 429) run against every `SyncTransport` fake. This one test would have caught D1, D1b and C22. Also make the `SyncTransport` interface document that error contract (`platform/src/index.ts:230-235`).
- **Sync engine:** a NOT_FOUND segment between present segments, and a snapshot over the decode cap.
- **Replay:**
  - malformed or `v > 1` payloads;
  - field keys `constructor`/`__proto__`;
  - the property tests never generate a deck archive, a duplicate `DeckCreated`, a note move, or a `MediaAdded` with a differing `tts_key`.
- **`.flashpkg`:**
  - import into a collection that already has `preset:*` types or colliding deck ids;
  - the file-count, size and media-hash rejections (tested only for Anki).
- **UI state:**
  - `rateCard`/`undoLastReview`/`redoLastUndo` have no unit tests;
  - `emitEvents` with a failed persist;
  - which fields `NoteEditDialog` sends on save;
  - `resolveStudyKeyAction` with `repeat` or with focus on a button.
- **Sources:**
  - `source-runner.test.ts` has only 4 tests;
  - no end-to-end Sheets write-back test;
  - no test of two concurrent refreshes or the launch `hasAny` check;
  - no unit test for `dropboxImport.ts`.
- **Native:**
  - nothing ties the Rust `ALLOWED_ACCOUNTS` to `boot.ts`;
  - event SQL runs only against `InMemorySqliteDriver`, never real SQLite;
  - no test of a Google refresh on a fresh instance, of loopback timeouts, or that `sw.js` leaves `picker.html` alone;
  - `packages/capacitor-secure-storage` has no TS tests.
- **CLI:** `runCli` and `runMcpStdioServer` are untested.
- **Flaky patterns:**
  - `backup-runner.test.ts:269-295` races real timers;
  - `phase5-audio.spec.ts:293`, `:406`, `:610`, `:633` sleep, then assert absence;
  - CI `retries: 2` hides flakes, and no reporter shows which tests needed a retry.
- **Coverage and the uncommitted fix:** `vitest.config.ts` has no coverage threshold. Nothing tests the `free()`-throws path of the uncommitted change (the change itself is correct).

## 10. Accessibility and UX safety

- **No `aria-live` anywhere in the study flow.** Revealing a card or moving to the next one announces nothing, and the due-count chips read as "3 0 12" (`study/StudyCard.tsx:176-268`, `StudyScreen.tsx:902-927`).
- **Header controls are about 28 px tall**, below the 44 px touch target.
- **Destructive actions without confirmation:** C6 and C11 above.
- **The study screen captures arrow keys** (C3), which breaks D-pad navigation (blueprint §610).

## 11. Nits

- `ChoiceMode` reshuffles its distractors when a sync lands mid-question (`ChoiceMode.tsx:32-36`).
- `EmptyCollection.tsx:126` and `void startWithDeck` produce an unhandled rejection.
- The token helper returns 200 with `undefined` fields when the upstream reply has no `access_token`.
- `pinyin.ts` tone-marks any word followed by a digit (`Windows1` → `Windōws`).
- `as KnownEvent[]` (`checkRunner.ts:87`) and the `MutableRefObject` casts (`AppContext.tsx:347`, `:743`) hide type gaps.
- `.claude/worktrees/` is ignored only through `.git/info/exclude`, so another clone could commit it; add it to `.gitignore`.
- `isSafeDriveUrl` uses prefix checks; parse with `URL` instead.
- `includes('..')` rejects legitimate names like `a..b.csv` in several path checks.

## What's in good shape

- **Archives and parsers:** zip caps run on the bytes actually inflated, mid-stream. `.flashpkg` media hashes are checked. The Anki HTML converter is a scanner that outputs plain text only. The zstd, protobuf and licence-signature code is sound. Zod strips `__proto__`.
- **Raw HTML:** none reaches the DOM. PageViewer drops `html` nodes and allows https-only links.
- **Tauri:** the capability scopes are tight (http limited to three token hosts, opener to https). The `icloud.rs` path resolution and the Keystore/Keychain code look right.
- **CI hygiene:** no `pull_request_target`, no `${{ github.event.* }}` in `run:` steps, no `.only` or `.skip`. Every internal dependency uses `workspace:*`, and versions are consistent.
- **The uncommitted `fsrs.free()` change** is correct: each run gets a fresh Worker, so a poisoned WASM instance is never reused.
