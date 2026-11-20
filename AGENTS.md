# AGENTS.md

Source of truth for architecture and phased scope: `docs/design_blueprint.md`.

## Commands

Run from repository root using `pnpm`:

- `pnpm install` — install workspace dependencies
- `pnpm dev` — start local Vite dev server (zero-login dev mode with sample decks)
- `pnpm build` — typecheck/build all packages and production PWA bundle (`apps/web/dist`)
- `pnpm typecheck` — strict TypeScript check across all workspace packages
- `pnpm lint` — ESLint (enforces architectural boundaries including `packages/core` purity)
- `pnpm format:check` / `pnpm format` — Prettier formatting check/write
- `pnpm test` — Vitest unit, golden, and `fast-check` property tests
- `pnpm size` — enforce §8 bundle budget (`<= 150 KB` gzipped initial study-screen JS, 0 web fonts)
- `pnpm test:e2e` — Playwright end-to-end tests (study, undo, import/export, offline, multi-device isolation)

## Agent-Friendly Dev Mode

- `pnpm dev` boots with **no login** and seeds sample decks (`ja`, `zh-Hans`, `ko` + Hanja, `en`) when local storage is empty.
- Append `?device=a` or `?device=b` to isolate IndexedDB databases (`flashcards-db-a`, `flashcards-db-b`) in the same browser and wire the in-memory/BroadcastChannel `SyncTransport` stub.

## Monorepo Boundaries

- `packages/content-schema` (`@flash/content-schema`) — Zod schemas & JSON Schema exports for `.flashpkg`.
- `packages/core` (`@flash/core`) — **100% pure TypeScript**: events, deterministic replay, `ts-fsrs` wrapper, Note Types, Layouts, Card derivation, Ruby/Pinyin parsers, CSV/TSV & `.flashpkg` import/export, sample data.
- `packages/platform` (`@flash/platform`) — pure TypeScript interfaces (`Storage`, `Files`, `SyncTransport`, `Auth`, `TtsProvider`, `AudioPlayer`, `Purchase`).
- `packages/platform-web` (`@flash/platform-web`) — Dexie IndexedDB `Storage`, browser `Files`, in-memory/BroadcastChannel `SyncTransport`.
- `packages/ui` (`@flash/ui`) — lean React UI components & screens consuming `@flash/core` and `@flash/platform`.
- `apps/web` — static Vite + React + Tailwind v4 + `vite-plugin-pwa` shell.

## Hard Architectural Rules

1. **`packages/core` purity:** Zero imports of `react`, `react-dom`, `dexie`, `@flash/platform-web`, `@flash/ui`, DOM APIs (`window`, `document`, `indexedDB`), or `node:*` built-ins. Enforced by `packages/core/tsconfig.json` (`lib: ["ES2023"]`, no `"DOM"`) and ESLint `no-restricted-imports`.
2. **Events are the truth:** All mutations append immutable events (`Event`). Card schedules and due counts are derived deterministically via `replay`. Active reviews sort by `(reviewed_at, hlc, review_id)`.
3. **Performance budget (§8):** Initial study-screen JS `<= 150 KB` gzipped, `0` default web fonts (system CJK font stacks only), `<= 16 ms` optimistic flip/rate UI transition (persistence async), virtualized Browse list.
4. **Phased scope discipline (§15):** Keep `packages/core` data structures ready for future phases (Pages, Courses, Answer Modes, Sync), but keep Phase 1 UI focused on offline Flip study, FSRS, Undo, Deck/Browse/Settings, and CSV/TSV + `.flashpkg` import/export.
5. **Security (§13):** Never render raw HTML from note/package content; validate `.flashpkg` archives against zip path-traversal, file count, and uncompressed byte caps.
