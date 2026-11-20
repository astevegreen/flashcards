# Flashcards

A local-first, zero-server foreign language flashcard and study Progressive Web App built for Japanese (`ja`), Mandarin Simplified (`zh-Hans`), Korean + Hanja (`ko`), and English (`en`).

See [docs/design_blueprint.md](./docs/design_blueprint.md) for the full architecture & phased roadmap, and [AGENTS.md](./AGENTS.md) for workspace conventions and build/test commands.

## Phase 1 Status (Lean Offline MVP)

- **Pure TypeScript Core (`@flash/core`)**: Immutable event log, deterministic FSRS replay (`ts-fsrs`) with parameter versioning and lossless undo, Hybrid Logical Clocks (HLC), deterministic UUIDv5 card derivation, strict CJK Ruby (`漢字[かんじ]`, `{base|reading}`, `{日本|に|ほん}`) and Pinyin tone-mark parsers, daily study queue with `04:00` rollover and sibling burying, RFC 4180 CSV/TSV importer, and hardened `.flashpkg` zip import/export.
- **Content Schema (`@flash/content-schema`)**: Zod + JSON Schema validation for `.flashpkg` archives.
- **Platform Boundary (`@flash/platform`, `@flash/platform-web`)**: Dexie IndexedDB storage, browser file picker/downloads, and dev-mode `SyncTransport` stub.
- **Offline PWA (`@flash/ui`, `@flash/web`)**: Zero-login study screen with keyboard shortcuts, mobile swipe gestures, 3-button FSRS rating (+ 2/4-button toggle), virtualized Browse list, Library with 1-tap Recognition/Production layout toggles, zero default web fonts, and Workbox offline precaching.

## Quick Start

```bash
pnpm install
pnpm dev
```

Dev mode boots with zero login and sample decks. Append `?device=a` or `?device=b` to run isolated local IndexedDB instances in the same browser.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm size
pnpm test:e2e
```

## License

Copyright (c) 2026 astevegreen. All rights reserved.
