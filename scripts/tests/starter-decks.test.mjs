// Tests for the deterministic starter-deck builder (scripts/build-starter-decks.mjs), on tiny
// inline fixtures in each upstream's real format. No network. When the real pinned sources are in
// the gitignored cache (node scripts/fetch-starter-sources.mjs), it also checks that a rebuild is
// byte-identical to the committed generated modules.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFromCache,
  buildStarterDecks,
  DEFAULT_CACHE_DIR,
  GENERATED_DIR,
  renderStarterModules,
} from '../build-starter-decks.mjs';
import {
  canonicalLexemeJson,
  cardReading,
  hasToneMark,
  mandarinDefinition,
  normalizeLexeme,
  parseHanyuPinlu,
  parseNiklList,
  stripHomographNumber,
} from '../starters/lib.mjs';
import { NIKL_VOCAB } from '../starters/sources.mjs';

const NIKL = [
  '순위\t단어\t품사\t풀이\t등급',
  '',
  '25\t가다01\t동\t\tA',
  '30\t그01\t대\t\tA',
  '31\t그01\t관\t\tA',
  '35\t이05\t대\t\tA',
  '36\t이05\t관\t\tA',
  '500\t씨07\t의\t氏\tA',
  '600\t전화07\t명\t電話\tA',
  '601\t전화하다02\t동\t電話-\tA',
  '700\t눈01\t명\t\tA',
  '800\t눈04\t명\t\tB',
  '900\t사람\t명\t\tA',
  '1000\t나무\t명\t\tB',
  '1100\t그리고\t부\t\tA',
].join('\r\n');

function lexemeJson(id, revision, category, lemmas, glosses) {
  return {
    entities: {
      [id]: {
        type: 'lexeme',
        id,
        lastrevid: revision,
        language: 'Q9176',
        lexicalCategory: category,
        lemmas: Object.fromEntries(
          lemmas.map(([language, value]) => [language, { language, value }]),
        ),
        senses: glosses.map((g, i) => ({
          id: `${id}-S${i + 1}`,
          glosses: { en: { language: 'en', value: g }, ko: { language: 'ko', value: '뜻' } },
        })),
        forms: [],
      },
    },
  };
}

const RAW_LEXEMES = [
  lexemeJson('L20', 2, 'Q24905', [['ko', '가다']], ['to go', 'to leave']),
  lexemeJson('L21', 3, 'Q36224', [['ko', '그']], ['he or she']),
  lexemeJson('L22', 4, 'Q576271', [['ko', '그']], ['that']),
  // A native homograph with no Hanja must not lend its meaning to 씨 (氏).
  lexemeJson('L23', 5, 'Q1084', [['ko', '씨']], ['seed']),
  lexemeJson(
    'L24',
    6,
    'Q1084',
    [
      ['ko', '전화'],
      ['ko-hani', '電話'],
    ],
    ['telephone'],
  ),
  lexemeJson(
    'L25',
    7,
    'Q24905',
    [
      ['ko', '전화하다'],
      ['ko-kore', '電話하다'],
    ],
    ['to phone'],
  ),
  // 눈 is ambiguous in the NIKL list itself (눈01 eye, 눈04 snow): skipped.
  lexemeJson('L26', 8, 'Q1084', [['ko', '눈']], ['eye']),
  // Two lexemes could match 사람: skipped rather than guessed.
  lexemeJson('L27', 9, 'Q1084', [['ko', '사람']], ['person']),
  lexemeJson('L28', 10, 'Q1084', [['ko', '사람']], ['human']),
  lexemeJson('L29', 11, 'Q1084', [['ko', '나무']], ['tree']),
  // Right spelling, wrong part of speech.
  lexemeJson('L30', 12, 'Q1084', [['ko', '그리고']], ['and']),
  // 이 as pronoun and as determiner with the same meaning: one card, not two identical ones.
  lexemeJson('L31', 13, 'Q36224', [['ko', '이']], ['this']),
  lexemeJson('L32', 14, 'Q576271', [['ko', '이']], ['this']),
];
const LEXEMES = RAW_LEXEMES.map((json) => {
  const id = Object.keys(json.entities)[0];
  return normalizeLexeme(json, id);
});

const UNIHAN_READINGS = [
  '# Unihan_Readings.txt',
  'U+4E00\tkDefinition\tone; a, an; alone',
  'U+4E00\tkHanyuPinlu\tyī(50)',
  'U+4E00\tkMandarin\tyī',
  'U+5B57\tkHanyuPinlu\tzì(10)',
  'U+5B57\tkMandarin\tzì',
  'U+7684\tkDefinition\tpossessive, adjectival suffix',
  'U+7684\tkHanyuPinlu\tdí(5) de(100) dì(1)',
  'U+7684\tkMandarin\tde',
  // 地: the first (zh-Hans) kMandarin value is the neutral-tone particle; the gloss is dì's.
  'U+5730\tkDefinition\tearth; soil',
  'U+5730\tkHanyuPinlu\tde(7) dì(5)',
  'U+5730\tkMandarin\tde dì',
  'U+7740\tkDefinition\tmake move, take action',
  'U+7740\tkHanyuPinlu\tzhe(20)',
  'U+7740\tkMandarin\tzhe',
  // 著 repeats the counts of its simplified variant 着; only zhù(4) is its own.
  'U+8457\tkDefinition\tmanifest; (Cant.) to wear',
  'U+8457\tkHanyuPinlu\tzhe(20) zhù(4)',
  'U+8457\tkMandarin\tzhù zhe',
  'U+8FD9\tkDefinition\tthis, the, here',
  'U+8FD9\tkHanyuPinlu\tzhè(50)',
  'U+8FD9\tkMandarin\tzhè',
  'U+9019\tkDefinition\tthis, the, here',
  'U+9019\tkHanyuPinlu\tzhè(50)',
  'U+9019\tkMandarin\tzhè',
].join('\n');
const UNIHAN_VARIANTS = [
  'U+8457\tkSimplifiedVariant\tU+8457 U+7740',
  'U+9019\tkSimplifiedVariant\tU+8FD9',
].join('\n');

const build = (lexemes = LEXEMES) =>
  buildStarterDecks({
    niklText: NIKL,
    unihanReadingsText: UNIHAN_READINGS,
    unihanVariantsText: UNIHAN_VARIANTS,
    lexemes,
    size: 10,
  });

describe('starter-deck parsers', () => {
  it('parses NIKL rows and strips homograph numbers only', () => {
    const rows = parseNiklList(NIKL);
    expect(rows).toHaveLength(13);
    expect(rows[0]).toEqual({
      rank: 25,
      entry: '가다01',
      word: '가다',
      pos: '동',
      origin: '',
      grade: 'A',
    });
    expect(stripHomographNumber('십이월')).toBe('십이월');
    expect(stripHomographNumber('3월02')).toBe('3월');
  });

  it('picks a toned reading over a neutral-tone first value, and drops Cantonese-only senses', () => {
    expect(hasToneMark('dì')).toBe(true);
    expect(hasToneMark('lǚ')).toBe(true);
    expect(hasToneMark('de')).toBe(false);
    expect(hasToneMark('nü')).toBe(false);
    expect(cardReading(['de', 'dì'])).toBe('dì');
    expect(cardReading(['zhù', 'zhe'])).toBe('zhù');
    expect(cardReading(['le'])).toBe('le');
    expect(mandarinDefinition('interrogative or emphatic final; (Cant.) this')).toBe(
      'interrogative or emphatic final',
    );
    expect(mandarinDefinition('(Cant.) only')).toBe('');
  });

  it('orders kHanyuPinlu readings by count, stably', () => {
    expect(parseHanyuPinlu('dí(5) de(100) dì(5)')).toEqual([
      { pinyin: 'de', count: 100 },
      { pinyin: 'dí', count: 5 },
      { pinyin: 'dì', count: 5 },
    ]);
  });

  it('normalizes a lexeme revision independently of key order', () => {
    const json = RAW_LEXEMES[4];
    const reordered = structuredClone(json);
    const entity = reordered.entities.L24;
    entity.lemmas = { 'ko-hani': entity.lemmas['ko-hani'], ko: entity.lemmas.ko };
    expect(canonicalLexemeJson(normalizeLexeme(reordered, 'L24'))).toBe(
      canonicalLexemeJson(normalizeLexeme(json, 'L24')),
    );
    expect(() => normalizeLexeme(json, 'L99')).toThrow('not a lexeme');
  });
});

describe('starter-deck builder', () => {
  it('builds Korean notes only from unambiguous matches, in NIKL rank order', () => {
    const [ko] = build();
    expect(ko.notes.map((n) => [n.key, n.fields.hanja, n.fields.meaning])).toEqual([
      ['nikl:가다01:verb', '', 'to go; to leave'],
      ['nikl:그01:pronoun', '', 'he or she'],
      ['nikl:그01:determiner', '', 'that'],
      ['nikl:이05:pronoun', '', 'this'],
      ['nikl:전화07:noun', '電話', 'telephone'],
      ['nikl:전화하다02:verb', '電話', 'to phone'],
    ]);
    expect(ko.notes[0].fields.notes).toContain('Wikidata L20 (CC0)');
    expect(ko.notes[0].tags).toEqual(['nikl-a', 'verb']);
    // The determiner row repeats the pronoun card exactly, so it only adds its tag.
    expect(ko.notes[3].tags).toEqual(['nikl-a', 'pronoun', 'determiner']);
    expect(ko.info.noteCount).toBe(6);
  });

  it('builds Mandarin notes from frequent simplified characters with customary pinyin', () => {
    const [, zh] = build();
    expect(zh.notes.map((n) => [n.fields.word, n.fields.reading])).toEqual([
      ['的', 'de'],
      ['一', 'yī'],
      ['这', 'zhè'],
      ['着', 'zhe'],
      ['地', 'dì'],
      // Ranked by its own count (4), not the 24 it shares with 着.
      ['著', 'zhù'],
    ]);
    expect(zh.notes[0].key).toBe('unihan:U+7684');
    expect(zh.notes[0].fields.notes).toMatch(/^Also read: dí, dì\. Source: Unicode Unihan/);
    expect(zh.notes[4].fields.notes).toMatch(/^Also read: de\. /);
    expect(zh.notes[5].fields.meaning).toBe('manifest');
    expect(zh.notes[5].fields.notes).toMatch(/^Source: /);
  });

  it('applies gloss overrides by note key and credits the edit on the card', () => {
    const glossOverrides = {
      'starter-ko-core': {
        'nikl:가다01:verb': { word: '가다', upstream: 'to go; to leave', meaning: 'to go' },
      },
      'starter-zh-common': {
        'unihan:U+7740': {
          word: '着',
          upstream: 'make move, take action',
          meaning: 'continuous-aspect particle (-ing)',
        },
      },
    };
    const [ko, zh] = buildStarterDecks({
      niklText: NIKL,
      unihanReadingsText: UNIHAN_READINGS,
      unihanVariantsText: UNIHAN_VARIANTS,
      lexemes: LEXEMES,
      size: 10,
      glossOverrides,
    });
    expect(ko.notes[0].fields.meaning).toBe('to go');
    expect(ko.notes[0].fields.notes).toMatch(
      /NIKL 한국어 학습용 어휘 목록 \(2003\), KOGL Type 1\. English: Wikidata L20 \(CC0\), edited by this app\.$/,
    );
    // Notes without an override keep the plain source credit.
    expect(ko.notes[1].fields.notes).toMatch(/Wikidata L21 \(CC0\)\.$/);
    const zhe = zh.notes.find((n) => n.key === 'unihan:U+7740');
    expect(zhe.fields.meaning).toBe('continuous-aspect particle (-ing)');
    expect(zhe.fields.notes).toMatch(/Unicode License v3; meaning edited by this app\.$/);
    expect(zh.notes[0].fields.notes).toMatch(/Unicode License v3\.$/);
    // The hash covers the edited notes.
    expect(ko.info.contentHash).not.toBe(build()[0].info.contentHash);
  });

  it('rejects stale, misplaced or unknown gloss overrides', () => {
    const withOverrides = (glossOverrides) => () =>
      buildStarterDecks({
        niklText: NIKL,
        unihanReadingsText: UNIHAN_READINGS,
        unihanVariantsText: UNIHAN_VARIANTS,
        lexemes: LEXEMES,
        size: 10,
        glossOverrides,
      });
    const ko = (key, entry) => withOverrides({ 'starter-ko-core': { [key]: entry } });
    expect(ko('nikl:가다01:verb', { word: '가다', upstream: 'to go', meaning: 'go' })).toThrow(
      'source gloss is now "to go; to leave"',
    );
    expect(
      ko('nikl:가다01:verb', { word: '오다', upstream: 'to go; to leave', meaning: 'go' }),
    ).toThrow('written for "오다"');
    expect(
      ko('nikl:가다01:verb', {
        word: '가다',
        upstream: 'to go; to leave',
        meaning: 'to go; to leave',
      }),
    ).toThrow('equals the source gloss');
    expect(ko('nikl:없음:noun', { word: '없음', upstream: 'x', meaning: 'y' })).toThrow(
      'not in the deck: nikl:없음:noun',
    );
    expect(withOverrides({ 'starter-xx': {} })).toThrow('unknown decks: starter-xx');
  });

  it('is deterministic: input order never changes the output, and rendering is byte-identical', async () => {
    const a = await renderStarterModules(build());
    const b = await renderStarterModules(build(LEXEMES.toReversed()));
    expect([...b.keys()]).toEqual(['catalog.ts', 'ko-core.ts', 'zh-common.ts']);
    for (const [name, source] of a) expect(b.get(name)).toBe(source);
    expect(a.get('catalog.ts')).toContain("module: 'ko-core'");
    expect(a.get('ko-core.ts')).not.toMatch(/\r/);
  });
});

const cached = existsSync(join(DEFAULT_CACHE_DIR, 'raw', NIKL_VOCAB.file));

describe.skipIf(!cached)('starter decks from the pinned sources in the cache', () => {
  it('rebuild byte-identical to the committed generated modules', async () => {
    const modules = await buildFromCache(DEFAULT_CACHE_DIR);
    for (const [name, source] of modules) {
      expect(readFileSync(join(GENERATED_DIR, name), 'utf8'), name).toBe(source);
    }
  }, 60_000);
});
