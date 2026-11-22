// Unit tests for the `build-packs.mjs --full` upstream parsers, using tiny inline snippets in each
// upstream's real format. These run in normal `pnpm test` with no network or upstream downloads.
import { describe, expect, it } from 'vitest';
import { convertKanjivgSvgToHanziWriter } from '../../packages/core/src/drawing/kanjivg.ts';
import { decodePackArchive } from '../../packages/core/src/dictionary/pack-codec.ts';
import {
  cedictVersion,
  jmdictVersion,
  kangxiRadicalChar,
  kanjidic2Version,
  parseCedict,
  parseJmdict,
  parseKanjidic2,
  parseKanjivgXml,
  parseMmahGraphics,
  parseUnihanHanja,
  splitDefinition,
  unihanVersion,
} from '../packs/upstream-parsers.mjs';

const UNIHAN_READINGS = `# Unihan_Readings.txt
# Unicode Version 18.0.0
U+5B78\tkDefinition\tlearning, knowledge; school
U+5B78\tkHangul\t학:0E
U+5B78\tkMandarin\txué
U+4E28\tkDefinition\tline (radical 2)
U+4E28\tkHangul\t곤:1N
U+9F98\tkDefinition\t(same as U+9F8D 龍) dragon
`;
const UNIHAN_IRG = `U+5B78\tkRSUnicode\t39.13
U+5B78\tkTotalStrokes\t16
U+4E28\tkRSUnicode\t2.0
U+4E28\tkTotalStrokes\t1
`;
const UNIHAN_VARIANTS = `U+5B78\tkSimplifiedVariant\tU+5B66
U+5B78\tkJapaneseNewVariant\tU+5B66
`;

describe('upstream parsers', () => {
  it('parses Unihan Hanja with education flags, radicals and variants', () => {
    expect(unihanVersion(UNIHAN_READINGS)).toBe('18.0.0');
    const entries = parseUnihanHanja({
      readings: UNIHAN_READINGS,
      irgSources: UNIHAN_IRG,
      variants: UNIHAN_VARIANTS,
    });
    expect(entries).toEqual([
      {
        headword: '學',
        altForms: ['学'],
        readings: ['학'],
        meanings: ['learning', 'knowledge', 'school'],
        strokeCount: 16,
        radical: '子',
        grade: 'Education Hanja (Basic 1800)',
      },
      {
        headword: '丨',
        readings: ['곤'],
        meanings: ['line (radical 2)'],
        strokeCount: 1,
        radical: '丨',
      },
    ]);
  });

  it('keeps commas inside parentheses and maps Kangxi radicals', () => {
    expect(splitDefinition('(same as 龍, dragon) dragon; imperial')).toEqual([
      '(same as 龍, dragon) dragon',
      'imperial',
    ]);
    expect(kangxiRadicalChar(184)).toBe('食');
    expect(kangxiRadicalChar(0)).toBeUndefined();
  });

  it('parses KANJIDIC2 characters', () => {
    const xml = `<kanjidic2><header><database_version>2026-326</database_version></header>
<character><literal>食</literal><radical><rad_value rad_type="classical">184</rad_value></radical>
<misc><grade>2</grade><stroke_count>9</stroke_count><freq>328</freq><jlpt>4</jlpt></misc>
<reading_meaning><rmgroup><reading r_type="pinyin">shi2</reading><reading r_type="ja_on">ショク</reading>
<reading r_type="ja_kun">た.べる</reading><meaning>eat</meaning><meaning>food &amp; drink</meaning>
<meaning m_lang="fr">manger</meaning></rmgroup><nanori>け</nanori></reading_meaning></character></kanjidic2>`;
    expect(kanjidic2Version(xml)).toBe('2026-326');
    expect(parseKanjidic2(xml)).toEqual([
      {
        headword: '食',
        readings: ['ショク', 'た.べる', 'け'],
        meanings: ['eat', 'food & drink'],
        strokeCount: 9,
        radical: '食',
        grade: 'Grade 2 · JLPT N5',
        frequency: 328,
      },
    ]);
  });

  it('parses JMdict entries with senses and frequency bands', () => {
    const xml = `<!-- JMdict created: 2026-11-22 -->
<JMdict><entry><ent_seq>1</ent_seq><k_ele><keb>食べる</keb><ke_pri>ichi1</ke_pri><ke_pri>nf03</ke_pri></k_ele>
<k_ele><keb>喰べる</keb></k_ele><r_ele><reb>たべる</reb></r_ele>
<sense><pos>&v1;</pos><gloss>to eat</gloss></sense><sense><gloss>to live on</gloss><gloss>to subsist on</gloss></sense></entry>
<entry><ent_seq>2</ent_seq><r_ele><reb>ヽ</reb></r_ele><sense><gloss>repetition mark</gloss></sense></entry></JMdict>`;
    expect(jmdictVersion(xml)).toBe('2026-11-22');
    expect(parseJmdict(xml)).toEqual([
      {
        headword: '食べる',
        altForms: ['喰べる'],
        readings: ['たべる'],
        meanings: ['to eat', 'to live on; to subsist on'],
        grade: 'Common word',
        frequency: 1250,
      },
      { headword: 'ヽ', readings: ['ヽ'], meanings: ['repetition mark'] },
    ]);
  });

  it('parses CC-CEDICT lines and normalizes ü', () => {
    const text = `#! date=2026-11-22T09:11:05Z
學習 学习 [xue2 xi2] /to learn/to study/
旅行 旅行 [lu:3 xing2] /to travel/journey/
`;
    expect(cedictVersion(text)).toBe('2026-11-22');
    expect(parseCedict(text)).toEqual([
      {
        headword: '学习',
        altForms: ['學習'],
        readings: ['xue2 xi2'],
        meanings: ['to learn', 'to study'],
      },
      { headword: '旅行', readings: ['lv3 xing2'], meanings: ['to travel', 'journey'] },
    ]);
  });

  it('converts KanjiVG XML (skipping variants) and Make Me a Hanzi graphics', () => {
    const kvg = `<kanjivg><kanji id="kvg:kanji_04e00"><g id="kvg:04e00" kvg:element="一">
<path id="kvg:04e00-s1" kvg:type="㇐" d="M11,54.25c3.19,0.62,6.25,0.75,9.73,0.5c20.64-1.5,50.39-5.12,68.58-5.24c3.6-0.02,5.77,0.24,7.57,0.49"/>
</g></kanji><kanji id="kvg:kanji_04e00-Kaisho"><g><path d="M1,1 L2,2"/></g></kanji></kanjivg>`;
    const ja = parseKanjivgXml(kvg, convertKanjivgSvgToHanziWriter);
    expect(Object.keys(ja)).toEqual(['一']);
    expect(ja['一'].strokes).toHaveLength(1);

    const zh = parseMmahGraphics(
      '{"character":"一","strokes":["M 1 1 L 2 2 Z"],"medians":[[[100.4,400],[900,400.6]]]}\n',
    );
    expect(zh['一'].medians).toEqual([
      [
        [100, 400],
        [900, 401],
      ],
    ]);
  });

  it('produces payloads the runtime pack codec accepts', () => {
    const entries = parseCedict('學習 学习 [xue2 xi2] /to learn/\n');
    const manifest = {
      format_version: 1,
      id: 'dict-cc-cedict',
      kind: 'dictionary',
      name: 'CC-CEDICT',
      version: 'cedict-test',
      language: 'zh-Hans',
      description: 'test',
      license_name: 'CC BY-SA 4.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'MDBG',
      source_url: 'https://www.mdbg.net/chinese/dictionary?page=cc-cedict',
    };
    const decoded = decodePackArchive(
      new TextEncoder().encode(JSON.stringify({ manifest, entries })),
    );
    expect('entries' in decoded && decoded.entries).toEqual(entries);
  });
});
