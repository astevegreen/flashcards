# AGENTS.md

Source of truth for architecture and phased scope: `docs/design_blueprint.md`.

## Commands

Run from repository root using `pnpm`:

- `pnpm install` — install workspace dependencies
- `pnpm dev` — start local Vite dev server (zero-login dev mode with sample decks)
- `pnpm build` — typecheck/build all packages and production PWA bundle (`apps/web/dist`) (skips `@flash/desktop`; run `pnpm --filter @flash/desktop build` with Rust installed)
- `pnpm --filter @flash/mobile exec cap sync android` — copy `apps/web/dist` + plugins into the Android project
- `pnpm typecheck` — strict TypeScript check across all workspace packages
- `pnpm lint` — ESLint (enforces architectural boundaries including `packages/core` purity)
- `pnpm format:check` / `pnpm format` — Prettier formatting check/write
- `pnpm test` — Vitest unit, golden, and `fast-check` property tests
- `pnpm size` — enforce §8 bundle budget (`<= 160 KB` gzipped initial study-screen JS, 0 web fonts)
- `pnpm test:e2e` — Playwright end-to-end tests (study, undo, import/export, offline, multi-device isolation)
- `node scripts/build-packs.mjs --starter` — regenerate the tiny attributed dictionary/stroke fixtures in `apps/web/public/packs/` (used by dev, `pnpm test`, and `pnpm test:e2e`; never needs network); `--check` (`pnpm packs:check`, part of `pnpm gate`) fails when the committed files differ from a rebuild
- `node scripts/fetch-starter-sources.mjs && node scripts/build-starter-decks.mjs` — download the pinned open data for the onboarding starter decks into the gitignored cache, then rebuild `packages/core/src/starters/generated/` deterministically and offline; `--check` verifies the committed output (see `content/starters/README.md`). Never hand-edit the generated decks.
- `node scripts/fetch-upstream-packs.mjs && node scripts/build-packs.mjs --full` — download real upstream open data (Unihan, KANJIDIC2, JMdict, CC-CEDICT, KanjiVG, Make Me a Hanzi) into gitignored `.cache/upstream-open-data/` and build real packs into gitignored `dist-packs/`; `pnpm exec vitest run packages/platform-web/tests/full-packs-smoke.test.ts` then smoke-tests them (it is skipped when `dist-packs/` is absent). Never commit full packs; CI publishes them via `.github/workflows/publish-packs.yml`.

## Agent-Friendly Dev Mode

- `pnpm dev` boots with **no login** and seeds sample decks (`ja`, `zh-Hans`, `ko` + Hanja, `en`) when local storage is empty.
- Append `?device=a` or `?device=b` to isolate IndexedDB databases (`flashcards-db-a`, `flashcards-db-b`) in the same browser and wire the in-memory/BroadcastChannel `SyncTransport` stub.

## Monorepo Boundaries

- `packages/content-schema` (`@flash/content-schema`) — Zod schemas & JSON Schema exports for `.flashpkg`, `index.json`, and `packs.json`.
- `packages/core` (`@flash/core`) — **100% pure TypeScript**: events, deterministic replay, `ts-fsrs` wrapper, Note Types, Layouts, Card derivation, Ruby/Pinyin/Cloze parsers, answer matching, courses, audio resolution, drawing/stroke grading & recognition, offline dictionary search & pack codec, offline Ed25519 licensing, CSV/TSV & `.flashpkg` import/export, sync engine, sample data.
- `packages/platform` (`@flash/platform`) — pure TypeScript interfaces (`Storage`, `Files`, `SyncTransport`, `Auth`, `TtsProvider`, `AudioPlayer`, `Purchase`, `PackManager`, `StrokeDataProvider`, `HandwritingRecognizer`, `DictionaryService`, `NativePickerBridge`).
- `packages/platform-web` (`@flash/platform-web`) — Dexie IndexedDB `Storage`, browser `Files`, Google Drive / Local Folder / Dropbox / OneDrive / BroadcastChannel `SyncTransport` (OneDrive lazy via `@flash/platform-web/onedrive`), Google OAuth + Picker + Sheets/Docs, Web Audio preloader + BYO Cloud TTS + `speechSynthesis`, offline pack/dictionary/stroke adapters, WebCrypto Ed25519 license purchase.
- `packages/platform-capacitor` (`@flash/platform-capacitor`) — Capacitor Android/iOS SQLite `Storage`, native Google Sign-In, `picker.html` deep-link bridge, Google ML Kit Digital Ink recognizer, StoreKit 2 / Play Billing IAP, iCloud Drive transport.
- `packages/platform-tauri` (`@flash/platform-tauri`) — Tauri desktop SQLite `Storage`, native folder & `Inbox/` watcher, loopback Google OAuth, offline Ed25519 license verifier.
- `packages/ui` (`@flash/ui`) — lean React UI components & screens consuming `@flash/core` and `@flash/platform` with strict lazy-loading of secondary screens and heavy answer modes.
- `apps/web` (`@flash/web`) — static Vite + React + Tailwind v4 + `vite-plugin-pwa` shell.
- `apps/token-helper` (`@flash/token-helper`) — stateless Cloudflare Worker for Web/PWA Google OAuth (`/exchange`, `/refresh`) and Microsoft OneDrive (`/ms/exchange`, `/ms/refresh`) code exchange and token refresh.
- `apps/mobile` (`@flash/mobile`) & `apps/desktop` (`@flash/desktop`) — Capacitor 8 (`android/`, `ios/`) and Tauri 2 (`src-tauri/`) shells wrapping the identical `apps/web/dist`; `apps/web` lazily boots `@flash/platform-capacitor/native` / `@flash/platform-tauri/native` when it detects the runtime. Local build steps: `docs/native-shells.md`.
- `tools/cli` (`@flash/cli`) — Node CLI (`validate`, `build`, `audio`, `inbox`) and local JSON-RPC 2.0 MCP server (`mcp`).

## Hard Architectural Rules

1. **`packages/core` purity:** Zero imports of `react`, `react-dom`, `dexie`, `@flash/platform-web`, `@flash/ui`, DOM APIs (`window`, `document`, `indexedDB`), or `node:*` built-ins. Enforced by `packages/core/tsconfig.json` (`lib: ["ES2023"]`, no `"DOM"`) and ESLint `no-restricted-imports`.
2. **Events are the truth:** All mutations append immutable events (`Event`). Card schedules and due counts are derived deterministically via `replay`. Active reviews sort by `(reviewed_at, hlc, review_id)`.
3. **Performance budget (§8):** Initial study-screen JS `<= 160 KB` gzipped, `0` default web fonts (system CJK font stacks only), `<= 16 ms` optimistic flip/rate UI transition (persistence async), virtualized Browse list.
4. **Phased scope discipline (§15):** Keep `packages/core` data structures ready for future phases (Pages, Courses, Answer Modes, Sync), but keep Phase 1 UI focused on offline Flip study, FSRS, Undo, Deck/Browse/Settings, and CSV/TSV + `.flashpkg` import/export.
5. **Security (§13):** Never render raw HTML from note/package content; validate `.flashpkg` archives against zip path-traversal, file count, and uncompressed byte caps.

## Workflow

These rules bind every agent here, Claude Code and Antigravity alike. Several agents often work in this repository at once, each in its own worktree.

- **One branch per change, from `origin/main`.** Work in your own worktree, never in another agent's (Claude Code and Antigravity make one per agent; by hand, `git worktree add ../Korean-<slug> -b <type>/<slug> origin/main`). Name branches `<type>/<slug>`, type one of `feat` `fix` `refactor` `test` `docs` `chore`. Land it as a pull request into `main`; `main` takes no direct pushes. Commit messages follow the Conventional Commits style already in `git log`.
- **Set work aside with a WIP commit.** The stash list is shared by every worktree, so `git stash` can hand your work to another agent or theirs to you.
- **Update from main by merging** `origin/main` into your branch. A rebase needs a force-push, and force-pushes are the owner's.
- **Parallel agents each get their own** `E2E_PORT` (on the shared default 4173, `reuseExistingServer` silently tests another worktree's build) and their own scratch folder.
- **Bundle budget is shared.** Each branch can pass `pnpm size` alone while the sum of open branches overflows 160 KB: aim for zero initial-bundle growth (lazy-load new screens) and give the size before and after in the pull request.
- **Deterministic sorting:** compare strings with `compareCodeUnits` (`packages/core/src/study/queue.ts`). `localeCompare` differs by device locale and breaks replay, even where SonarCloud suggests it.
- **`docs/follow-ups.md`** holds owner decisions and the backlog. Other agents commit to it often: edit it from your own worktree and merge `origin/main` just before you push.
- **Gates:** `pnpm gate` (typecheck, lint, format, starter-pack check, unit and tool tests) before every push; CI's required `verify` check adds build, size and e2e. SonarCloud's quality gate (3% duplication on new lines) can fail while `verify` is green: check it before merging (`node tools/sonar-gate.mjs <pr>`).
- **Ask the owner only about design** (what to teach, study behaviour, scope, pricing), money, identity and accounts, and deleting data or history, each with your recommendation. Decide technical questions yourself and note the reason in the pull request.

## Workflow Checkpoints (Antigravity)

These are Antigravity commands; Claude Code has its own (`.claude/skills/`). Default to normal single-agent execution; never force a slash command for small, linear, or tightly coupled work. Only pause at a natural boundary and suggest a slash command (with a concise ready-to-run prompt) when it clearly pays off:

- **`/plan`** — starting a new Phase or major architectural change.
- **`/boost`** — immediately before tricky, high-stakes logic (e.g., event replay, FSRS, sync convergence, race-safe Sheets `Card ID` write-back, untrusted import security).
- **`/teamwork`** — after shared interfaces (`packages/core`, `packages/platform`) are frozen and `pnpm typecheck` passes, when 2+ independent package slices can run in parallel without file collisions.
- **`/goal`** — once features are wired and only a mechanical green-CI burn-down remains (`typecheck`, `lint`, `test`, `build`, `size`, `test:e2e`).
- **`/browser`** — when the PWA is ready for live visual, mobile-viewport, or `?device=a` / `?device=b` interactive QA.
