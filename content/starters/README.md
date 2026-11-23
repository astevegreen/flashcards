# Starter-deck inputs

Committed, pinned inputs for the curated onboarding starter decks (Phase 14). The generated decks
live in `packages/core/src/starters/generated/`. Never edit those files by hand.

- `wikidata-ko-lexemes.lock.json`: the Wikidata lexemes (CC0) used for the Korean deck's English
  meanings. Each lexeme is pinned to one revision, with the sha256 of its normalized record.
- `gloss-overrides.json`: the app's own wording for glosses that read as definitions, grammar
  labels or the wrong sense (the fixes accepted from `docs/starter-gloss-review.md`). Keyed by deck
  slug, then by the note's stable key (`nikl:개03:noun`, `unihan:U+7684`). Each entry has `word`
  (the card front), `upstream` (the exact gloss the build derives from the pinned source) and
  `meaning` (what the card shows). The build fails when `word` or `upstream` no longer match, or
  when a key names no note, so an upstream change is reviewed instead of keeping a stale fix. An
  edited card's Notes credit says so ("edited by this app"); the word list keeps its NIKL or Unihan
  credit. This is not third-party data, so no licence applies.

Rebuild:

```sh
node scripts/fetch-starter-sources.mjs   # network: pinned NIKL list, Unihan 17.0.0, lexeme revisions
node scripts/build-starter-decks.mjs     # offline, deterministic; --check verifies the committed output
```

Before committing any change to the generated modules (or to the builder, the lock file or the
pinned sources), run `node scripts/build-starter-decks.mjs --check` with the cache present. CI has
no cache: it tests the builder on fixtures and checks the committed decks against their catalog
`contentHash`, so it does not catch a hand edit that also updates the hash.

To pick up newer Wikidata lexemes, run `node scripts/fetch-starter-sources.mjs --discover`, review
the lock-file diff and the rebuilt decks, then commit both. Licences and the sources that were
rejected are recorded in `scripts/starters/sources.mjs`, `apps/web/public/THIRD-PARTY-NOTICES.txt`
and the table below.

## Rejected sources

Not used: each needs a licence that permits commercial redistribution in a paid app without
share-alike, non-commercial or no-derivatives terms. The owner decides whether any of these is
acceptable (checked 2026-11-22).

| Source                                         | Licence                                      | Classification                       | Reference                                                   |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| JMdict / EDICT (Japanese glosses)              | CC BY-SA 4.0                                 | Share-alike                          | https://www.edrdg.org/edrdg/licence.html                    |
| KANJIDIC2 (kanji readings, meanings)           | CC BY-SA 4.0                                 | Share-alike                          | https://www.edrdg.org/edrdg/licence.html                    |
| CC-CEDICT (Mandarin glosses)                   | CC BY-SA 4.0                                 | Share-alike                          | https://cc-cedict.org/wiki/                                 |
| KRDict 한국어기초사전 (Korean glosses)         | CC BY-SA 2.0 KR                              | Share-alike                          | https://krdict.korean.go.kr/kboardPolicy/copyRightTermsInfo |
| Wiktionary                                     | CC BY-SA 4.0 and GFDL                        | Share-alike                          | https://en.wiktionary.org/wiki/Wiktionary:Copyrights        |
| tanos.co.uk JLPT lists                         | No clear licence; glosses derive from JMdict | Unclear (and share-alike via JMdict) | http://www.tanos.co.uk/jlpt/                                |
| HSK word lists (Chinese Testing International) | No open licence published                    | Unclear                              | https://www.chinesetest.cn/                                 |

An option not yet built: a Japanese kanji starter from Unihan 17.0.0 alone (kJoyoKanji, kJapanese
readings, kDefinition; all Unicode License v3). Unihan has no Japanese frequency or grade field,
and kDefinition glosses are Chinese-oriented, so the deck's selection and meanings would be weaker
than the Korean and Mandarin decks.
