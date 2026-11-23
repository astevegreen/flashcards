import { describe, expect, it } from 'vitest';
import {
  buildEntrySearchTokens,
  deinflectJapanese,
  planDictionarySearch,
  rankDictionaryResults,
  type DictionaryEntry,
  type DictionaryPackId,
} from '../src/dictionary/index.ts';

function lemmas(word: string): string[] {
  return [...deinflectJapanese(word).keys()];
}

describe('deinflectJapanese', () => {
  const cases: Array<[string, string]> = [
    ['食べた', '食べる'],
    ['食べて', '食べる'],
    ['食べない', '食べる'],
    ['食べなかった', '食べる'],
    ['食べます', '食べる'],
    ['食べました', '食べる'],
    ['食べません', '食べる'],
    ['食べたい', '食べる'],
    ['食べている', '食べる'],
    ['食べられる', '食べる'],
    ['食べさせられなかった', '食べる'],
    ['食べれば', '食べる'],
    ['飲んだ', '飲む'],
    ['飲みたくなかった', '飲む'],
    ['読んでいます', '読む'],
    ['書いた', '書く'],
    ['泳いで', '泳ぐ'],
    ['話した', '話す'],
    ['買った', '買う'],
    ['待った', '待つ'],
    ['帰った', '帰る'],
    ['死んだ', '死ぬ'],
    ['遊ばない', '遊ぶ'],
    ['行った', '行く'],
    ['来た', '来る'],
    ['勉強した', '勉強する'],
    ['勉強しません', '勉強する'],
    ['たべた', 'たべる'],
    ['大きかった', '大きい'],
    ['高くない', '高い'],
    ['高くなかった', '高い'],
    ['行こう', '行く'],
    ['飲もう', '飲む'],
    ['書ける', '書く'],
    ['書けば', '書く'],
  ];
  it.each(cases)('%s → %s', (inflected, lemma) => {
    expect(lemmas(inflected)).toContain(lemma);
  });

  it('reports fewer steps for a plain past than for a stacked form', () => {
    expect(deinflectJapanese('食べた').get('食べる')).toBe(1);
    expect(deinflectJapanese('食べなかった').get('食べる')).toBe(2);
  });

  it('gives nothing for dictionary forms, katakana, Latin and Hangul', () => {
    expect(deinflectJapanese('パソコン').size).toBe(0);
    expect(deinflectJapanese('eat').size).toBe(0);
    expect(deinflectJapanese('먹었어요').size).toBe(0);
    expect(deinflectJapanese('').size).toBe(0);
    expect(deinflectJapanese('日本').size).toBe(0);
  });

  it('never includes the query itself and stays bounded', () => {
    const out = deinflectJapanese('食べさせられなかったでしょう');
    expect(out.has('食べさせられなかったでしょう')).toBe(false);
    expect(out.size).toBeLessThanOrEqual(80);
  });
});

function entry(
  packId: DictionaryPackId,
  headword: string,
  readings: string[],
  meanings: string[],
): DictionaryEntry {
  const base = { headword, readings, meanings };
  return {
    id: `${packId}:${headword}:${readings[0]}`,
    packId,
    ...base,
    searchTokens: buildEntrySearchTokens(base),
  };
}

describe('Japanese search planning and ranking', () => {
  it('plans the deinflected lemma as a headword candidate and its kana as a prefix token', () => {
    const plan = planDictionarySearch('食べた');
    expect(plan.headwordCandidates).toContain('食べる');
    const kana = planDictionarySearch('たべた');
    expect(kana.headwordCandidates).toContain('たべる');
    expect(kana.prefixTokens).toContain('たべる');
  });

  it('ranks the lemma first for an inflected query', () => {
    const taberu = entry('dict-jmdict', '食べる', ['たべる'], ['to eat']);
    const tabeta = entry('dict-jmdict', '食べ', ['たべ'], ['food']);
    const ranked = rankDictionaryResults([tabeta, taberu], '食べた');
    expect(ranked[0]?.headword).toBe('食べる');
  });

  it('matches the lemma by reading for a kana-only inflected query', () => {
    const taberu = entry('dict-jmdict', '食べる', ['たべる'], ['to eat']);
    const other = entry('dict-jmdict', '種', ['たね'], ['seed']);
    const ranked = rankDictionaryResults([other, taberu], 'たべた');
    expect(ranked[0]?.headword).toBe('食べる');
  });

  it('ranks an earlier exact English gloss above a later one (ja, zh-Hans)', () => {
    const primary = entry('dict-jmdict', '犬', ['いぬ'], ['dog', 'cur']);
    const secondary = entry('dict-jmdict', '野郎', ['やろう'], ['guy', 'bastard', 'dog']);
    const ranked = rankDictionaryResults([secondary, primary], 'dog');
    expect(ranked.map((e) => e.headword)).toEqual(['犬', '野郎']);

    const zhPrimary = entry('dict-cc-cedict', '狗', ['gou3'], ['dog']);
    const zhLater = entry('dict-cc-cedict', '走狗', ['zou3 gou3'], ['lackey', 'running dog']);
    expect(rankDictionaryResults([zhLater, zhPrimary], 'dog')[0]?.headword).toBe('狗');
  });
});
