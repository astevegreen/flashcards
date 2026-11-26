import type { DataLicenseAttribution } from './types.ts';

/**
 * Upstream license & attribution metadata for all downloadable data packs & drawing engine
 * per docs/design_blueprint.md (§6.3, §6.4) and ADR 0001 Spike 0.6.
 * Share-alike / Arphic licenses apply strictly to the separate downloadable data packs,
 * never mixed into proprietary TypeScript source code.
 */
export const OPEN_DATA_ATTRIBUTIONS: readonly DataLicenseAttribution[] = [
  {
    id: 'dict-hanja-unihan',
    packId: 'dict-hanja-unihan',
    name: 'Hanja Dictionary (Unicode Unihan + Basic Education Hanja)',
    scope: 'Korean Hanja readings (kHangul), definitions (kDefinition), radicals & stroke counts',
    licenseName: 'Unicode License v3',
    licenseUrl: 'https://www.unicode.org/license.txt',
    sourceUrl: 'https://www.unicode.org/charts/unihan.html',
    attribution:
      'Copyright © 1991–2026 Unicode, Inc. Derived from the Unicode Character Database (Unihan).',
    noticeText:
      'Distributed under the Unicode License v3 (permissive). Permission is hereby granted, free of charge, to any person obtaining a copy of the Unicode data files and any associated documentation to deal in the Data Files without restriction, provided that this copyright and permission notice appear with all copies.',
  },
  {
    id: 'dict-kanjidic2',
    packId: 'dict-kanjidic2',
    name: 'KANJIDIC2 (Japanese Kanji Dictionary)',
    scope: 'Japanese Kanji readings (on/kun), English meanings, JLPT/grade & stroke counts',
    licenseName: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://www.edrdg.org/wiki/index.php/KANJIDIC_Project',
    attribution:
      'KANJIDIC2 is the property of the Electronic Dictionary Research and Development Group (EDRDG) and is used in conformance with the Group’s licence.',
    noticeText:
      'Licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0). Share-alike applies to derivative dictionary data packs only, not to the Flashcards application code.',
  },
  {
    id: 'dict-cc-cedict',
    packId: 'dict-cc-cedict',
    name: 'CC-CEDICT (Mandarin Chinese-English Dictionary)',
    scope: 'Simplified & Traditional Chinese headwords, Pinyin readings, and English definitions',
    licenseName: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://www.mdbg.net/chinese/dictionary?page=cc-cedict',
    attribution: 'CC-CEDICT community dictionary maintained by MDBG.',
    noticeText:
      'Licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0). Modifications to the dictionary data pack are shared under the same license.',
  },
  {
    id: 'dict-jmdict',
    packId: 'dict-jmdict',
    name: 'JMdict (Japanese-English Word Dictionary)',
    scope:
      'Comprehensive Japanese vocabulary, kana readings, and English glosses (optional large pack)',
    licenseName: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://www.edrdg.org/jmdict/j_jmdict.html',
    attribution:
      'JMdict is the property of the Electronic Dictionary Research and Development Group (EDRDG) and is used in conformance with the Group’s licence.',
    noticeText:
      'Licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0). Distributed as an optional standalone downloadable data pack.',
  },
  {
    id: 'dict-krdict',
    packId: 'dict-krdict',
    name: 'Korean Basic Dictionary (한국어기초사전, KRDict) — English edition',
    scope:
      'Korean headwords with per-sense English equivalents and definitions, part of speech, learner level, standard pronunciation, Hanja origin, conjugations and example sentences',
    licenseName: 'CC BY-SA 2.0 KR',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0/kr/',
    sourceUrl: 'https://krdict.korean.go.kr/',
    attribution:
      '한국어기초사전 (Korean Basic Dictionary) © National Institute of Korean Language (국립국어원).',
    noticeText:
      'Text licensed under Creative Commons Attribution-ShareAlike 2.0 Korea (CC BY-SA 2.0 KR). Converted to the offline pack JSON format; share-alike applies to the dictionary data pack only, not to the Flashcards application code. Multimedia (pronunciation audio, images) is not included. The bundled dev/CI starter pack is a small hand-authored sample in the same format.',
  },
  {
    id: 'dict-urimalsam',
    packId: 'dict-urimalsam',
    name: 'Urimalsaem (우리말샘, NIKL Open Korean Dictionary — Optional)',
    scope:
      'Broad Korean–Korean headword coverage (neologisms, technical terms, Hanja origins, standard pronunciations and definitions)',
    licenseName: 'CC BY-SA 2.0 KR',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0/kr/',
    sourceUrl: 'https://opendict.korean.go.kr/',
    attribution:
      '우리말샘 (Urimalsaem) © National Institute of Korean Language (국립국어원) and contributors.',
    noticeText:
      'Licensed under Creative Commons Attribution-ShareAlike 2.0 Korea (CC BY-SA 2.0 KR). Distributed as an optional standalone downloadable data pack; share-alike applies to the dictionary data pack only, not to the Flashcards application code.',
  },
  {
    id: 'dict-kaikki-ko',
    packId: 'dict-kaikki-ko',
    name: 'Kaikki Wiktionary Korean–English (Optional)',
    scope:
      'Extra English glosses, Hanja forms, pronunciations, slang, idioms and usage examples extracted from English Wiktionary via Kaikki.org',
    licenseName: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://kaikki.org/dictionary/Korean/',
    attribution:
      'Derived from English Wiktionary contributors via Kaikki.org (Tatu Ylonen / wiktextract).',
    noticeText:
      'Licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0). Distributed as an optional standalone downloadable data pack; share-alike applies to the dictionary data pack only, not to the Flashcards application code.',
  },
  {
    id: 'strokes-ja-kanjivg',
    packId: 'strokes-ja-kanjivg',
    name: 'KanjiVG (Japanese Stroke Order Data)',
    scope: 'Japanese Kanji & Kana stroke order vectors and medians (separate from Chinese)',
    licenseName: 'CC BY-SA 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    sourceUrl: 'https://kanjivg.tagaini.net/',
    attribution: 'KanjiVG is copyright © 2009–2026 Ulrich Apel and contributors.',
    noticeText:
      'Licensed under Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0). Converted into Hanzi Writer compatible stroke JSON as a separate downloadable pack.',
  },
  {
    id: 'strokes-zh-mmah',
    packId: 'strokes-zh-mmah',
    name: 'Make Me a Hanzi / hanzi-writer-data (Chinese & Hanja Stroke Data)',
    scope:
      'Simplified & Traditional Hanzi/Hanja stroke order outlines and medians (separate from Japanese)',
    licenseName: 'Arphic Public License (1999)',
    licenseUrl: 'https://ftp.gnu.org/gnu/non-gnu/chinese-fonts-truetype/LICENSE',
    sourceUrl: 'https://github.com/skishore/makemeahanzi',
    attribution:
      'Stroke graphics derived from Make Me a Hanzi (Shaunak Kishore) and Arphic PL Kaiti / Mingti fonts (Arphic Technology Co., Ltd.).',
    noticeText:
      'Distributed strictly as a separate downloadable data pack under the Arphic Public License (1999) (ARPHICPL). Never bundled into application source code (ADR 0001 Spike 0.6).',
  },
  {
    id: 'lib-hanzi-writer',
    name: 'Hanzi Writer (Graded Stroke Quiz Renderer)',
    scope: 'Interactive character stroke animation and quiz grading engine',
    licenseName: 'MIT License',
    licenseUrl: 'https://opensource.org/license/mit',
    sourceUrl: 'https://github.com/chanind/hanzi-writer',
    attribution: 'Copyright © David Chanin and Hanzi Writer contributors.',
    noticeText:
      'Licensed under the MIT License. Lazy-loaded on demand only when studying Draw answer-mode cards.',
  },
];
