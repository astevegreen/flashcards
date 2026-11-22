# Flashcards

A local-first, zero-server foreign language flashcard and study Progressive Web App built for Japanese (`ja`), Mandarin Simplified (`zh-Hans`), Korean + Hanja (`ko`), and English (`en`).

See [docs/design_blueprint.md](./docs/design_blueprint.md) for the full architecture & phased roadmap, and [AGENTS.md](./AGENTS.md) for workspace conventions and build/test commands.

## Architecture & Implemented Phases (Phases 1–8)

- **Pure TypeScript Core (`@flash/core`)**: Immutable event log, deterministic FSRS replay (`ts-fsrs`) with parameter versioning and lossless undo, Hybrid Logical Clocks (HLC), deterministic UUIDv5 card derivation, strict CJK Ruby (`漢字[かんじ]`, `{base|reading}`, `{日本|に|ほん}`), Cloze (`{{c1::…}}`), and Pinyin tone-mark parsers, language-aware typed-answer matching (`ja`, `zh-Hans`, `ko`, `en`), daily study queue with `04:00` rollover and sibling burying, offline dictionary search & stroke grading/recognition, offline Ed25519 license verification, RFC 4180 CSV/TSV importer, and hardened `.flashpkg` zip import/export.
- **Content Schema (`@flash/content-schema`)**: Zod + JSON Schema validation for `.flashpkg` archives, family/starter catalogs (`index.json`), and pack catalogs (`packs.json`).
- **Platform Boundary (`@flash/platform`, `@flash/platform-web`, `@flash/platform-capacitor`, `@flash/platform-tauri`)**: Dexie IndexedDB & SQLite storage, Google Drive `appDataFolder` / Local Folder / Dropbox / iCloud sync transports, Google Picker & Sheets/Docs incremental sync, File System Access API local folders & `Inbox/` auto-import, Web Audio lookahead preloader + BYO Cloud TTS (Google / Azure) + offline `speechSynthesis`, offline dictionary & stroke pack storage, and StoreKit 2 / Play Billing / Ed25519 purchase adapters.
- **Offline PWA (`@flash/ui`, `@flash/web`)**: Zero-login study screen with `flip`, `typed`, `choice`, `cloze`, `listen`, and `draw` answer modes, Markdown Lesson Pages & prerequisite Courses, virtualized Browse & standalone bidirectional offline Dictionary + Draw-to-Lookup, zero default web fonts, and Workbox offline precaching.
- **AI Tooling (`@flash/cli`)**: Node CLI (`validate`, `build`, `audio`, `inbox`) and local JSON-RPC 2.0 MCP server (`list_decks`, `get_weak_cards`, `get_stats`, `propose_package`).

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
