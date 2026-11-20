# ADR 0001: Phase 0 Assumption Spike Findings & Decisions

- **Status:** In Progress (Track A automated spikes verified; Track B cloud/device harness ready for live run)
- **Date:** 2026-11-20
- **Source Blueprint:** [design_blueprint.md §15](file:///c:/Antigravity/Korean/docs/design_blueprint.md#L495-L503)

---

## Summary Matrix

| Spike   | Area                                                                                     | Status                                                     | Key Finding / Decision                                                                                                                                                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.1** | iOS home-screen PWA (offline, `persist()`, `<audio>` unlock, `audioSession`)             | **Harness ready** (`spikes/phase0/index.html`)             | Needs live run on physical iOS device after Cloudflare Pages deploy.                                                                                                                                                                                                                                                          |
| **0.2** | Google OAuth redirect + stateless Cloudflare Worker (`drive.appdata` + `drive.file`)     | **Worker built & unit-tested (6/6)** (`apps/token-helper`) | Strict CORS allowlist + PKCE + `Cache-Control: no-store` verified locally; needs GCP creds + Cloudflare deploy + iOS standalone redirect check.                                                                                                                                                                               |
| **0.3** | `drive.file` Picker multi-select + Sheets `FORMULA`/`batchUpdate` + Docs `text/markdown` | **Harness ready** (`spikes/phase0/index.html`)             | Needs GCP OAuth + Browser API Key run against a test Sheet & Doc.                                                                                                                                                                                                                                                             |
| **0.4** | File System Access API (`showDirectoryPicker`) on Windows PWA + `G:\My Drive`            | **Harness ready** (`spikes/phase0/index.html`)             | Confirmed `G:\` Google Drive for Desktop is mounted on this Windows machine; needs interactive Chrome/Edge PWA restart check.                                                                                                                                                                                                 |
| **0.5** | `ts-fsrs` API + WASM optimizer package check                                             | **Verified (PASS with adjustment)**                        | `ts-fsrs@6.0.0` (MIT) defaults to **FSRS-6 (21 weights)**; `fsrs-rs-wasm` does not exist on npm — use **`fsrs-browser@6.6.0` (BSD-3-Clause, 378 KB unpacked)** lazy-loaded in a Web Worker instead.                                                                                                                           |
| **0.6** | Hanzi Writer + KanjiVG Japanese stroke data + license audit                              | **Verified (PASS with license guardrail)**                 | Real KanjiVG SVGs (`食` 9 strokes, `語` 14 strokes) converted cleanly to Hanzi Writer JSON; **Arphic Public License** (`hanzi-writer-data`) requires keeping Chinese stroke data as a separate downloadable pack with attribution/license file rather than bundling into proprietary commercial code.                         |
| **0.7** | CORS for `.flashpkg` URLs & BYO Google Cloud TTS REST                                    | **Verified (PASS)**                                        | `raw.githubusercontent.com` returns `Access-Control-Allow-Origin: *`; Google Cloud TTS REST `OPTIONS` preflight echoes the requesting browser `Origin` + allows `POST` + `content-type`. Cloudflare Pages needs a `_headers` rule (`Access-Control-Allow-Origin: *`) for cross-origin `.flashpkg`/`index.json` subscriptions. |

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

### Spike 0.7 — CORS for `.flashpkg` URLs & BYO Google Cloud TTS

- **GitHub Raw (`raw.githubusercontent.com`):** Returned `HTTP 200` with `Access-Control-Allow-Origin: *` and `Vary: Authorization,Accept-Encoding`. Public `.flashpkg` and Family Library `index.json` subscriptions hosted on GitHub work directly from any PWA origin.
- **Cloudflare Pages:** Requires a `_headers` rule (`Access-Control-Allow-Origin: *`) on `/*.flashpkg` and `/*.json` for cross-origin Family Library subscriptions (added to `spikes/phase0/_headers`).
- **Google Cloud TTS REST (`https://texttospeech.googleapis.com/v1/text:synthesize`):** `OPTIONS` preflight with `Origin: https://flashcards-spike.pages.dev`, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: content-type` returned `HTTP 200` with `Access-Control-Allow-Origin: https://flashcards-spike.pages.dev`, confirming direct browser BYO-key synthesis works without a proxy.

---

## Track B Execution Log (Fill In After Cloud Deploy & Device Run)

Follow [docs/setup-gcp-cloudflare.md](file:///c:/Antigravity/Korean/docs/setup-gcp-cloudflare.md) to deploy `apps/token-helper` and `spikes/phase0/`, then record outcomes below:

- [ ] **0.1 iOS Home-Screen PWA:** Standalone offline launch, `navigator.storage.persist()`, shared `<audio>` unlock, `navigator.audioSession.type = 'playback'` with hardware silent switch ON.
- [ ] **0.2 Google OAuth + Worker (`apps/token-helper`) + `drive.appdata`:** Full-page PKCE redirect inside iOS standalone PWA + desktop PWA, silent `/auth/refresh`, `appDataFolder` CRUD.
- [ ] **0.3 `drive.file` Picker + Sheets + Docs:** Multi-select Picker, `=IMAGE()` `FORMULA` read, race-guarded `Card ID` `batchUpdate`, Google Docs `text/markdown` export.
- [ ] **0.4 Windows PWA File System Access (`G:\My Drive`):** `showDirectoryPicker` handle stored in IndexedDB, permission persistence across installed Chrome/Edge PWA restarts.
- [ ] **0.7b Live BYO Google Cloud TTS:** Browser playback of synthesized `ko-KR` / `ja-JP` / `zh-CN` MP3 via shared `<audio>`.
