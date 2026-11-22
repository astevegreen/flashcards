# Personal Language Flashcard App — Architecture & Design Blueprint (Final)

A **local-first, zero-server** foreign language flashcard and study app. Every device keeps a full copy of the user's data and studies offline. Devices sync through the user's *own* cloud storage (Google Drive first; Dropbox/iCloud/local folder pluggable). Sold once; if the developer stops working on it, nothing breaks.

---

## 0. Requirements and Where They Are Met

| # | Requirement | Where |
|---|---|---|
| R1 | Seamless sync between Android, iOS, and PC | §4 Sync |
| R2 | Lightweight, fast, smooth | §8 Performance budget |
| R3 | TTS, images, Japanese / Mandarin (simplified) / Korean + Hanja / English, typed and drawn input | §5 Study, §6 Asian languages, §7 Audio |
| R4 | Content beyond word/definition: grammar decks and long-form pages, made by each user and shareable | §2 Content model, §3 Sources and sharing |
| R5 | AI tools (Claude Code, Antigravity) can change the code and push content | §10 AI tooling |
| R6 | Sellable later (one-time purchase) on Google Play and the App Store; usable even if the developer stops | §11 Platforms, §12 Purchase and sunset |
| R7 | Android and iOS work with no internet connection; PC works the same as long as the decks are stored locally (e.g., Google Drive or Dropbox folders) | §1 Principles, §3.2 Local folders, §9 Offline guarantee |

---

## 1. Principles

1. **Local-first.** Each device holds the whole collection: decks, notes, pages, media, and review history. Study, browse, edit, and local file imports all work offline. The network is only used to sync, pull updates from Sheets/Docs/URLs, and optionally generate TTS.
2. **No backend database or user accounts.** The app is static files (a PWA now; Capacitor/Tauri shells later). The only outside services are the user's own cloud storage and Google APIs (plus a tiny stateless ~60-line Cloudflare Worker token-exchange helper for Web/PWA Google OAuth refresh that stores zero data).
3. **Events are the truth.** Every change the user makes is an immutable event. Card state, deck lists, and statistics are derived caches rebuilt from events. Sync means exchanging append-only event segments.
4. **Content is data, interactions are code.** Adding a new deck, grammar set, or lesson never needs code. Only a new *kind of interaction* (a new answer mode, a new page block) requires code.
5. **One content format.** Sheets, local files, Anki imports, AI tools, and shared decks all normalize into the same internal model and the same exportable `.flashpkg` format.
6. **Agents can run everything.** The app runs with no login and no network using sample data, so coding agents can build and test it end-to-end.
7. **Effortless onboarding.** A new user never runs a command, never creates an account for this app, never copies a key or token by hand, and signs in at most once per device (with the platform's own account picker) to turn on sync. All developer-side setup (GCP, Cloudflare, catalog URLs) is done at build time and is invisible to users. Security and store-policy compliance are never traded away for fewer taps. See Phase 14.
8. **Ship Phases 1–3 lean.** Keep `packages/core` data structures ready for Note Types, Pages, Courses, and Answer Modes from day one, but keep the Phase 1–3 UI laser-focused on a fast, polished Flashcards Deluxe replacement (Flip + FSRS + Sync + Sheets/Local Folders) before layering on Phases 4–8.

---

## 2. Content Model

### 2.1 Entities

```mermaid
erDiagram
    COLLECTION ||--o{ DECK : has
    COLLECTION ||--o{ NOTE_TYPE : defines
    COLLECTION ||--o{ PAGE : has
    COLLECTION ||--o{ COURSE : has
    NOTE_TYPE ||--o{ LAYOUT : "card templates"
    DECK ||--o{ NOTE : contains
    DECK }o--|| NOTE_TYPE : uses
    NOTE ||--o{ CARD : "generates (derived)"
    LAYOUT ||--o{ CARD : "generates (derived)"
    CARD ||--o{ REVIEW : "events"
    COURSE ||--o{ COURSE_ITEM : "ordered pages + decks"
    DECK }o--o| SOURCE : "imported from"
    PAGE }o--o| SOURCE : "imported from"
    NOTE }o--o{ MEDIA : references
    PAGE }o--o{ MEDIA : references
```

- **Collection**: One user's data. One collection per sync store. Family members each have their own collection; they share *decks and pages*, not collections.
- **Note type**: A named list of fields. Each field has:
  - `key` (e.g., `word`, `reading`, `meaning`, `example`, `image`, `audio`)
  - `kind` (`text` | `reading` | `rich` | `image` | `audio`)
  - `lang` (BCP 47: `ja`, `zh-Hans`, `ko`, `en`, `zh-Latn-pinyin`, …)
  - flags such as `tts: true` and `sortKey: true`
  - Built-in presets: *Vocabulary (JA)*, *Vocabulary (ZH)*, *Vocabulary (KO)*, *Hanja*, *Grammar point*, *Sentence*, *Cloze*.
- **Layout** (card template): Which fields go on the front, which are revealed and in what steps, the answer mode (§5.2), which field to speak and when, and whether furigana is hidden on the front. Every new deck starts with a *Recognition* layout; *Production* and other layouts are one-tap toggles. Each layout keeps its own FSRS schedule.
- **Note**: One row of content: `fields: Record<fieldKey, string>`, `tags[]` (the app's **categories**: Flashcards Deluxe `Category 1..N` columns and Sheet/CSV `Tags` import here; optional `::` hierarchy such as `Grammar::Particles`; filterable for Browse and Study, see Phase 9), a `source_key` (the Card ID from a Sheet, a package note ID, etc.), and `provenance` (`user` | `import` | `ai`, plus `reviewed: boolean`).
- **Card**: A `note × layout × variant` (the cloze number, else `0`). **Cards are derived, not stored as truth.** Their IDs are deterministic (`uuidv5(note_id, layout_id, variant)`), so every device produces the same cards without syncing them. Only reviews sync.
- **Page**: A long-form lesson written in Markdown with app blocks (§2.3).
- **Course**: An ordered list of pages and decks. An item can be marked "unlocks after page X is read", so grammar explanations precede drill decks.
- **Media**: Image and audio files stored under their content hash (`sha256.ext`). Synced alongside events.
- **Source**: Where a deck or page came from (`google_sheets`, `google_docs`, `local_file`, `package`, `package_url`, or `native` for in-app authoring). Remembered so updates can be pulled again.

### 2.2 Grammar Content: What Needs Code (R4)

| Form | Example | Needs new code? |
|---|---|---|
| Grammar deck | Side 1 grammar point, side 2 explanation, side 3 example | **No.** Just the *Grammar point* note type |
| Cloze drill | `私は{{c1::学生}}です` | Yes, once: cloze parser + one-card-per-blank generation |
| Typed/choice/drawn drills | Conjugate the verb, pick the particle | Yes, once per answer mode (§5.2) |
| Textbook-style page | Explanation, tables, examples with audio | Yes, once: page renderer + courses |

### 2.3 Pages

- **Syntax**: CommonMark + GFM tables + directive blocks. **No raw HTML.** Shared pages are untrusted input (§13).
- **Blocks:**
  - Ruby: the same `漢字[かんじ]` / `{base|reading}` syntax as cards (§6.2).
  - `::say[食べます]{lang=ja}`: speaker button using the TTS chain (§7).
  - `:::example` … `:::`: example sentence box with optional toggleable translation.
  - `:::note` / `:::warning`: callouts.
  - `::image[alt]{src=media-or-path}`
  - `::cards{deck="Particles" tag="は-vs-が"}`: inline mini-study session.
  - `::deck-link{deck="…"}`: opens a deck.
- **Progress**: A `PageRead` event when the user reaches the end or taps "Done".
- **Authoring**: In-app Markdown editor with preview, `.md` files in a linked local folder (PC), a Google Doc (exported as Markdown, cached offline), or a package.

---

## 3. Sources, Import, and Sharing

Every source is **imported into the local collection**. After that, its content reaches the user's other devices **through sync**, even if those devices cannot access the original file. The original source only matters when pulling updates.

### 3.1 Google Sheets (Decks) and Google Docs (Pages)

- **Scope:** `drive.file` (non-restricted—no CASA security audit, no 7-day refresh token wall once published to Production). Users link Sheets/Docs with the **Google Picker** (multi-select), or the app creates a new Sheet from a template.
- **Columns are matched by header name, not position.** Headers map to note-type fields (`Word`, `Reading`, `Meaning`, …, `Tags`, `Card ID`). Unknown headers are ignored with a warning; duplicate headers and trailing empty rows are handled safely.
- **Card ID write-back:**
  - Rows missing `Card ID` get a UUID, written in one `batchUpdate`.
  - Just before writing, the app re-reads the range and writes only to rows whose content is unchanged and still lacks an ID (guarding against concurrent sorts/inserts).
  - Duplicate IDs (from copied rows) are flagged, and the later row gets a new ID.
  - If two devices race, the ID already in the Sheet wins on the next pull.
- **Identity:** `note_id = uuidv5(deck_id, card_id)`, so every device importing the same Sheet produces identical notes without colliding across different users' copies of a shared Sheet.
- **Deleted rows:** Emit `NoteArchived`. Restoring the row restores the note and its full review history.
- **Updates:** Cheap `modifiedTime` check on open/refresh (when online). Changed rows are diffed by `content_hash`.
- **Images in Sheets:** URL in an image column or `=IMAGE(url)` (read via `valueRenderOption=FORMULA`). Embedded in-cell images are not readable via API and trigger a warning.
- **Google Docs → Page:** Drive export as `text/markdown` (verify in Phase 0), parsed into a Page and cached offline.
- **Shared Sheets:** A recipient with view access links the Sheet read-only. The owner must sync once so `Card ID`s exist.
- **On PC:** `.gsheet` / `.gdoc` files in a Google Drive folder are cloud-only pointers; they work through the Sheets/Docs API path above and are cached offline after the first pull.

### 3.2 Linked Local Folders (PC — R7)

- The user links one or more local folders (e.g., `G:\My Drive\Flashcards` or `C:\Users\…\Dropbox\Flashcards`).
- **Web build:** File System Access API (`showDirectoryPicker`). **Tauri build (later):** native filesystem + watcher.
- **Readable files:**
  - `.csv` / `.tsv` (header row works like Sheets; `Card ID` column appended with permission once per folder).
  - `.xlsx` read-only via **`read-excel-file`** (MIT, lightweight, lazy-loaded; replaces frozen npm SheetJS CE). Never written back; rows match by `sortKey` field with a reconciliation prompt if renamed.
  - `.md` as Pages.
  - `.flashpkg` packages (§3.4).
  - Images/audio referenced by relative paths.
- **Scanning:** Rescans on open and on "Refresh"; files are re-imported only when modified time or content hash changes.

### 3.3 Other Imports
- **Anki `.apkg`** (Phase 12; `sql.js` lazy-loaded): note types, fields, cloze, media, optionally review history.
- **Paste or CSV upload** in the app (all platforms).

### 3.4 Package Format (`.flashpkg` — Sharing, AI, Backups)

A `.flashpkg` file is a zip archive containing:

```
manifest.json      # package_id, name, version, format_version, author, license, languages
note_types.json
decks/<deck>.jsonl # one note per line: { id, fields, tags, provenance }
layouts.json
pages/<slug>.md
courses.json
media/<sha256>.<ext>
```

- Validated against a JSON Schema in `packages/content-schema` with machine-readable errors.
- **Upgrades preserve reviews:** Re-importing a newer version of the same `package_id` updates content while matching notes by their package note ID.
- **Sharing, Built-In Starter Decks & Family Library:**
  - Send `.flashpkg` directly (AirDrop, email, chat, Drive link).
  - **Subscribe to a package URL** (e.g., Cloudflare Pages / GitHub Pages with CORS).
  - **Built-in Starter Decks & Family Library catalogs:** Static `index.json` manifests listing vetted `.flashpkg` URLs, titles, and descriptions that users can browse and install in one tap without connecting Google Drive or Dropbox. Configure an optional default starter catalog via `VITE_STARTER_CATALOG_URL` alongside user-added Family Library catalogs.
  - **Free static-pack hosting pattern (shared with §6.3):** Keep deck/dictionary sources in a public GitHub repo and publish built static artifacts (`index.json`, `.flashpkg`, `packs.json`, dictionary/stroke packs) via GitHub Actions to **Cloudflare Pages** (free, unlimited bandwidth, custom CORS `_headers`, ≤ 25 MB/file) or **GitHub Pages** (and **Cloudflare R2** free tier if packs exceed 25 MB). Implemented by `scripts/fetch-upstream-packs.mjs` + `scripts/build-packs.mjs --full` and `.github/workflows/publish-packs.yml` (weekly + on push): as of Nov 2026 every full pack fits on Pages (largest: KanjiVG ≈ 12 MiB, Make Me a Hanzi ≈ 12 MiB, JMdict ≈ 7.5 MiB gzipped; ≈ 16.3k files incl. per-character stroke files vs. the 20k-file Pages limit), and the build fails fast if a pack crosses 25 MiB so it can be moved to R2. Avoid relying on `raw.githubusercontent.com` as a public CDN (rate limits / Git binary bloat) or GitHub Releases download URLs directly from browsers (redirect to `objects.githubusercontent.com` lacks CORS).
  - Share a Google Sheet (§3.1).
- **Export:** Any deck, page, course, or full collection can be exported as `.flashpkg`.

---

## 4. Sync (R1)

### 4.1 Event Log & Deterministic Replay

Every mutation is an immutable event:

```ts
interface Event {
  id: string;            // UUIDv7
  device: string;        // device ID
  seq: number;           // per-device, gapless, strictly increasing
  hlc: string;           // hybrid logical clock (wall time + counter + device)
  type: EventType;       // ReviewRecorded, ReviewUndone, NoteUpserted, NoteArchived,
                         // DeckCreated, DeckSettingsChanged, DeckFSRSParamsChanged,
                         // LayoutChanged, NoteTypeChanged, PageUpserted, PageRead,
                         // CourseChanged, MediaAdded, SourceLinked, …
  v: number;             // event schema version
  payload: unknown;
}
```

- **Reviews:**
  - `ReviewRecorded { review_id, card_id, rating, reviewed_at, tz_offset, duration_ms, answer_mode, typed_answer?, fsrs_params_version, resulting_due_at }`
  - `ReviewUndone { review_id }`
- **Deterministic card state & FSRS drift protection:**
  - Active reviews for a card (excluding any referenced by `ReviewUndone`) are sorted deterministically by **`(reviewed_at, hlc, review_id)`**—never wall clock alone—so clock skew cannot cause device divergence.
  - Two devices reviewing the same card offline both count in deterministic order; Undo appends `ReviewUndone` and replays that card so a later sync can never resurrect it.
  - **Parameter / version drift protection:** Changing `target_retention`, running the FSRS optimizer, or upgrading `ts-fsrs` emits a versioned `DeckFSRSParamsChanged { params_version, effective_from, params }` event. Replay applies each review under the parameters active at its timestamp (preserving historical intervals) unless the user explicitly triggers *"Reschedule existing cards with new weights."*
- **Other changes** (note fields, settings, layouts): Per-field Last-Write-Wins decided by `hlc`.
- **Local materialized cache:** Card state, due queues, and stats live in local tables. Incoming events replay only affected cards (off the main thread in a Web Worker). Full rebuilds occur only after schema migrations.

### 4.2 Sync Store Layout

```
sync/v1/
  manifest.json                    # collection_id, format_version, min_app_version
  devices/<device-id>/
    head.json                      # last segment number, last seq (only this device writes it)
    seg-000001.jsonl.gz            # write-once event segments
    seg-000002.jsonl.gz
  snapshots/<device-id>-<seq>.json.gz
media/<aa>/<sha256>.<ext>
```

- **Zero write conflicts:** Each device writes exclusively to `devices/<id>/`, and segments are write-once.
- **Push:** Write new segment, then update `head.json`. **Pull:** Read each device's `head.json`, then download unseen segments.
- **Snapshots:** Periodically compact state into a snapshot recording each device's watermark so new devices bootstrap quickly.
- **Size:** ~100 bytes/review (~2 MB gzipped per 100k reviews). Reviews are never deleted.
- **Triggers:** On app open, network reconnect, foreground/focus return (`visibilitychange -> visible` / `window.focus`, throttled with a 15 s cooldown), idle debounce after local mutations (~8 s), study-session exit, backgrounding (`visibilitychange -> hidden` / `pagehide` push), every 20 reviews or 2 minutes while studying, and manual Sync Now. Study UI never blocks on sync.
- **Forward/backward compatibility:** `manifest.json` carries `format_version` and `min_app_version`. Older app builds read what they understand, refuse to write to a newer format (prompting to update), and preserve unknown event types/fields untouched.

### 4.3 Transports & Auth

All transports implement one interface:

```ts
interface SyncTransport {
  list(prefix: string): Promise<FileInfo[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void>;
}
```

| Transport | Status | Platforms | Notes |
|---|---|---|---|
| **Google Drive (`drive.appdata`)** | **Primary v1** | All | Uses Google Drive's hidden singleton `appDataFolder` (non-restricted, no CASA audit, impossible to create duplicate split-brain folders, users can't accidentally delete `head.json`). Separate `drive.file` scope handles user-visible Sheets/Docs and optional backups. All platform OAuth Client IDs live in the **same GCP project**. |
| **Local folder** | **v1 (PC)** | PC | Reads/writes a local folder (useful for local-only backups or desktop sync tools like Syncthing/OneDrive). |
| **Dropbox (`App folder`)** | **Future plugin** | All | Pluggable `SyncTransport` using browser PKCE with offline refresh tokens; deferred until needed. |
| **iCloud Drive** | **Future plugin** | iOS / macOS (Capacitor) | Optional zero-login sync for iOS-only App Store users. |
| **Microsoft OneDrive (App folder)** | **Planned (Phase 12)** | All | Microsoft Graph `/me/drive/special/approot` with `Files.ReadWrite.AppFolder` (personal Microsoft accounts; work/school accounts would need broader `Files.ReadWrite`). Web/PWA routes the code exchange and refresh through `apps/token-helper` as a confidential client, because Microsoft gives SPA-registered clients 24-hour refresh tokens; native shells use MSAL public clients with rolling refresh tokens. Until then, PC users can already sync through the OneDrive desktop folder with the Local folder transport. |
| **In-memory** | **v1 (Dev/Test)** | Tests / Dev | Powers `?device=a` / `?device=b` local dev mode and multi-device tests. |

**Google OAuth & Silent Refresh on Web/PWA (Solving iOS Standalone PWA):**
- **Web/PWA (including iOS home-screen PWA):** Uses a standard **redirect-based OAuth flow** (avoiding broken iOS standalone popups) paired with a **stateless ~60-line Cloudflare Worker token helper** (§12.3).
  - On sign-in, the app exchanges the auth `code` via the Worker (`POST /auth/exchange`), which holds only the Google `client_secret` env var and **stores nothing**.
  - The device stores its own `refresh_token` in IndexedDB and silently refreshes access tokens (`POST /auth/refresh`) every ~55 minutes—giving iOS, Android, and PC PWAs seamless background sync with zero re-login taps.
  - If the Worker is ever shut down, Web/PWA falls back to Google Identity Services (GIS) tap-to-renew.
- **Native shells (Capacitor / Tauri):** Use native Google Sign-In (Android/iOS OAuth client types), which issues long-lived refresh tokens directly to Keychain/Keystore with **no Worker needed**.

### 4.4 Safety Nets
- Call `navigator.storage.persist()` on first launch.
- Weekly "Back up your collection" reminder (`.flashpkg` export) if sync is not configured.
- Restoring on a new device: connect Google Drive (`drive.appdata` auto-discovers the collection) or import a `.flashpkg` backup.

---

## 5. Study Experience

### 5.1 Shell and Controls
- **Shell:** Pure static SPA (Vite + React + TypeScript + Tailwind), zero SSR dependencies, Capacitor-ready `dist/`. Bottom tabs on mobile (`Study`, `Library`, `Browse`, `Settings`), collapsible left rail on desktop, `viewport-fit=cover` + `env(safe-area-inset-*)`.
- **Startup:** Reads due counts and queues directly from local DB—zero spinners before the first card.
- **Ratings:** `ts-fsrs` v5 with **3 buttons by default** (`Again` / `Good` / `Easy` = `1 / 3 / 4`). Settings allow enabling the optional **Hard** (`2`) button or switching to 2 buttons (`Again` / `Good`).

| Action | Desktop | Mobile |
|---|---|---|
| Flip / next reveal step | `Space` / `Enter` | Tap card |
| Again | `1` / `←` | Swipe left / button |
| Good | `2` / `→` | Swipe right / button |
| Easy | `3` / `↑` | Swipe up / button |
| Hard (if enabled) | `4` / `↓` | Button |
| Replay audio | `R` | Tap speaker |
| Slow audio (0.75×) | `S` | Long-press speaker |
| Toggle furigana / hints | `F` | Tap script pill |
| Undo | `Z` / `Ctrl+Z` | Undo button |
| Edit note | `E` | Card menu → Edit (opens source Sheet for Sheet-backed decks) |

Shortcuts automatically disable when a text input has focus.

- **Study rules:**
  - Configurable new cards/day and max reviews/day per deck; source or random new-card order.
  - **Sibling burying:** Recognition and Production cards of the same note don't both appear on the same day.
  - Target retention per deck (default `0.90`); study day starts at `04:00` local time (configurable); reviews store `tz_offset`.
  - **FSRS optimizer (Phase 11):** On-device WASM (`fsrs-browser`) parameter fitting.
  - **Filtered study, suspend, leeches and custom study:** Phase 9.

### 5.2 Answer Modes

Registered in a pluggable answer-mode registry; layouts pick one by name:

| Mode | Behavior | Suggested Rating |
|---|---|---|
| `flip` | Reveal steps, self-rate | — |
| `typed` | Type answer, show character diff vs. expected | Correct → Good, wrong → Again (overridable) |
| `choice` | 4 choices drawn from same field in same deck/tag | Same as `typed` |
| `cloze` | Masks each `{{cN::…}}` in turn; composable with `typed` | — |
| `listen` | Audio-only prompt on front | — |
| `draw` | Graded stroke drawing (§6.4) | Derived from stroke mistakes |

**Typed-answer matching (`packages/core`):**
- All languages: Unicode NFKC, trimmed, collapsed spaces, case-folded, punctuation ignored; `;` or `|` for alternate answers; `(…)` optional.
- `ja`: Live romaji → kana via `wanakana` (MIT); optional hiragana/katakana equivalence.
- `zh`: Tone marks and tone numbers compare equal (`ni3` = `nǐ`); optional ignore-tones toggle.
- `ko`: Unicode NFC so composed and decomposed jamo compare equal.
- **IME safety:** Ignore `Enter` while `event.isComposing` is true or `keyCode === 229`.

---

## 6. Asian-Language Support

### 6.1 Languages and Fonts
- **Supported:** `ja`, `zh-Hans`, `ko` (Hangul + Hanja), `en` (extensible to `zh-Hant` and others as data).
- **Explicit `lang` attributes** on every rendered field so CJK Han unification renders the proper regional glyph shapes (Japanese vs. Chinese vs. Korean Hanja).
- **Zero default web fonts (system-first):**
  - `ja`: Hiragino Sans, Yu Gothic UI, Noto Sans CJK JP
  - `zh-Hans`: PingFang SC, Microsoft YaHei, Noto Sans CJK SC
  - `ko`: Apple SD Gothic Neo, Malgun Gothic, Noto Sans CJK KR
  - Optional subsetted font packs downloadable if needed.

### 6.2 Ruby (Furigana, Hangul over Hanja, Pinyin)
- **Dedicated column + safe inline ruby:** Readings can live in a dedicated column (`Text 2` / `reading`) **and** inline `漢字[かんじ]` markup auto-renders as `<ruby>` wherever present.
- **Strict `X[Y]` rule:** Only parse `X[Y]` when there is **no space** before `[` AND the base run is Han characters (CJK extensions + `々 〆 ヶ`, or enabled via per-deck toggle). Thus `私の日本[にほん]` annotates `日本` only, and `word [formal]` is never touched.
- **`{base|reading}`:** Explicit form for kana bases, ateji, or per-character pairs (`{日本|に|ほん}`).
- **Hanja:** `學[학]` for Hangul reading; full 음훈 (e.g., `배울 학`) belongs in a dedicated field.
- **Pinyin:** Fields with `lang=zh-Latn-pinyin` convert tone numbers to tone marks with optional tone coloring.
- **Anki import:** Converts Anki's space-delimited ruby syntax on import.
- **Front-side toggle:** Furigana can be hidden on the front per layout and revealed on flip.

### 6.3 Offline Dictionary Packs (Phase 6)

Decks and dictionaries have distinct roles:
- **Decks** are user-managed study subsets tailored to what the learner wants to review with FSRS.
- **Dictionaries** are comprehensive, standalone downloadable offline reference packs (cached locally once on web, bundled in native builds) supporting **bidirectional lookup** (native English ↔ target language, readings, and handwriting) across the entire language—including terms not present in any installed deck. Any dictionary result offers a quick, 1–2 tap **"Add to Deck"** action (remembering the last-used deck per language, auto-mapping headword/reading/meaning fields, flagging existing duplicates, and emitting a standard `NoteUpserted` event so the new card syncs to all devices).

| Pack | Source | License |
|---|---|---|
| Hanja (readings + English meanings) | Unicode Unihan (`kHangul`, `kDefinition`) + basic education Hanja list | Unicode License v3 |
| Kanji | KANJIDIC2 | CC BY-SA 4.0 (EDRDG) |
| Japanese words (optional, large) | JMdict | CC BY-SA 4.0 (EDRDG) |
| Chinese words | CC-CEDICT | CC BY-SA 4.0 |
| Korean words *(Phase 10, top priority)* | NIKL 한국어기초사전 (KRDict) English edition as the primary source, with 우리말샘 / 표준국어대사전 for coverage and the Kaikki Wiktionary Korean extract for extra English glosses | CC BY-SA 2.0 KR (NIKL), CC BY-SA 4.0 (Wiktionary) |

Attribution shown in About screen (share-alike applies to dictionary data, not app code).

- **Unified Static Pack Catalog:** Both offline dictionary packs and stroke-data packs (`KanjiVG`, `Make Me a Hanzi`) are discovered via a single configurable `VITE_PACK_CATALOG_URL` (`packs.json` manifest hosted via the same free GitHub → GitHub Actions → Cloudflare Pages / GitHub Pages / R2 pipeline in §3.4), cached locally in IndexedDB/Cache API with version checks and license metadata, and backed by tiny bundled dev/test fixtures so offline dev & CI never require network access.

### 6.4 Drawing (Phase 6)
Per-language mode: `graded` | `lookup` | `off`.
- **Graded (`ja`, `zh-Hans`):** Hanzi Writer (MIT) in quiz mode; Make Me a Hanzi (Arphic PL verified Nov 2026: selling the app is fine since the app code is mere aggregation, but the stroke data must stay freely downloadable, ship `ARPHICPL.TXT` unaltered, and carry a change notice in each modified file — the full build does all three) for Chinese, KanjiVG (CC BY-SA 3.0) for Japanese (kept separate due to stroke-order differences). Stroke data pre-cached per `draw` deck. Mistakes map to `0 → Easy`, `1–2 → Good`, `3+ → Again` (overridable).
- **Korean Hanja is lookup-only by design:** graded stroke practice for Hanja is out of scope.
- **Lookup (Hanja default + Browse tool):** Custom MIT/permissive stroke-matching recognizer over Make Me a Hanzi / KanjiVG data on web (avoid GPL libraries); **Google ML Kit Digital Ink Recognition** on native shells.
- **Canvas:** Pointer Events with `touch-action: none`, grid guide, undo stroke, clear, reveal.

---

## 7. Audio

### 7.1 Resolution Order
For any field configured to speak, the app resolves audio in order:
1. **Attached audio** on the note (from `.flashpkg`, Anki import, a Sheet/CSV audio column, or a file the user attaches).
2. **Cached clip** in the local/synced media store, keyed by `sha256(normalized_text + voice_id)`.
3. **User's own cloud TTS key** (optional power-user setting: Google Cloud TTS or Azure via thin `TtsProvider` interface). Generated online at `1.0x`, saved to local media store *and* synced to `media/` so other devices never regenerate it.
4. **Device TTS** (`speechSynthesis`). Offline uses only `localService === true` voices; prompts once with OS instructions if a local language voice is missing.

> [!NOTE]
> **Family & shared decks:** Asking non-technical users to configure GCP billing/API keys is high friction. Pre-generating neural audio via **`tools/cli audio`** and bundling it into `.flashpkg` is the primary high-quality audio path for shared family decks.

- **Kanji pronunciation:** Layouts can speak from the `reading` field (or an optional per-note speech override) to prevent Japanese TTS misreadings.

### 7.2 Playback Reliability (iOS Safari & PWA)
- Single shared `<audio>` element unlocked synchronously on the first tap of a study session; set `navigator.audioSession.type = 'playback'` where supported so the iOS silent switch doesn't mute study audio.
- **2–3 card RAM lookahead:** Preload the next 2–3 cards' clips into in-memory `ObjectURL`s so auto-play fires synchronously on card flip.
- **Slow playback:** Client-side `audio.playbackRate = 0.75` (`preservesPitch = true`), or `utterance.rate` for device TTS. Clips are always generated at `1.0x`.

---

## 8. Performance Budget (R2)

Enforced in CI via `size-limit` and Playwright/Lighthouse checks:

| Metric | Target |
|---|---|
| Initial JS for the study screen | ≤ 160 KB gzipped (raised from 150 KB on 2026-11-22, after Phases 9–13) |
| Cold start to first card (Pixel-class phone, 5k cards) | ≤ 1 s |
| Flip or rate to next card rendered | ≤ 16 ms (1 frame; persistence async) |
| Incoming sync of 500 events | ≤ 200 ms main-thread work (replay in Web Worker) |
| Default web fonts loaded | 0 |

- **Lazy-loaded modules:** `read-excel-file`, Markdown page renderer, Hanzi Writer & recognizer, dictionary packs, Google Picker, Anki importer, FSRS optimizer.
- **Off main thread:** Event replay, imports, and search indexing run in a Web Worker.
- **Virtualization:** Browse lists are virtualized.

---

## 9. Offline Guarantee (R7)

**Works fully offline on every platform once installed:**
- Studying (all answer modes), Browse, search, in-app editing, Pages, Courses, Undo, and stats.
- Graded drawing (for pre-cached decks) and draw-to-lookup / dictionaries (once packs are installed; bundled in native).
- Attached/cached audio + local device TTS.
- `.flashpkg` import/export.
- **PC:** Scanning and importing linked local folders (Drive/Dropbox desktop folders or any local directory).

**Requires network (queues/waits quietly when offline):**
- Cloud sync (`drive.appdata`), pulling Google Sheets/Docs/package URL updates, linking new Sheets via Picker, BYO-key TTS generation, downloading web dictionary/font packs, initial store purchase.

**iOS home-screen PWA note:** iOS standalone PWAs isolate storage from Safari; first-run onboarding prompts to connect sync or export a backup. (Early TestFlight via Capacitor is an optional fast-track for iOS testers if Safari storage quirks arise.)

---

## 10. AI Tooling & Repository Layout (R5)

### 10.1 Monorepo Layout

```
<repo>/
  AGENTS.md                 # build/test/run commands & architecture rules (CLAUDE.md points here)
  apps/
    web/                    # Pure static SPA / PWA (v1 on all platforms)
    token-helper/           # ~60-line stateless Cloudflare Worker for Web Google OAuth refresh
    mobile/                 # Capacitor shell (store phase / optional TestFlight)
    desktop/                # Tauri shell (store phase)
  packages/
    core/                   # Pure TS, zero DOM/React: events, replay, ts-fsrs, note types,
                            # layouts, card derivation, ruby/cloze/pinyin parsers, answer matching,
                            # .flashpkg import/export
    content-schema/         # JSON Schema + Zod + generated TS types for .flashpkg
    ui/                     # React components, study screen, page renderer
    platform/               # Interfaces: Storage, Files, SyncTransport, Auth, TtsProvider, Audio, Purchase
    platform-web/           # Dexie/IndexedDB, File System Access, Google Drive/Picker, speechSynthesis
    platform-capacitor/     # SQLite, Filesystem, native Google Sign-In, ML Kit, StoreKit/Play Billing
    platform-tauri/         # Native SQLite, filesystem watcher, native auth
  tools/cli/                # Node CLI: validate, build, audio, inbox
  content/samples/          # Sample decks/pages in ja, zh-Hans, ko (+ Hanja), en
  docs/                     # This blueprint, ADRs (docs/adr/), format specs
```

- **Hard rule:** `packages/core` must never import React, DOM APIs, or platform adapters.

### 10.2 Agent-Friendly Verification
- **No-login dev mode:** `pnpm dev` boots with sample data + in-memory `SyncTransport`. `?device=a` / `?device=b` runs two simulated devices in one browser sharing an in-memory sync store.
- **Automated tests:** Vitest unit tests (`core`), golden tests (ruby/cloze/pinyin/answer matching), `fast-check` property tests (arbitrary event interleaving across N devices converges identically), Playwright E2E (study, undo, import, 2-device sync, offline mode), migration tests against fixture DBs.
- **CI:** TypeScript `strict`, ESLint, Prettier, Vitest, Playwright, `size-limit`.

### 10.3 Pushing Content from AI Tools
- **CLI (`tools/cli`):** `validate`, `build`, `audio --provider google --key …`, `inbox`.
- **3 routes:** (1) Edit an already-linked Google Sheet, (2) drop `.flashpkg` into a linked PC `Inbox/` folder (auto-imported to `Inbox/imported/` and synced to phones), (3) share `.flashpkg` file or URL.
- **AI provenance:** AI-created notes/pages carry `provenance = { source: 'ai', reviewed: false }` with a "Needs review" badge/filter until confirmed or edited.
- **Optional local MCP server (Phase 7):** Reads local sync/backup mirror; exposes `list_decks`, `get_weak_cards`, `get_stats`, `propose_package`.

---

## 11. Platforms & Store Path (R6)

| Stage | Android | iOS | PC |
|---|---|---|---|
| **v1 (personal, family)** | Installed PWA (Chrome) | Home-screen PWA (Safari) + stateless Worker refresh | Installed PWA (Chrome/Edge) with linked local folders |
| **Optional pre-store** | Sideloaded Capacitor APK | TestFlight Capacitor build | — |
| **Store phase** | Capacitor on Google Play | Capacitor on App Store | Tauri (direct / Microsoft Store / Mac App Store) |

All shells wrap the identical static web build; platform differences live strictly inside `packages/platform-*`.
- **Native Picker bridge:** Google Picker is web-only; native shells open a static Picker page on the app's domain in the system browser and return selected file IDs via deep link.
- **Store compliance:** No app accounts (Apple account-deletion rule doesn't apply); Google/Dropbox are cloud storage connectors rather than app logins (confirm App Review 4.8 at submission); privacy label = zero developer data collection.

---

## 12. One-Time Purchase, Token Helper, and Sunset

### 12.1 Purchase Model
- **Mobile Stores:** Recommended **free download + single non-consumable "Unlock" IAP** (e.g., unlimited decks + cloud sync), using **StoreKit 2** and **Play Billing** directly (verified & cached on-device offline; no RevenueCat dependency).
- **Web/Desktop direct sales:** Offline-verified **Ed25519-signed license key** sold via Gumroad / Lemon Squeezy / Paddle.
- **Personal/family builds:** Compile-time flag disables the license gate.

### 12.2 Sunset Promise (Store Listing & EULA)
If development ever stops:
1. The final version continues working offline forever, and sync keeps working via the user's own Google Drive / Dropbox / local folder.
2. The developer publishes the source code and a final build with the license gate removed.
3. All formats (`.flashpkg`, `sync/v1`, event schema) remain documented in `docs/`.

**Minimal dependencies to keep alive (or hand over):** The GCP OAuth project (free), web domain (to prevent takeover of installed PWAs), and static Picker page (only needed for linking *new* Sheets on native).

### 12.3 Stateless Cloudflare Worker Token Helper (`apps/token-helper`)
- **Role:** Phase 2 default for Web/PWA Google OAuth. Exchanges Google auth codes for `{ access_token, refresh_token }` and refreshes tokens using the GCP `client_secret` env var.
- **Zero state:** No database, no KV, no user data, no logs. Refresh tokens live solely on the user's device.
- **Cost & Sunset:** \$0/month on Cloudflare Workers free tier (100k req/day). If ever shut down, Web/PWA falls back to GIS tap-to-renew; native Capacitor/Tauri builds never call it.

---

## 13. Security & Privacy
- **Untrusted shared content:** Raw HTML disabled in Markdown, strict URL scheme allow-list (`https:`, `media:`), strict CSP (no inline scripts), external links open outside the app—preventing malicious shared pages from reading stored tokens.
- **Least privilege:** `drive.appdata` (sync) + `drive.file` (user-picked Sheets/Docs only); Picker API key referrer-restricted.
- **Safe imports:** File size caps + zip path-traversal and zip-bomb checks in `fflate` extraction.
- **Zero tracking:** No analytics; opt-in crash reporting only if ever added.

---

## 14. Tech Stack

| Layer | Choice |
|---|---|
| UI | Vite + React + TypeScript + Tailwind; Pointer Events gestures |
| PWA | `vite-plugin-pwa` (Workbox) |
| Local DB | Dexie (IndexedDB) on web; SQLite on native — behind `Storage` interface |
| SRS | `ts-fsrs` v5; optional on-device WASM optimizer |
| Parsing | Custom ruby/cloze/pinyin parsers; `wanakana`; `read-excel-file` (lazy); `micromark` + directives (lazy); `fflate` |
| Drawing | Hanzi Writer + KanjiVG / Make Me a Hanzi; custom permissive lookup matcher; ML Kit (native) |
| Sync | Custom event log + `SyncTransport` (Google Drive `drive.appdata`, local folder, in-memory; Dropbox/iCloud later) |
| Auth | Google OAuth redirect + stateless Cloudflare Worker (`apps/token-helper`) on web; native Google Sign-In on Capacitor/Tauri |
| Hosting | Cloudflare Pages (static SPA) + Cloudflare Workers (stateless token helper) |
| Tests/CI | Vitest, fast-check, Playwright, size-limit, GitHub Actions |
| Native Shells | Capacitor (Android/iOS), Tauri (desktop) |

---

## 15. Build Plan

### Phase 0 — Assumption Spikes (Throwaway PoCs)
- [ ] iOS home-screen PWA: offline launch, `navigator.storage.persist()`, shared `<audio>` unlock, `navigator.audioSession.type = 'playback'` / silent switch.
- [x] Google OAuth redirect + stateless Cloudflare Worker (`drive.appdata` + `drive.file`) inside an iOS standalone PWA and Android/desktop PWAs; confirm `appDataFolder` visibility across Web/Android/iOS OAuth clients in the same GCP project. *(Live web PKCE + `apps/token-helper` `/auth/exchange` & `/auth/refresh` + `appDataFolder` CRUD verified in ADR 0001; iOS home-screen & native clients to be verified on device/Phase 8)*
- [x] `drive.file`: Google Picker multi-select of Sheets; Sheets API read + `batchUpdate`; Google Docs export as `text/markdown`. *(Verified live in ADR 0001: `setAppId` + combined `ViewId.DOCS` MIME view, `FORMULA` `=IMAGE(...)`, race-guarded `Card ID` `batchUpdate`, `modifiedTime` metadata, and Docs `text/markdown` export)*
- [x] File System Access API (`showDirectoryPicker`) permission persistence in installed Chrome/Edge PWAs on Windows, reading Google Drive for Desktop folders. *(Verified live in ADR 0001: installed Windows PWA retained `readPermission: "granted"` and `readWritePermission: "granted"` across restart on mirrored `My Drive\Flashcards Deluxe`)*
- [x] `ts-fsrs` v5 API (fields, learning steps, deterministic replay) and WASM optimizer package check. *(Verified in ADR 0001: `ts-fsrs@6.0.0` FSRS-6 21-weight + `fsrs-browser@6.6.0` BSD-3-Clause WASM)*
- [x] Hanzi Writer quiz with KanjiVG Japanese stroke data + Arphic/CC BY-SA license verification. *(Verified in ADR 0001 + `spikes/phase0/drawing.html`)*
- [x] CORS check for `.flashpkg` URLs (GitHub raw / Cloudflare Pages) and BYO Google Cloud TTS REST endpoint. *(Verified in ADR 0001 + `spikes/phase0/_headers`)*

### Phase 1 — Core & Offline Single-Device App (Lean MVP)
- Monorepo setup (`pnpm` workspaces), `AGENTS.md`, CI, sample decks (`ja`, `zh-Hans`, `ko`, `en`).
- `packages/core`: immutable events, deterministic replay (with `(reviewed_at, hlc, review_id)` sort + FSRS param versioning), `ts-fsrs` v5 wrapper, Note Types, Layouts (Recognition default + 1-tap Production), deterministic Card derivation, safe CJK `X[Y]` ruby & pinyin parsers.
- `packages/platform-web` (Dexie behind `Storage` interface) + responsive PWA shell (mobile bottom tabs, desktop rail, safe-area insets).
- `flip` study screen with keyboard shortcuts, mobile swipe gestures, 3-button FSRS rating (+ optional Hard toggle), lossless Undo.
- CSV/TSV import, `.flashpkg` import/export, local backup prompt.
- **Milestone:** Fast, zero-login offline flashcard app usable daily on one device.

### Phase 2 — Cloud Sync (R1)
- `SyncTransport` interface + **Google Drive (`drive.appdata`)** transport + `apps/token-helper` stateless Cloudflare Worker + local-folder & in-memory transports.
- Write-once segments, `head.json`, snapshots, `format_version` gate, Web Worker replay.
- `fast-check` convergence property tests + 2-device Playwright sync tests (`?device=a` / `?device=b`).
- **Milestone:** Seamless Android + iOS + PC sync with zero Dropbox dependency.

### Phase 3 — Google Sheets & Local Folder Sources (R7)
- Google Picker (`drive.file`) multi-select, header mapping, race-safe `Card ID` write-back, soft-archiving, `modifiedTime` incremental pulls.
- PC linked local folders (`.csv`/`.tsv`, `.xlsx` via `read-excel-file`, `.md`, `.flashpkg`, `Inbox/` auto-import).
- Google Docs → Page import & `.flashpkg` URL subscriptions (including optional static `index.json` Family Library catalog).
- **Milestone:** Full Flashcards Deluxe replacement ready for daily personal & family use.

### Phase 4 — Richer Content & Answer Modes (R3, R4)
- Image fields (upload, resize, content-hash cache, sync).
- `typed` (with IME safety + language matchers), `choice`, `cloze`, and `listen` answer modes.
- Markdown Page renderer (no raw HTML, custom directives), Courses with unlock rules, AI provenance "Needs review" badge/filter.

### Phase 5 — Audio & TTS Pipeline
- Resolution chain (attached → cached media → BYO `TtsProvider` key → local `speechSynthesis`), iOS 2–3 card RAM preloader, `0.75×` pitch-preserved slow playback, media sync.

### Phase 6 — Drawing & Offline Dictionaries
- Graded drawing (`ja`/`zh-Hans`), draw-to-lookup (Hanja first), downloadable offline dictionary & stroke packs (`Unihan`, `KANJIDIC2`, `JMdict`, `CC-CEDICT`, `KanjiVG`, `Make Me a Hanzi`) via a unified static pack catalog (`VITE_PACK_CATALOG_URL` → `packs.json`, with offline dev/test fixtures), plus optional built-in Starter Decks catalog wiring (`VITE_STARTER_CATALOG_URL` → existing `FamilyCatalog` `index.json`).

### Phase 7 — AI Tooling Extras (R5) — *Implemented*
- `tools/cli` (`validate`, `build`, `audio`, `inbox`), GitHub Actions publishing workflow (`.github/workflows/publish-packs.yml` building `.flashpkg`, dictionary/stroke packs, `index.json`, and `packs.json` with CORS `_headers`), and local JSON-RPC 2.0 MCP server (`list_decks`, `get_weak_cards`, `get_stats`, `propose_package`).

### Phase 8 — Native Shells & Stores (R6) — *Implemented*
- `@flash/core/license` (free-tier boundary `FREE_TIER_MAX_DECKS = 2`, personal-build compile flag, offline Ed25519 key verification), `packages/platform-capacitor` (SQLite adapter, native Google Sign-In with zero Worker dependency, `picker.html` deep-link bridge `flashcards://picker-callback`, Google ML Kit Digital Ink recognizer, StoreKit 2 / Play Billing `unlock_full` IAP, optional iCloud Drive transport), `packages/platform-tauri` (SQLite adapter, native folder/`Inbox/` watcher, loopback Google OAuth, Ed25519 license verifier), optional `DropboxAppFolderTransport`, `apps/mobile` + `apps/desktop` shell configs, Settings License & Sunset Promise UI, and `docs/store-listing-and-sunset.md`.

> Phases 9–14 close the gaps found in the Nov 2026 product review, before a store launch. The order is the priority order. Korean is the reference language for acceptance testing; every feature must also work for `ja`, `zh-Hans` and `en`.

### Phase 9 — Categories, Filtered Study & Card Control — *Planned*
Goal: at least Flashcards Deluxe parity for organizing and filtering cards.
- **Categories = note `tags[]`** (already synced via `NoteUpserted`). Keep mapping `Category 1..N` / `Tags` columns on import, and write them back out on CSV/`.flashpkg` export so a Flashcards Deluxe round-trip is lossless. Add optional `::` hierarchy.
- **Tag manager:** lists every category with note counts; renames, merges and deletes across the whole collection in one batch of events.
- **Bulk editing:** multi-select in Browse to add or remove categories, move notes between decks, archive.
- **One shared filter model** (`packages/core`): any set of decks plus categories with *any* / *all* / *none* matching, card state (new, learning, due, suspended, leech), "Needs review", and **performance**: lapses ≥ N, Again rate over the last N reviews/days, failed within the last N days, low current recall probability (FSRS retrievability), low stability / high difficulty, and a "hardest N cards" ranking (same ordering as MCP `get_weak_cards`). Browse filters (replacing today's single `#tag` substring search), Study sessions and page `::cards{}` blocks all use it.
- **Filtered study:** `buildStudyQueue` accepts the filter, uses the same FSRS schedule (no forked state) and keeps sibling burying. Filters can be saved as named **Study Sets** that sync. Built-in presets include **Trouble cards** (most-missed cards across chosen decks/categories) and **Failed this week**. A Study Set can be studied on schedule (only due cards) or as practice (all matches, see Custom study).
- **Custom study:** review ahead, extra new cards today, and cram/practice mode for a filter. Cram records a `PracticeRecorded` event that does **not** change FSRS state.
- **Suspend/unsuspend** cards and notes (`CardSuspended` / `CardUnsuspended` events). **Leeches:** at N lapses (default 8) tag `leech` and optionally auto-suspend.

### Phase 10 — Korean Dictionary Excellence — *Planned (top priority)*
Goal: the best offline Korean↔English lookup in any flashcard app, built on open data that permits commercial use.
- **Primary source: NIKL 한국어기초사전 (KRDict), English edition** (full XML download, CC BY-SA 2.0 KR). Keep per-sense English equivalents and definitions, part of speech, learner level (초급/중급/고급), standard pronunciation, conjugated forms, Hanja origin, example sentences, and related, synonym and antonym links.
- **Coverage sources:** 우리말샘 and 표준국어대사전 (CC BY-SA 2.0 KR, Korean–Korean) for headwords KRDict lacks, the Kaikki Wiktionary Korean extract (CC BY-SA 4.0) for extra English glosses, slang and etymology, and kengdic only after its license is confirmed. Every sense shows a source badge.
- **Merge pipeline** (`scripts/build-packs.mjs`): unify entries by headword + Hanja + part of speech, rank senses (KRDict first), dedupe glosses, and build an English→Korean reverse index from the English equivalents. Measure pack size and shard by first syllable if any file exceeds 25 MiB.
- **Korean-aware search:**
  - inflected-form lookup (`먹었어요` → `먹다`, irregular verbs included)
  - romanization input
  - initial-consonant (초성) search (`ㅎㄱ` → `한국`)
  - jamo-insensitive prefix matching
  - Hanja ↔ word links (from a word to its Hanja in the Unihan pack, and from a Hanja to every word that uses it)
  - draw-to-lookup on Hanja (lookup only, see §6.4)
- **Pronunciation audio:** use KRDict audio only if its license permits redistribution (to be verified). Otherwise fall back to the §7 TTS chain.
- **Add to Deck** maps headword, English, Hanja, level, example and pronunciation into the Korean vocabulary note type.
- **Licensing decision point:** evaluate licensing a commercial publisher's Korean–English dataset as an optional premium pack if the open-data quality bar is not met. Attribution for every source appears in About.
- **Follow-on:** bring the same search treatment (deinflection, reverse index) to `ja` (JMdict) and `zh-Hans` (CC-CEDICT).

### Phase 11 — Statistics & FSRS Optimizer — *Planned*
- **Stats screen:** reviews per day, time spent, true retention vs. target, due forecast, a calendar heatmap with streaks, maturity breakdown, and the hardest cards. Filterable by deck and category (Phase 9 filter). Computed from the event log, offline.
- **On-device FSRS optimizer:** `fsrs-browser` WASM (verified in ADR 0001) runs in a Worker per deck or preset. It emits `DeckFSRSParamsChanged`, with an optional "Reschedule existing cards".
- The MCP `get_stats` output matches the screen.

### Phase 12 — Import & Sync Breadth — *Planned*
- **Anki `.apkg` import:** note types, fields, cloze, media, tags as categories, optional review history (converted to `ReviewRecorded` events), and Anki ruby conversion.
- **Microsoft OneDrive `SyncTransport`** (§4.3):
  - Graph app folder storage, with `@microsoft.graph.conflictBehavior=fail` for `ifAbsent` writes and upload sessions for files over 4 MB
  - token-helper `/ms/exchange` and `/ms/refresh` routes for web, MSAL on native
  - optional OneDrive file picker as a content source for `.csv` / `.xlsx` / `.flashpkg`

### Phase 13 — Launch Polish — *Planned*
- **Study reminders:** native local notifications on Capacitor and Tauri at a user-chosen time with the due count. The PWA gets an in-app badge only.
- **MCP server upgrades:**
  - `search_notes` with the Phase 9 filter
  - `get_weak_cards` filtered by category
  - reload when the mirror changes
  - an updated protocol version
- **First-run onboarding:** pick a language, then a starter deck, then sync. Phase 14 reviews and sets the bar for it.
- **Adaptive layout across device classes.** Today there is one breakpoint (`md` = 768 px: bottom tabs below it, a left rail above it), a content column capped at 896 px, and two text sizes on cards. Extend that to:
  - **Fit the card to the screen:** the study screen (prompt, answer, rating buttons) always fits without scrolling. Replace the fixed `min-h-[20rem]` card with sizing based on the available height. In landscape phones and short windows, use a compact layout: rating buttons beside the card, tab bar hidden while studying.
  - **Auto-fit card text:** scale the font with screen size and content length, so a single Hanja fills the card while a long grammar explanation (e.g. Flashcards Deluxe grammar decks) drops to a readable size and scrolls inside the card.
  - **Small screens (< 360 px)** and foldable cover screens: a compact type scale, icon-only tabs, and touch targets of at least 44–48 px.
  - **Tablets and foldables (inner screen):** use the width. Browse and the dictionary get a list + detail split view, and the study card can show notes or a dictionary panel beside it. Also handle split-screen / multi-window resizing and, where supported, the foldable hinge (CSS viewport segments).
  - **Large monitors:** a wider max width for Browse, Library and Dictionary; keep the study card centered with a capped line length.
  - **Non-touch and keypad devices:** full keyboard and D-pad focus navigation with visible focus rings. Number keys `1–4` already map to ratings. Don't depend on hover.
  - **Accessibility scaling:** an in-app card text-size setting; respect OS text size (iOS Dynamic Type and the Android font scale inside the native WebViews; to be verified); `prefers-reduced-motion`.
  - **Test matrix:** Playwright projects for a small phone (320×568), a regular phone (390×844), a landscape phone (844×390), a foldable cover screen, a tablet (820×1180 portrait/landscape) and a desktop (1920×1080). The e2e suite currently runs only Desktop Chrome plus one 390×844 test.

### Phase 14 — Onboarding & Setup Review (Store-Launch Gate) — *Planned*
Goal: an aggressive end-to-end review that removes every unnecessary step between install and studying, and between a second device and synced data. **The app doesn't go to the stores until this review passes.**

- **Audit:** walk every first-run path on a fresh Android phone, iPhone and Windows PC, plus a tablet and a foldable:
  - new user
  - second device
  - import from Flashcards Deluxe or Anki
  - restore from backup
  - restore purchase

  Log every screen, tap, permission prompt, sign-in, consent screen, app switch and piece of typed text. Each one has to justify itself; otherwise it is removed, deferred or automated.
- **Targets** (measured with non-technical testers, not developers):
  - first card on screen ≤ 30 s and ≤ 3 taps after install, with no sign-in
  - second device fully synced ≤ 2 min with exactly one sign-in
  - zero terminal commands, zero hand-copied keys or tokens, zero app-specific passwords
- **Design rules:**
  - **Study first, set up later:** the app opens to a language picker and a starter deck. Sync, imports and dictionaries are offered after the first session, not before.
  - **One "Sync my devices" button:** it picks a sensible default (iCloud for Apple-only users, which needs no sign-in; Google for cross-platform users) and shows the other providers as alternatives. Sign-in always goes through the system account picker (Android Credential Manager / Google Sign-In, iOS `ASWebAuthenticationSession`); the app never sees a password.
  - **Add another device:** a QR code or short link that tells the new device which provider and collection to connect to. It never carries tokens or secrets; the new device signs in itself.
  - **Just-in-time permissions:** ask for notifications only when reminders are turned on, and for folder access only when a folder is linked.
  - **Dictionaries:**
    - the native builds ship with the chosen language's dictionary, or download it automatically once, showing its size and waiting for Wi-Fi
    - TTS uses device voices by default
    - if a voice is missing, the app links straight to the right OS settings screen
    - your own cloud TTS key lives under Advanced
  - **Guided import:** a single "Bring my cards" flow detects Flashcards Deluxe CSV, Anki `.apkg`, `.flashpkg` and Google Sheets automatically.
  - **Purchase:** in-app purchase with a visible **Restore Purchases** button. On web/desktop, the license activates from a link in the purchase email rather than a pasted key.
  - **Power-user tools stay out of the main path:** the CLI and MCP server are for content authors only and never appear in user onboarding.
- **Compliance checklist (re-verified against current policy at submission):**
  - **Apple:**
    - Sign in with Apple is needed only if a third-party login is used as an app account. Keep Google, Dropbox and OneDrive framed as storage connectors, and confirm under Guideline 4.8.
    - Account-deletion rules don't apply because there are no app accounts.
    - Digital unlocks use in-app purchase, plus a Restore button.
    - Follow the current rules on mentioning outside purchases (anti-steering).
    - Privacy nutrition label.
  - **Google Play:** Data safety form; OAuth consent screen brand verification for `drive.appdata` / `drive.file`; Play Billing for the unlock; target-API and permission declarations.
  - **Both stores:**
    - least-privilege scopes
    - tokens only in Keychain/Keystore (native) or device storage (web)
    - no analytics
    - a privacy policy and EULA that include the sunset promise
- **Deliverable:** `docs/onboarding-review.md` with the audited flows, measured results against the targets, the fixes made, and a sign-off checklist.

### Future Candidates — *Under consideration, not committed*
Ideas worth building if time and demand allow. Each needs its own go/no-go decision before work starts.

- **Korean verb & adjective conjugation** (in the spirit of conjugation apps such as Dongsa):
  - **Conjugation engine** in `packages/core`. Given a dictionary form (`먹다`, `돕다`, `듣다`, `하다`), it generates every common form, with the rule applied shown for each form:
    - tenses: past, present, future, progressive
    - politeness levels: 해체, 해요체, 합쇼체, 해라체
    - honorific `-(으)시-`
    - negatives: `안`, `-지 않다`, `못`
    - connectives: `-고`, `-아/어서`, `-(으)면`, `-지만`, …
    - noun-modifier forms
    - the irregular classes: ㅂ, ㄷ, ㅅ, ㅎ, 르 and 러, plus ㄹ-deletion and vowel contraction
  - **Shared with Phase 10:** the same rule tables run in reverse to power dictionary deinflection (`도와요` → `돕다`), so the conjugation tables get built once and serve both features.
  - **Conjugation table view:** opened from any verb or adjective in the dictionary or on a card.
  - **Conjugation drills:**
    - a note type or layout that generates cards for verb × chosen forms, studied in `typed` mode with Korean-aware matching
    - a filter for which forms to drill
    - FSRS scheduling per form
  - **Licensing:** write our own rules and tests. Don't copy another app's code, data or UI, and check the license of any reference implementation first.
  - **Possible extension:** Japanese verb/adjective conjugation (godan/ichidan/irregular) using the same engine design.

---

## 16. Pre-Launch Configuration Checklist

1. **App domain & GCP OAuth clients:** Choose production domain before finalizing GCP Android/iOS/Desktop OAuth Client IDs and Cloudflare Pages site.
2. **Free-tier policy (`packages/core/src/license`):** Commercial builds (`VITE_ENABLE_LICENSE_GATE=true`) allow 2 local-only decks free and one-time `unlock_full` (IAP or Ed25519 key) for unlimited decks + cloud sync; personal/family builds keep `VITE_ENABLE_LICENSE_GATE=false`.
3. **Production CSP headers for WASM Workers (Phases 11–12):** the PWA meta-tag CSP does not reach dedicated Workers, which take the CSP header of their own script response. Before launch, configure the host per `docs/setup-gcp-cloudflare.md` §6: send no CSP header on `/assets/*.js`, or send the exact `PRODUCTION_CSP` from `apps/web/csp.ts` (it includes `script-src 'wasm-unsafe-eval'`, `worker-src 'self'`, `connect-src 'self' https:`) on every file, and serve `.wasm` as `application/wasm`. Decide whether to commit a Cloudflare Pages `_headers` file. OneDrive needs no `frame-src`/`form-action` entry (Graph-based in-app picker, top-level sign-in); adopting the hosted OneDrive File Picker v8 would first need its redirect hosts verified under the policy and pinned (no wildcards).
