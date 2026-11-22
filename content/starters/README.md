# Starter-deck inputs

Committed, pinned inputs for the curated onboarding starter decks (Phase 14). The generated decks
live in `packages/core/src/starters/generated/`. Never edit those files by hand.

- `wikidata-ko-lexemes.lock.json`: the Wikidata lexemes (CC0) used for the Korean deck's English
  meanings. Each lexeme is pinned to one revision, with the sha256 of its normalized record.

Rebuild:

```sh
node scripts/fetch-starter-sources.mjs   # network: pinned NIKL list, Unihan 17.0.0, lexeme revisions
node scripts/build-starter-decks.mjs     # offline, deterministic; --check verifies the committed output
```

To pick up newer Wikidata lexemes, run `node scripts/fetch-starter-sources.mjs --discover`, review
the lock-file diff and the rebuilt decks, then commit both. Licences and the sources that were
rejected are recorded in `scripts/starters/sources.mjs` and `apps/web/public/THIRD-PARTY-NOTICES.txt`.
