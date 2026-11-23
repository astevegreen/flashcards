// Golden tests for the KRDict (NIKL 한국어기초사전) LMF XML parser and the committed starter pack.
// Inline XML follows the "사전 전체 내려받기" export structure; no network, no upstream download.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decodePackArchive,
  parseAndValidatePackCatalog,
} from '../../packages/core/src/dictionary/pack-codec.ts';
import {
  deinflectKorean,
  romanizationToHangul,
} from '../../packages/core/src/dictionary/korean.ts';
import {
  KRDICT_STARTER_EXTRAS,
  KRDICT_STARTER_ROWS,
  markAppWrittenSenses,
  renderKrdictStarterXml,
} from '../packs/krdict-starter.mjs';
import { cleanKrdictOrigin, parseKrdictXml } from '../packs/upstream-parsers.mjs';

const PACKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'web',
  'public',
  'packs',
);

const KRDICT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LexicalResource dtdVersion="16">
<Lexicon>
<feat att="language" val="한국어"/>
<LexicalEntry att="id" val="17405">
  <feat att="homonym_number" val="0"/>
  <feat att="lexicalUnit" val="단어"/>
  <feat att="partOfSpeech" val="명사"/>
  <feat att="origin" val="▽韓國"/>
  <feat att="vocabularyLevel" val="초급"/>
  <Lemma><feat att="writtenForm" val="한국"/></Lemma>
  <WordForm><feat att="type" val="발음"/><feat att="pronunciation" val="한ː국"/></WordForm>
  <Sense att="id" val="1">
    <feat att="definition" val="아시아 대륙 동쪽에 있는 나라."/>
    <Equivalent>
      <feat att="language" val="영어"/>
      <feat att="lemma" val="Korea"/>
      <feat att="definition" val="A country in East Asia."/>
    </Equivalent>
    <Equivalent>
      <feat att="language" val="일본어"/>
      <feat att="lemma" val="かんこく【韓国】"/>
    </Equivalent>
    <SenseExample><feat att="type" val="구"/><feat att="example" val="한국 음식."/></SenseExample>
    <SenseExample><feat att="type" val="대화"/><feat att="example" val="가: 어디에서 왔어요?"/><feat att="example" val="나: 한국에서 왔어요."/></SenseExample>
  </Sense>
</LexicalEntry>
<LexicalEntry att="id" val="20001">
  <feat val="2" att="homonym_number"/>
  <feat att="partOfSpeech" val="동사"/>
  <feat att="vocabularyLevel" val="중급"/>
  <Lemma><feat att="writtenForm" val="낫다"/></Lemma>
  <WordForm><feat att="type" val="발음"/><feat att="pronunciation" val="낟ː따"/></WordForm>
  <WordForm>
    <feat att="type" val="활용"/><feat att="writtenForm" val="나아"/>
    <FormRepresentation><feat att="type" val="발음"/><feat att="pronunciation" val="나아"/></FormRepresentation>
  </WordForm>
  <WordForm><feat att="type" val="활용"/><feat att="writtenForm" val="나으니"/></WordForm>
  <Sense att="id" val="1">
    <feat att="definition" val="병이나 상처가 없어지다."/>
    <Equivalent><feat att="language" val="영어"/><feat att="lemma" val="recover, get better"/><feat att="definition" val="For an illness to go away."/></Equivalent>
    <SenseExample><feat att="type" val="문장"/><feat att="example" val="감기가 다 나았어요."/></SenseExample>
    <SenseRelation><feat att="type" val="유의어"/><feat att="lemma" val="회복하다"/></SenseRelation>
    <SenseRelation><feat att="type" val="반의어"/><feat att="writtenForm" val="앓다"/></SenseRelation>
    <SenseRelation><feat att="type" val="참고어"/><feat att="lemma" val="치료"/></SenseRelation>
    <SenseRelation><feat att="type" val="유의어"/><feat att="lemma" val="회복하다"/></SenseRelation>
    <SenseRelation><feat att="type" val="유의어"/></SenseRelation>
  </Sense>
  <Sense att="id" val="2">
    <feat att="definition" val="영어 대역어가 없는 뜻."/>
  </Sense>
</LexicalEntry>
<LexicalEntry att="id" val="30000">
  <feat att="partOfSpeech" val="명사"/>
  <Lemma><feat att="writtenForm" val="대역어없음"/></Lemma>
  <Sense att="id" val="1"><feat att="definition" val="영어가 없다."/></Sense>
</LexicalEntry>
<LexicalEntry att="id" val="40000">
  <feat att="partOfSpeech" val="품사 없음"/>
  <feat att="origin" val="computer"/>
  <Lemma><feat att="writtenForm" val="컴퓨터 &amp; 기계"/></Lemma>
  <Sense att="id" val="1">
    <Equivalent><feat att="language" val="영어"/><feat att="lemma" val="computer"/></Equivalent>
  </Sense>
</LexicalEntry>
</Lexicon>
</LexicalResource>`;

describe('KRDict LMF parser', () => {
  it('parses senses, English equivalents, POS, level, pronunciation, Hanja and examples (golden)', () => {
    expect(parseKrdictXml(KRDICT_XML)).toEqual([
      {
        headword: '한국',
        altForms: ['韓國'],
        readings: ['한ː국'],
        meanings: ['Korea'],
        pos: ['noun'],
        level: 'beginner',
        origin: '韓國',
        senses: [
          {
            equivalents: ['Korea'],
            definition: 'A country in East Asia.',
            definitionNative: '아시아 대륙 동쪽에 있는 나라.',
            examples: [
              { text: '한국 음식.', type: 'phrase' },
              { text: '가: 어디에서 왔어요? / 나: 한국에서 왔어요.', type: 'dialogue' },
            ],
            source: 'krdict',
          },
        ],
      },
      {
        headword: '낫다',
        readings: ['낟ː따'],
        meanings: ['recover; get better'],
        pos: ['verb'],
        level: 'intermediate',
        homonym: 2,
        forms: ['나아', '나으니'],
        senses: [
          {
            equivalents: ['recover', 'get better'],
            definition: 'For an illness to go away.',
            definitionNative: '병이나 상처가 없어지다.',
            examples: [{ text: '감기가 다 나았어요.', type: 'sentence' }],
            relations: [
              { type: 'synonym', word: '회복하다' },
              { type: 'antonym', word: '앓다' },
              { type: 'related', word: '치료' },
            ],
            source: 'krdict',
          },
        ],
      },
      {
        headword: '컴퓨터 & 기계',
        readings: [],
        meanings: ['computer'],
        origin: 'computer',
        senses: [{ equivalents: ['computer'], source: 'krdict' }],
      },
    ]);
  });

  it('cleans KRDict editorial marks from 원어', () => {
    expect(cleanKrdictOrigin('▽韓國')).toBe('韓國');
    expect(cleanKrdictOrigin('工夫^하다')).toBe('工夫하다');
    expect(cleanKrdictOrigin('')).toBeUndefined();
  });
});

describe('dict-krdict starter fixture', () => {
  const starter = markAppWrittenSenses(parseKrdictXml(renderKrdictStarterXml()));
  const byHeadword = new Map(starter.map((e) => [e.headword, e]));

  it('parses every hand-authored row and includes the reference words', () => {
    expect(starter).toHaveLength(KRDICT_STARTER_ROWS.length);
    expect(starter.length).toBeGreaterThanOrEqual(30);
    expect(starter.length).toBeLessThanOrEqual(60);
    for (const w of ['먹다', '돕다', '듣다', '모르다', '살다', '한국', '공부하다']) {
      expect(byHeadword.has(w)).toBe(true);
    }
    expect(byHeadword.get('한국')?.altForms).toEqual(['韓國']);
    expect(byHeadword.get('공부하다')?.altForms).toEqual(['工夫']);
    expect(byHeadword.get('먹다')).toMatchObject({
      pos: ['verb'],
      level: 'beginner',
      readings: ['먹따'],
    });
    for (const e of starter) {
      expect(e.senses.length).toBeGreaterThan(0);
      expect(e.senses.every((s) => s.equivalents.length > 0)).toBe(true);
    }
  });

  it('badges the hand-written Korean definitions as the app’s own, every other sense as KRDict', () => {
    const appWritten = Object.keys(KRDICT_STARTER_EXTRAS);
    expect(appWritten).toEqual(['먹다', '춥다']);
    for (const e of starter) {
      e.senses.forEach((s, i) => {
        const app = i === 0 && appWritten.includes(e.headword);
        expect(s.source, `${e.headword} sense ${i + 1}`).toBe(app ? 'app' : 'krdict');
        // Only the app-written senses carry the hand-written Korean definition.
        if (!app) expect(s.definitionNative).toBeUndefined();
      });
    }
    expect(byHeadword.get('먹다')?.senses[0]).toMatchObject({
      source: 'app',
      definitionNative: KRDICT_STARTER_EXTRAS.먹다.native,
    });
    expect(() => markAppWrittenSenses([], { 없다: { native: 'x' } })).toThrow('없다');
  });

  it('every starter conjugation deinflects back to its headword', () => {
    for (const e of starter) {
      for (const form of e.forms ?? []) {
        expect(
          deinflectKorean(form).map((c) => c.lemma),
          `${form} → ${e.headword}`,
        ).toContain(e.headword);
      }
    }
  });

  it('every starter headword is reachable from its own romanization', () => {
    expect(romanizationToHangul('hanguk').map((c) => c.hangul)).toContain('한국');
    expect(romanizationToHangul('gongbuhada').map((c) => c.hangul)).toContain('공부하다');
  });

  it('the committed pack matches the fixture and the catalog entry (rebuild with --starter)', () => {
    const bytes = new Uint8Array(readFileSync(join(PACKS_DIR, 'dict-krdict.json.gz')));
    const catalog = parseAndValidatePackCatalog(
      readFileSync(join(PACKS_DIR, 'packs.json'), 'utf8'),
      {
        allowRelativeUrls: true,
      },
    );
    const entry = catalog.packs.find((p) => p.id === 'dict-krdict');
    expect(entry).toMatchObject({ language: 'ko', license_name: 'CC BY-SA 2.0 KR' });
    const decoded = decodePackArchive(bytes, { expectedSha256: entry?.sha256 });
    if (!('entries' in decoded)) throw new Error('expected dictionary pack');
    expect(decoded.manifest.attribution).toContain('National Institute of Korean Language');
    expect(decoded.entries).toEqual(starter);
    expect(entry?.entry_count).toBe(starter.length);
  });
});

describe('KRDict topic categories', () => {
  const xml = (feats) => `<LexicalResource><Lexicon>
<LexicalEntry att="id" val="1">
  <feat att="partOfSpeech" val="동사"/>
  <Lemma><feat att="writtenForm" val="먹다"/></Lemma>
  <Sense att="id" val="1">
    ${feats}
    <Equivalent><feat att="language" val="영어"/><feat att="lemma" val="eat"/></Equivalent>
  </Sense>
</LexicalEntry></Lexicon></LexicalResource>`;

  it('keeps 주제 및 상황 범주 as written and the top level of 의미 범주', () => {
    const [entry] = parseKrdictXml(
      xml(
        '<feat att="subjectCategory" val="음식 주문하기"/><feat att="semanticCategory" val="식생활 &gt; 음식 행위"/>',
      ),
    );
    expect(entry.topics).toEqual(['음식 주문하기', '식생활']);
  });

  it('accepts the Korean attribute labels and skips 없음', () => {
    const [entry] = parseKrdictXml(
      xml('<feat att="의미 범주" val="자연 &gt; 동물"/><feat att="주제 및 상황 범주" val="없음"/>'),
    );
    expect(entry.topics).toEqual(['자연']);
  });

  it('keeps a topic whose name contains a comma whole', () => {
    const [entry] = parseKrdictXml(xml('<feat att="subjectCategory" val="감정, 기분 표현하기"/>'));
    expect(entry.topics).toEqual(['감정, 기분 표현하기']);
  });

  it('leaves topics out when the export has none', () => {
    const [entry] = parseKrdictXml(xml(''));
    expect(entry.topics).toBeUndefined();
  });

  it('gives the starter pack topics and advanced words for browsing', () => {
    const entries = parseKrdictXml(renderKrdictStarterXml());
    expect(entries.find((e) => e.headword === '학교')?.topics).toEqual(['학교생활', '교육']);
    expect(entries.filter((e) => e.level === 'advanced').map((e) => e.headword)).toEqual([
      '정책',
      '꾸준하다',
    ]);
  });
});
