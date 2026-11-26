# ADR 0001: Phase 0 Assumption Spike Findings & Decisions

- **Status:** Closed 2026-11-26: the harness in `spikes/phase0/` was removed; the shipped app superseded the live Track B runs, and the two KanjiVG conversions moved to `scripts/packs/fixtures/`.
- **Date:** 2026-11-20
- **Source Blueprint:** [design_blueprint.md §15](file:///c:/Antigravity/Korean/docs/design_blueprint.md#L495-L503)

---

## Summary Matrix

| Spike   | Area                                                                                     | Status                                                     | Key Finding / Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.1** | iOS home-screen PWA (offline, `persist()`, `<audio>` unlock, `audioSession`)             | **Harness ready** (`spikes/phase0/index.html`)             | Needs live run on physical iOS device after Cloudflare Pages deploy.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **0.2** | Google OAuth redirect + stateless Cloudflare Worker (`drive.appdata` + `drive.file`)     | **Worker built & unit-tested (6/6)** (`apps/token-helper`) | Strict CORS allowlist + PKCE + `Cache-Control: no-store` verified locally; needs GCP creds + Cloudflare deploy + iOS standalone redirect check.                                                                                                                                                                                                                                                                                                                        |
| **0.3** | `drive.file` Picker multi-select + Sheets `FORMULA`/`batchUpdate` + Docs `text/markdown` | **Verified (PASS with Picker guardrails)**                 | Live-verified with `drive.file` only: `PickerBuilder.setAppId(projectNumber)` + `setOrigin(...)` required to bind per-file grants; combined `ViewId.DOCS` + `setMimeTypes(...)` enables single-tab Sheets+Docs multi-select; `values.get (FORMULA)` returns raw `=IMAGE(...)`; guarded `batchUpdate` writes `Card ID` once and skips on repeat; `drive/v3/files/{id}/export?mimeType=text/markdown` succeeds after Picker grant (403 `appNotAuthorizedToFile` before). |
| **0.4** | File System Access API (`showDirectoryPicker`) on Windows PWA + `G:\My Drive`            | **Verified (PASS)**                                        | Live-verified in installed Windows standalone PWA (`standalone: true`) against mirrored Google Drive folder (`G:\My Drive.lnk` → `C:\Users\astev\My Drive\Flashcards Deluxe`): IndexedDB-stored `FileSystemDirectoryHandle` persisted both `readPermission: "granted"` and `readWritePermission: "granted"` across full PWA close & reopen.                                                                                                                            |
| **0.5** | `ts-fsrs` API + WASM optimizer package check                                             | **Verified (PASS with adjustment)**                        | `ts-fsrs@6.0.0` (MIT) defaults to **FSRS-6 (21 weights)**; `fsrs-rs-wasm` does not exist on npm — use **`fsrs-browser@6.6.0` (BSD-3-Clause, 378 KB unpacked)** lazy-loaded in a Web Worker instead.                                                                                                                                                                                                                                                                    |
| **0.6** | Hanzi Writer + KanjiVG Japanese stroke data + license audit                              | **Verified (PASS with license guardrail)**                 | Real KanjiVG SVGs (`食` 9 strokes, `語` 14 strokes) converted cleanly to Hanzi Writer JSON; **Arphic Public License** (`hanzi-writer-data`) requires keeping Chinese stroke data as a separate downloadable pack with attribution/license file rather than bundling into proprietary commercial code.                                                                                                                                                                  |
| **0.7** | CORS for `.flashpkg` URLs & BYO Google Cloud TTS REST                                    | **Verified (PASS)**                                        | `raw.githubusercontent.com` returns `Access-Control-Allow-Origin: *`; Google Cloud TTS REST `OPTIONS` preflight echoes the requesting browser `Origin` + allows `POST` + `content-type`. Cloudflare Pages needs a `_headers` rule (`Access-Control-Allow-Origin: *`) for cross-origin `.flashpkg`/`index.json` subscriptions.                                                                                                                                          |

---

## Detailed Findings (Track A — Verified)

### Spike 0.5 — `ts-fsrs` & WASM Optimizer (`spikes/phase0/scripts/check-fsrs-wasm.mjs`)

- **Installed scheduler:** `ts-fsrs@6.0.0` (MIT), deterministic replay verified (`enable_fuzz: false`, `enable_short_term: true`).
  - Default parameters use **21 weights (FSRS-6)**, and `ts-fsrs` also exports subpath models `./models/fsrs-5` (19 weights), `./models/fsrs-6` (21 weights), `./models/fsrs-7`, and `./reschedule`.
  - **Architectural note:** Keep `DeckFSRSParamsChanged.params.w` paired with `params_version` (and optionally `fsrs_model` if we ever switch models) so historical reviews always replay under the exact parameter length active at review time.
- **WASM Optimizer packages checked on npm:**
  - `fsrs-rs-wasm` / `fsrs-wasm`: **404 Not Found** on npm.
  - **`fsrs-browser@6.6.0`**: **BSD-3-Clause**, **378 KB unpacked**, native browser ESM (`fsrs_browser.js`), includes Optimizer + Scheduler. **Recommended choice** (lazy-loaded in a Web Worker when adding the FSRS optimizer).
  - `@open-spaced-repetition/binding@0.6.1`: MIT, **1,640 KB unpacked**, Node/WASI via `emnapi` — heavier and geared toward Node/WASI rather than lightweight browser PWAs.

### Spike 0.6 — Hanzi Writer + KanjiVG & License Audit (`spikes/phase0/scripts/check-cors-and-licenses.mjs`)

- **Japanese KanjiVG → Hanzi Writer PoC:**
  - Fetched live KanjiVG SVGs (`098df.svg` for `食`, `08a9e.svg` for `語`) from `KanjiVG/kanjivg`, transformed coordinates from KanjiVG's `109×109` top-down viewBox to Hanzi Writer's `1024×1024` flipped coordinate system (`y' = 900 - y * 1024/109`), and generated stroked outline ribbons + medians (`spikes/phase0/kanjivg-098df.json`: 9 strokes, 2,826 bytes; `spikes/phase0/kanjivg-08a9e.json`: 14 strokes, 4,995 bytes).
  - Interactive verification page available at `spikes/phase0/drawing.html` using `hanzi-writer@3.7.3` custom `charDataLoader`.
- **Commercial License Audit (Phase 8 Store Prep):**
  - `hanzi-writer@3.7.3`: **MIT** — safe for proprietary commercial distribution.
  - `hanzi-writer-data@2.0.1` (Make Me a Hanzi): **Arphic Public License (1999)** (`ARPHICPL.TXT`, 31.5 MB unpacked) — copyleft-style license for font/glyph derivatives.
  - `KanjiVG`: **CC BY-SA 3.0** — share-alike applies to derivative stroke data, not app code.
  - Dictionaries (`Unihan`: Unicode License v3; `KANJIDIC2` / `JMdict` / `CC-CEDICT`: CC BY-SA 4.0).
  - **Decision:** Keep all stroke data (`zh-Hans` Make Me a Hanzi, `ja` KanjiVG) and offline dictionaries as **separate, clearly attributed, downloadable data packs** (bundled as separate data assets with license texts and upstream source links in native builds) rather than mixing them into proprietary TypeScript source code.

### Spike 0.7 — CORS for `.flashpkg` URLs & BYO Google Cloud TTS (100% Live Verified)

- **GitHub Raw (`raw.githubusercontent.com`):** Returned `HTTP 200` with `Access-Control-Allow-Origin: *` and `Vary: Authorization,Accept-Encoding`. Public `.flashpkg` and Family Library `index.json` subscriptions hosted on GitHub work directly from any PWA origin.
- **Cloudflare Workers Static Assets (`https://flashcards-phase0-spike.yodc.workers.dev/kanjivg-098df.json`):** Verified live with `_headers` returning `HTTP 200`, `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=300` for cross-origin requests.
- **Google Cloud TTS REST (`https://texttospeech.googleapis.com/v1/text:synthesize`):** Verified live end-to-end against GCP project `flashcards-pwa-2026` using a referrer-restricted Browser API key (`picker.googleapis.com` + `texttospeech.googleapis.com`). Returned `HTTP 200`, `Access-Control-Allow-Origin: https://flashcards-phase0-spike.yodc.workers.dev`, and 12,544 base64 chars (~9.4 KB) of real `ko-KR` MP3 audio directly via browser-style CORS `POST` with zero proxy.

---

## Live Cloud Infrastructure Provisioned (Phase 0 / Phase 2 Ready)

- **GCP Project:** `flashcards-pwa-2026` (display name: `Flashcards App`, project number: `932735219487`, billing linked, APIs enabled: `drive`, `sheets`, `docs`, `picker`, `texttospeech`, `apikeys`).
- **Browser API Key:** Created in `flashcards-pwa-2026`, restricted to `picker.googleapis.com` + `texttospeech.googleapis.com` and referrers `http://localhost:5173/*`, `https://flashcards-phase0-spike.yodc.workers.dev/*`.
- **Stateless Token Helper Worker:** `https://flashcards-token-helper.yodc.workers.dev` (verified live `GET /health` → `200`, disallowed `Origin` → `403`, `ALLOWED_ORIGINS` secret configured; awaiting `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`).
- **Phase 0 Spike PWA Harness:** `https://flashcards-phase0-spike.yodc.workers.dev`.

---

## Track B Execution Log (Live Verification)

- [x] **0.2 Google OAuth + Worker (`apps/token-helper`) + `drive.appdata`:** Verified live on `https://flashcards-phase0-spike.yodc.workers.dev` ↔ `https://flashcards-token-helper.yodc.workers.dev` (`/health`, PKCE redirect `/auth/exchange`, IndexedDB `refresh_token`, silent `/auth/refresh`, and `spaces=appDataFolder` CRUD).
- [x] **0.3 `drive.file` Picker + Sheets + Docs:** Verified live against `flashcards-pwa-2026` (`appId: 932735219487`) with non-restricted `drive.file` scope:
  - **Picker guardrails caught:** `PickerBuilder.setAppId('<GCP_PROJECT_NUMBER>')` and `.setOrigin(window.location.origin)` are required for `drive.file` per-file grants; using a combined `DocsView(ViewId.DOCS).setMimeTypes('application/vnd.google-apps.spreadsheet,application/vnd.google-apps.document')` as the primary view lets users multi-select Sheets and Docs together; `docs.google.com/picker` iframe returns HTTP 401 when third-party cookies are blocked (embedded webviews), so Phase 3 should surface a clear troubleshooting hint if the Picker fails to load.
  - **Sheets + Drive metadata:** `drive/v3/files/{id}?fields=id,name,mimeType,modifiedTime,version` (`HTTP 200`, `modifiedTime` + `version` ready for incremental pulls), `sheets/v4/.../values/A1:Z20?valueRenderOption=FORMULA` (`HTTP 200`, returned raw `=IMAGE("https://flashcards-phase0-spike.yodc.workers.dev/icon.svg")`), and race-guarded `values:batchUpdate` (`HTTP 200` on first write to `Sheet1!D2`, skipped on second click).
  - **Docs Markdown export & isolation:** Confirmed `HTTP 403 appNotAuthorizedToFile` before Picker grant, and `HTTP 200` `text/markdown` export after multi-selecting `Phase 0 Spike 0.3 — Test Grammar Page` in Picker.
- [x] **0.4 Windows PWA File System Access (`G:\My Drive`):** Verified live in installed standalone Chrome/Edge PWA on Windows (`standalone: true`) against `C:\Users\astev\My Drive\Flashcards Deluxe` (note: Drive for Desktop in Mirroring mode mounts `G:\My Drive.lnk` pointing to `C:\Users\...\My Drive`). After full PWA close & reopen, restored `FileSystemDirectoryHandle` from IndexedDB retained `readPermission: "granted"` and `readWritePermission: "granted"` with zero re-prompting.
- [x] **0.7b Live BYO Google Cloud TTS:** Verified live `ko-KR` MP3 synthesis (`HTTP 200`, CORS echoed, 12,544 base64 chars) against `flashcards-pwa-2026`.
- [ ] **0.1 iOS Home-Screen PWA (physical iPhone check):** Confirm standalone offline launch, `navigator.storage.persist()`, shared `<audio>` unlock, `navigator.audioSession.type = 'playback'` with silent switch ON, and standalone OAuth redirect return on a real iOS device if not yet tested.
