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
  edited note is marked `meaningEdited: true` in the generated module, and the deck description
  says some meanings are reworded by this app. This is not third-party data, so no licence applies.

## Credits live at deck level, not on cards

The vocabulary layouts reveal `example` and `notes` as their last step, so a credit there is what
a learner sees on every card. Since 1.2.0 the build keeps both fields free of credits
(`validateNotes` fails on one): `notes` holds learner content only (the Mandarin deck's "Also
read: …" readings) and is otherwise empty. The licences are satisfied at deck level:

- **NIKL list, KOGL Type 1:** requires naming the source (기관, year, work, 공공누리 제1유형) and
  not implying endorsement, not a per-item credit. The KOGL wording is in the catalog source's
  `attribution`, shown in Settings > About & Open Data Licenses and in
  `apps/web/public/THIRD-PARTY-NOTICES.txt`; the deck description names it too.
- **Wikidata lexemes, CC0 1.0:** no attribution required; credited anyway at deck level.
- **Unihan, Unicode License v3:** the copyright and permission notice must appear in copies of
  the data or in associated documentation: `THIRD-PARTY-NOTICES.txt` (full text) and About.

Per-note provenance is metadata beside the fields, never a field: `meaningSource` (the lexeme
id, e.g. `Wikidata L196`, or `Unihan 17.0.0 kDefinition`) and `meaningEdited`. Seeding
(`buildStarterDeckEvents`) does not copy it into events, so the built-in note types and the event
format are unchanged.

Decks seeded before 1.2.0 keep the old credit in their Notes field: starter decks have no update
path yet (see `docs/follow-ups.md`). The exact old text is reproducible from `meaningSource` and
`meaningEdited` (Korean: `Word list: NIKL 한국어 학습용 어휘 목록 (2003), KOGL Type 1. English:
Wikidata L… (CC0)[, edited by this app].`; Mandarin: `[Also read: …. ]Source: Unicode Unihan
17.0.0 (kHanyuPinlu, kMandarin, kDefinition), Unicode License v3[; meaning edited by this app].`),
so a future update step can clear it only where the field still equals it exactly.

Korean example sentences stay empty: no open source passed the licence gate in a pinned,
offline-reproducible form (see `docs/follow-ups.md`). They are never invented.

## Rebuild

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
