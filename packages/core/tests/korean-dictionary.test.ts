import fc from 'fast-check';
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  analyzeKoreanQuery,
  composeHangulSyllable,
  decodePackArchive,
  decomposeHangulSyllable,
  deinflectKorean,
  isChoseongQuery,
  lookupKoreanLemmas,
  materializeDictionaryEntries,
  normalizeEnglishEquivalent,
  planDictionarySearch,
  rankDictionaryResults,
  romanizationToHangul,
  toChoseong,
  toJamoKey,
  type DictionaryEntry,
} from '../src/dictionary/index.ts';

type RawEntry = Omit<DictionaryEntry, 'id' | 'packId' | 'searchTokens'>;

const krdict = (
  headword: string,
  equivalents: string[][],
  extra: Partial<RawEntry> = {},
): RawEntry => ({
  headword,
  readings: [headword],
  meanings: equivalents.map((e) => e.join('; ')),
  senses: equivalents.map((e) => ({ equivalents: e, source: 'krdict' as const })),
  level: 'beginner',
  ...extra,
});

/** Korean reference sample (mirrors the starter fixture's shape). */
const SAMPLE: RawEntry[] = [
  krdict('먹다', [['eat'], ['take']], { pos: ['verb'], readings: ['먹따'], forms: ['먹어'] }),
  krdict('돕다', [['help', 'assist']], { pos: ['verb'] }),
  krdict('듣다', [['hear', 'listen']], { pos: ['verb'] }),
  krdict('모르다', [['not know']], { pos: ['verb'] }),
  krdict('살다', [['live', 'reside']], { pos: ['verb'] }),
  krdict('사다', [['buy']], { pos: ['verb'] }),
  krdict('한국', [['Korea']], { pos: ['noun'], altForms: ['韓國'], origin: '韓國' }),
  krdict('한국어', [['Korean', 'Korean language']], { pos: ['noun'], altForms: ['韓國語'] }),
  krdict('학교', [['school']], { pos: ['noun'], altForms: ['學校'] }),
  krdict('공부', [['study', 'learning']], { pos: ['noun'], altForms: ['工夫'] }),
  krdict('공부하다', [['study']], { pos: ['verb'], altForms: ['工夫'], origin: '工夫하다' }),
  krdict('식사', [['meal']], { pos: ['noun'], altForms: ['食事'] }),
  krdict('춥다', [['cold']], { pos: ['adjective'] }),
  krdict('낫다', [['recover', 'get better']], { pos: ['verb'], level: 'intermediate' }),
  krdict('파랗다', [['blue']], { pos: ['adjective'], level: 'intermediate' }),
  krdict('푸르다', [['blue', 'green']], { pos: ['adjective'], level: 'intermediate' }),
  krdict('하다', [['do']], { pos: ['verb'] }),
  krdict('되다', [['become']], { pos: ['verb'] }),
  krdict('가다', [['go']], { pos: ['verb'] }),
  krdict('보다', [['see', 'look', 'watch']], { pos: ['verb'] }),
  krdict('쓰다', [['write']], { pos: ['verb'] }),
  krdict('바쁘다', [['busy']], { pos: ['adjective'] }),
  krdict('그렇다', [['so', 'like that']], { pos: ['adjective'] }),
  krdict('하얗다', [['white']], { pos: ['adjective'], level: 'intermediate' }),
  krdict('걷다', [['walk']], { pos: ['verb'] }),
  krdict('짓다', [['build', 'make']], { pos: ['verb'], level: 'intermediate' }),
  krdict('부르다', [['sing'], ['call']], { pos: ['verb'] }),
  krdict('마시다', [['drink']], { pos: ['verb'] }),
  // Romanization collisions: English words that are also valid RR of another headword.
  krdict('손', [['hand']], { pos: ['noun'] }),
  krdict('아들', [['son']], { pos: ['noun'] }),
  krdict('만', [['ten thousand']], { pos: ['numeral'] }),
  krdict('남자', [['man', 'male']], { pos: ['noun'] }),
  krdict('고', [['high']], { pos: ['noun'], level: 'advanced' }),
  krdict('도', [['degree']], { pos: ['noun'] }),
  // Nouns for particle / copula stacking.
  krdict('학생', [['student']], { pos: ['noun'] }),
  krdict('친구', [['friend']], { pos: ['noun'] }),
  krdict('선생님', [['teacher']], { pos: ['noun'] }),
];
const HEADWORDS = new Set(SAMPLE.map((e) => e.headword));
const ENTRIES = materializeDictionaryEntries('dict-krdict', SAMPLE);
const top = (query: string): string | undefined =>
  rankDictionaryResults(ENTRIES, query)[0]?.headword;
const lemmasOf = (word: string): string[] =>
  lookupKoreanLemmas(word, (h) => HEADWORDS.has(h)).map((c) => c.lemma);

describe('Phase 10 Hangul utilities', () => {
  it('composes/decomposes syllables and builds 초성 and jamo keys (golden)', () => {
    expect(decomposeHangulSyllable('한')).toEqual({ l: 18, v: 0, t: 4 });
    expect(composeHangulSyllable(18, 0, 4)).toBe('한');
    expect(toChoseong('한국')).toBe('ㅎㄱ');
    expect(toChoseong('한국어')).toBe('ㅎㄱㅇ');
    expect(toChoseong('공부하다')).toBe('ㄱㅂㅎㄷ');
    expect(toJamoKey('한국')).toBe('ㅎㅏㄴㄱㅜㄱ');
    expect(toJamoKey('과')).toBe('ㄱㅗㅏ');
    expect(toJamoKey('닭')).toBe('ㄷㅏㄹㄱ');
    expect(toJamoKey('한ㄱ')).toBe('ㅎㅏㄴㄱ');
    expect(isChoseongQuery('ㅎㄱ')).toBe(true);
    expect(isChoseongQuery('한ㄱ')).toBe(false);
    expect(isChoseongQuery('ㄳ')).toBe(false); // a final cluster is not an initial
  });

  it('every syllable round-trips through decompose/compose (property)', () => {
    expect(() =>
      fc.assert(
        fc.property(fc.integer({ min: 0xac00, max: 0xd7a3 }), (cp) => {
          const ch = String.fromCharCode(cp);
          const p = decomposeHangulSyllable(ch);
          return p !== undefined && composeHangulSyllable(p.l, p.v, p.t) === ch;
        }),
      ),
    ).not.toThrow();
  });

  it('a typed prefix of a word always jamo-prefixes the word (property)', () => {
    const syllable = fc.integer({ min: 0xac00, max: 0xd7a3 }).map((cp) => String.fromCharCode(cp));
    expect(() =>
      fc.assert(
        fc.property(fc.array(syllable, { minLength: 1, maxLength: 5 }), fc.nat(), (chars, n) => {
          const word = chars.join('');
          const key = toJamoKey(word);
          const cut = n % (chars.length + 1);
          // Whole-syllable prefixes and any jamo-level prefix of the key are both prefixes.
          return (
            key.startsWith(toJamoKey(chars.slice(0, cut).join(''))) &&
            key.startsWith(key.slice(0, n % (key.length + 1)))
          );
        }),
      ),
    ).not.toThrow();
  });
});

describe('Phase 10 Korean deinflection (validated against headwords)', () => {
  const GOLDEN: Array<[string, string]> = [
    ['먹었어요', '먹다'],
    ['먹어요', '먹다'],
    ['먹습니다', '먹다'],
    ['먹겠습니다', '먹다'],
    ['먹으면', '먹다'],
    ['먹는', '먹다'],
    ['먹고', '먹다'],
    ['먹어서', '먹다'],
    // ㅂ irregular
    ['도와요', '돕다'],
    ['도왔어요', '돕다'],
    ['추워요', '춥다'],
    ['추운', '춥다'],
    ['추우면', '춥다'],
    // ㄷ irregular
    ['들어요', '듣다'],
    ['들었어요', '듣다'],
    ['들으면', '듣다'],
    ['걸어요', '걷다'],
    // ㅅ irregular
    ['나아요', '낫다'],
    ['나으면', '낫다'],
    ['지어요', '짓다'],
    // ㅎ irregular
    ['파래요', '파랗다'],
    ['파란', '파랗다'],
    ['그래요', '그렇다'],
    ['하얘요', '하얗다'],
    // 르 / 러 irregular
    ['몰라요', '모르다'],
    ['몰랐어요', '모르다'],
    ['불러요', '부르다'],
    ['푸르러요', '푸르다'],
    // ㄹ deletion
    ['사세요', '살다'],
    ['사는', '살다'],
    ['삽니다', '살다'],
    ['살면', '살다'],
    // 하다 / 되다
    ['해요', '하다'],
    ['했어요', '하다'],
    ['합니다', '하다'],
    ['하고', '하다'],
    ['해서', '하다'],
    ['하면', '하다'],
    ['공부해요', '공부하다'],
    ['공부했어요', '공부하다'],
    ['돼요', '되다'],
    ['됐어요', '되다'],
    // vowel contraction, ㅡ elision, honorific 시
    ['가요', '가다'],
    ['갔어요', '가다'],
    ['가셨어요', '가다'],
    ['가세요', '가다'],
    ['봐요', '보다'],
    ['써요', '쓰다'],
    ['바빠요', '바쁘다'],
    ['마셔요', '마시다'],
    // nouns with particles / copula
    ['한국어를', '한국어'],
    ['학교에서', '학교'],
    ['한국이에요', '한국'],
    // stacked particles and inflected copula
    ['학교에서도', '학교'],
    ['한국에서는', '한국'],
    ['친구가요', '친구'],
    ['학생이었어요', '학생'],
    ['친구였어요', '친구'],
    ['선생님이세요', '선생님'],
    ['학생입니다', '학생'],
    ['친구예요', '친구'],
  ];

  it.each(GOLDEN)('%s → %s', (surface, lemma) => {
    expect(lemmasOf(surface)).toContain(lemma);
  });

  it('ranks the exact lemma first for inflected input', () => {
    expect(top('먹었어요')).toBe('먹다');
    expect(top('도와요')).toBe('돕다');
    expect(top('들어요')).toBe('듣다');
    expect(top('몰라요')).toBe('모르다');
    expect(top('추워요')).toBe('춥다');
    expect(top('공부했어요')).toBe('공부하다');
  });

  it('ranks the bare noun first for stacked particles and copula forms', () => {
    expect(top('학교에서도')).toBe('학교');
    expect(top('한국에서는')).toBe('한국');
    expect(top('학생이었어요')).toBe('학생');
    expect(top('친구였어요')).toBe('친구');
    expect(top('선생님이세요')).toBe('선생님');
  });

  it('keeps the verb lemma above particle-stripped nouns (도와요 → 돕다 before 도)', () => {
    expect(top('도와요')).toBe('돕다');
    // Verb stems are not particle-stripped: 먹었어요 never yields a bare 먹 noun candidate.
    expect(deinflectKorean('먹었어요').map((c) => c.lemma)).not.toContain('먹');
  });

  it('keeps genuine ambiguity: 사는 is both 살다 (live) and 사다 (buy)', () => {
    expect(lemmasOf('사는')).toEqual(expect.arrayContaining(['살다', '사다']));
  });

  it('returns nothing for non-Hangul input and stays bounded', () => {
    expect(deinflectKorean('eat')).toEqual([]);
    expect(deinflectKorean('가셨겠습니다만').length).toBeLessThanOrEqual(200);
  });

  it('regular conjugations of generated consonant stems always deinflect (property)', () => {
    // Consonant-final stems whose final is not ㄷ/ㅂ/ㅅ/ㅎ/ㄹ (no irregular ambiguity needed).
    const stem = fc
      .tuple(
        fc.integer({ min: 0, max: 18 }),
        fc.constantFrom(0, 4, 8, 13, 18, 20),
        fc.constantFrom(1, 4, 16, 21, 22, 23),
      )
      .map(([l, v, t]) => composeHangulSyllable(l, v, t));
    expect(() =>
      fc.assert(
        fc.property(stem, (s) => {
          const lemma = `${s}다`;
          const bright = [0, 8].includes(decomposeHangulSyllable(s)?.v ?? -1);
          const ao = bright ? '아' : '어';
          const forms = [
            `${s}고`,
            `${s}습니다`,
            `${s}${ao}요`,
            `${s}${ao}서`,
            `${s}으면`,
            `${s}${bright ? '았' : '었'}어요`,
          ];
          return forms.every((f) => deinflectKorean(f).some((c) => c.lemma === lemma));
        }),
        { numRuns: 200 },
      ),
    ).not.toThrow();
  });
});

describe('Phase 10 romanization, 초성 and English reverse index', () => {
  it('converts Revised Romanization to Hangul candidates (golden)', () => {
    const hangul = (q: string) => romanizationToHangul(q).map((c) => c.hangul);
    expect(hangul('hanguk')[0]).toBe('한국');
    expect(hangul('hangugeo')).toContain('한국어');
    expect(hangul('meogeosseoyo')).toContain('먹었어요');
    expect(hangul('gongbuhaeyo')[0]).toBe('공부해요');
    expect(hangul('mollayo')[0]).toBe('몰라요');
    expect(hangul('sarang')[0]).toBe('사랑');
    expect(hangul('kimchi')).toContain('김치');
    expect(hangul('han-guk')[0]).toBe('한국');
    expect(hangul('xyz')).toEqual([]);
    expect(hangul('한국')).toEqual([]);
  });

  it('finds lemmas from romanized inflected input', () => {
    expect(top('hanguk')).toBe('한국');
    expect(top('meogeosseoyo')).toBe('먹다');
    expect(top('dowayo')).toBe('돕다');
    expect(top('gongbuhaeyo')).toBe('공부하다');
  });

  it('matches 초성 exactly and by prefix', () => {
    const hits = rankDictionaryResults(ENTRIES, 'ㅎㄱ').map((e) => e.headword);
    expect(hits.slice(0, 2).sort()).toEqual(['학교', '한국']);
    expect(hits).toContain('한국어'); // prefix ㅎㄱㅇ
    expect(top('ㄱㅂㅎㄷ')).toBe('공부하다');
  });

  it('matches half-typed Hangul by jamo prefix', () => {
    expect(rankDictionaryResults(ENTRIES, '한ㄱ').map((e) => e.headword)).toContain('한국');
    expect(rankDictionaryResults(ENTRIES, '공ㅂ').map((e) => e.headword)).toContain('공부');
  });

  it('serves English → Korean lookups from per-sense equivalents (search tokens, golden)', () => {
    expect(normalizeEnglishEquivalent('To eat.')).toBe('eat');
    expect(normalizeEnglishEquivalent('a Book')).toBe('book');
    // The reverse index is the `searchTokens` multiEntry index: every entry is reachable by the
    // normalized English equivalents of its senses.
    const tokensOf = (hw: string) => ENTRIES.find((e) => e.headword === hw)?.searchTokens ?? [];
    expect(tokensOf('먹다')).toContain('eat');
    expect(tokensOf('공부')).toContain('study');
    expect(tokensOf('공부하다')).toContain('study');
    expect(tokensOf('한국')).toContain('korea');
    expect(planDictionarySearch('eat').prefixTokens[0]).toBe('eat');
    expect(rankDictionaryResults(ENTRIES, 'blue').map((e) => e.headword)).toEqual(
      expect.arrayContaining(['파랗다', '푸르다']),
    );
    expect(top('eat')).toBe('먹다');
    expect(top('to eat')).toBe('먹다');
    expect(top('help')).toBe('돕다');
  });

  it('ranks the English translation above an accidental romanization match (golden)', () => {
    const order = (q: string) => rankDictionaryResults(ENTRIES, q).map((e) => e.headword);
    expect(order('son')[0]).toBe('아들');
    expect(order('son')).toContain('손'); // the romanization match is still offered
    expect(order('man')[0]).toBe('남자');
    expect(order('go')[0]).toBe('가다');
    expect(order('hand')[0]).toBe('손');
    // Without an English hit romanization keeps its full weight.
    expect(top('hanguk')).toBe('한국');
    const onlyHand = ENTRIES.filter((e) => e.headword === '손');
    expect(rankDictionaryResults(onlyHand, 'son').map((e) => e.headword)).toEqual(['손']);
  });

  it('keeps Hanja ↔ word lookups working through altForms', () => {
    expect(top('韓國')).toBe('한국');
    expect(rankDictionaryResults(ENTRIES, '工夫').map((e) => e.headword)).toEqual(
      expect.arrayContaining(['공부', '공부하다']),
    );
  });

  it('plans storage lookups: prefix tokens plus validated headword candidates', () => {
    const plan = planDictionarySearch('먹었어요');
    expect(plan.headwordCandidates).toContain('먹다');
    expect(plan.prefixTokens[0]).toBe('먹었어요');
    expect(planDictionarySearch('ㅎㄱ').prefixTokens).toContain('ㅎㄱ');
    expect(planDictionarySearch('eat').prefixTokens[0]).toBe('eat');
    expect(planDictionarySearch('hanguk').headwordCandidates[0]).toBe('한국');
    expect(planDictionarySearch('meogeosseoyo').headwordCandidates).toContain('먹다');
    expect(planDictionarySearch('meogeosseoyo').headwordCandidates.length).toBeLessThanOrEqual(400);
    // ja / zh-Hans queries keep their Phase 6 tokens.
    expect(planDictionarySearch('タベル').prefixTokens).toContain('たべる');
    expect(planDictionarySearch('xuéxí').prefixTokens).toContain('xuexi');
  });

  it('analyzes queries without a module-level cache (pure, same answer every call)', () => {
    const first = analyzeKoreanQuery('먹었어요');
    expect(analyzeKoreanQuery('hanguk').romanized.has('한국')).toBe(true);
    const again = analyzeKoreanQuery(' 먹었어요 ');
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
    expect(again.lemmas.has('먹다')).toBe(true);
  });
});

describe('Phase 10 pack codec (backwards compatible optional fields)', () => {
  const manifest = {
    format_version: 1,
    id: 'dict-krdict',
    kind: 'dictionary',
    name: 'KRDict Test',
    version: '1.0.0',
    language: 'ko',
    description: 'Test',
    license_name: 'CC BY-SA 2.0 KR',
    license_url: 'https://creativecommons.org/licenses/by-sa/2.0/kr/',
    attribution: 'NIKL',
    source_url: 'https://krdict.korean.go.kr/',
  };

  it('decodes word-pack fields and sanitizes untrusted values', () => {
    const payload = {
      manifest,
      entries: [
        {
          headword: '먹다',
          readings: ['먹따'],
          meanings: ['eat'],
          pos: ['verb', 42],
          level: 'beginner',
          origin: '  ',
          homonym: 1,
          forms: ['먹어', ''],
          senses: [
            {
              equivalents: ['eat'],
              definition: 'To take food.',
              definitionNative: ' 음식을 입으로 삼키다. ',
              examples: [{ text: '밥을 먹다.', type: 'phrase' }, { text: '' }, { type: 'x' }],
              relations: [
                { type: 'synonym', word: '드시다' },
                { type: 'antonym', word: '' },
                { type: 'bogus', word: 'x' },
                { type: 'related', word: '식사' },
                { type: 'synonym', word: '드시다' },
                'junk',
              ],
              source: 'krdict',
            },
            { equivalents: [], source: 'evil' },
            'junk',
          ],
        },
        { headword: '한국', readings: [], meanings: ['Korea'], level: 'expert', homonym: -1 },
      ],
    };
    const decoded = decodePackArchive(gzipSync(new TextEncoder().encode(JSON.stringify(payload))));
    if (!('entries' in decoded)) throw new Error('expected dictionary pack');
    expect(decoded.manifest.id).toBe('dict-krdict');
    expect(decoded.entries[0]).toEqual({
      headword: '먹다',
      readings: ['먹따'],
      meanings: ['eat'],
      pos: ['verb'],
      level: 'beginner',
      homonym: 1,
      forms: ['먹어'],
      senses: [
        {
          equivalents: ['eat'],
          definition: 'To take food.',
          definitionNative: '음식을 입으로 삼키다.',
          examples: [{ text: '밥을 먹다.', type: 'phrase' }],
          relations: [
            { type: 'synonym', word: '드시다' },
            { type: 'related', word: '식사' },
          ],
          source: 'krdict',
        },
      ],
    });
    expect(decoded.entries[1]).toEqual({ headword: '한국', readings: [], meanings: ['Korea'] });
  });

  it('decodes Phase 6 packs exactly as before (no new keys appear)', () => {
    const entry = {
      headword: '學',
      altForms: ['学'],
      readings: ['학'],
      eumhun: ['배울 학'],
      meanings: ['learn'],
      strokeCount: 16,
      radical: '子',
      grade: 'Education Hanja',
      frequency: 12,
    };
    const payload = { manifest: { ...manifest, id: 'dict-hanja-unihan' }, entries: [entry] };
    const decoded = decodePackArchive(new TextEncoder().encode(JSON.stringify(payload)));
    if (!('entries' in decoded)) throw new Error('expected dictionary pack');
    expect(decoded.entries).toEqual([entry]);
    // Tokens for non-Korean headwords are unchanged by the Korean additions.
    const [row] = materializeDictionaryEntries('dict-hanja-unihan', decoded.entries);
    expect(row?.searchTokens.some((t) => /[ㄱ-ㆎ]/.test(t))).toBe(false);
  });
});
