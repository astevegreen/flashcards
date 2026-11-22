/**
 * Pinned open-data sources for the curated onboarding starter decks (Phase 14 Stream D).
 *
 * Every source below passed the licence gate for commercial redistribution in a paid app (see the
 * licence notes per source and apps/web/public/THIRD-PARTY-NOTICES.txt). Share-alike,
 * non-commercial, no-derivatives and unclear sources (JMdict/EDICT, KANJIDIC2, CC-CEDICT,
 * KRDict, Wiktionary, the tanos JLPT lists, HSK lists) are deliberately NOT used.
 *
 * `scripts/fetch-starter-sources.mjs` downloads these into the gitignored cache and checks the
 * pinned sha256; `scripts/build-starter-decks.mjs` reads only that cache (no network).
 */

/** Bump when the generated decks change in a way users should see as a new deck version. */
export const STARTER_DECKS_VERSION = '1.0.0';

/** NIKL 한국어 학습용 어휘 목록 (2003), KOGL Type 1. CP949-encoded tab-separated text. */
export const NIKL_VOCAB = {
  key: 'nikl_vocab',
  file: 'nikl-learning-vocabulary-2003.txt',
  url: 'https://www.korean.go.kr/common/download.do?file_path=etcData&c_file_name=b73a8438-4713-4436-8481-ec26fd0dce2a_0.txt&o_file_name=%ED%95%9C%EA%B5%AD%EC%96%B4%20%ED%95%99%EC%8A%B5%EC%9A%A9%20%EC%96%B4%ED%9C%98%20%EB%AA%A9%EB%A1%9D.txt',
  pageUrl: 'https://www.korean.go.kr/front_eng/down/down_02V.do?etc_seq=70',
  encoding: 'euc-kr',
  sha256: '3b49681f05d6a7490c13da2a2847e433effdf65da409fd295792d6ee33685064',
};

/** Unicode Unihan database, pinned release (Unicode License v3). */
export const UNIHAN = {
  key: 'unihan',
  version: '17.0.0',
  file: 'Unihan-17.0.0.zip',
  url: 'https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip',
  sha256: 'f7a48b2b545acfaa77b2d607ae28747404ce02baefee16396c5d2d7a8ef34b5e',
  readingsFile: 'Unihan_Readings.txt',
  variantsFile: 'Unihan_Variants.txt',
};

/** Unicode License v3 text, reproduced in THIRD-PARTY-NOTICES.txt. */
export const UNICODE_LICENSE = {
  key: 'unicode_license',
  file: 'unicode-license.txt',
  url: 'https://www.unicode.org/license.txt',
};

/**
 * Wikidata lexemes (CC0 1.0). Each lexeme is pinned to one revision in the committed lock file,
 * with the sha256 of its normalized record, so a later edit on Wikidata never changes a rebuild.
 */
export const WIKIDATA = {
  key: 'wikidata_ko_lexemes',
  lockFile: 'content/starters/wikidata-ko-lexemes.lock.json',
  entityDataUrl: (id, revision) =>
    `https://www.wikidata.org/wiki/Special:EntityData/${id}.json?revision=${revision}`,
  sparqlUrl: 'https://query.wikidata.org/sparql',
  /** Wikidata item for the Korean language. */
  koreanLanguageItem: 'Q9176',
};

export const USER_AGENT = 'flashcards-starter-builder/1.0 (open-data deck compiler)';
