import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodePackArchive,
  materializeDictionaryEntries,
  OPEN_DATA_ATTRIBUTIONS,
} from '../../packages/core/src/dictionary/index.ts';
import {
  parseKaikkiKoJsonl,
  parseUrimalsamJson,
  parseUrimalsamXml,
} from '../packs/upstream-parsers.mjs';

const attributionFor = (packId) => OPEN_DATA_ATTRIBUTIONS.find((a) => a.packId === packId);

describe('Urimalsaem (우리말샘) & Kaikki Korean parsers', () => {
  it('parses Urimalsaem JSON into dict-urimalsam entries and round-trips through pack codec', () => {
    const sample = JSON.stringify({
      channel: {
        item: [
          {
            target_code: '100',
            wordinfo: {
              word: '학-교',
              homonym_number: '1',
              original_language_info: [{ original_language: '學校' }],
              pronunciation_info: [{ pronunciation: '학꾜' }],
            },
            senseinfo: {
              pos: '명사',
              definition: '일정한 목적과 설비를 갖추고 학생을 가르치는 기관.',
              example_info: [{ example: '학교에 다니다.' }],
              relation_info: [{ type: '유의어', word: '학-원' }],
              cat_info: [{ cat: '교육' }],
            },
          },
          {
            target_code: '101',
            wordinfo: {
              word: '학-교',
              homonym_number: '1',
            },
            senseinfo: {
              pos: '명사',
              definition: '배움의 터전을 비유적으로 이르는 말.',
            },
          },
        ],
      },
    });

    const parsed = parseUrimalsamJson(sample);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      headword: '학교',
      altForms: ['學校'],
      readings: ['학꾜'],
      pos: ['noun'],
      origin: '學校',
      homonym: 1,
      topics: ['교육'],
    });
    expect(parsed[0].senses).toHaveLength(2);
    expect(parsed[0].senses[0]).toMatchObject({
      source: 'urimalsam',
      definitionNative: '일정한 목적과 설비를 갖추고 학생을 가르치는 기관.',
      examples: [{ text: '학교에 다니다.' }],
      relations: [{ type: 'synonym', word: '학원' }],
    });

    const attr = attributionFor('dict-urimalsam');
    expect(attr?.licenseName).toBe('CC BY-SA 2.0 KR');
    const archive = new Uint8Array(
      gzipSync(
        JSON.stringify({
          manifest: {
            format_version: 1,
            id: 'dict-urimalsam',
            kind: 'dictionary',
            name: attr.name,
            version: 'test-1',
            language: 'ko',
            description: attr.scope,
            license_name: attr.licenseName,
            license_url: attr.licenseUrl,
            attribution: attr.attribution,
            source_url: attr.sourceUrl,
          },
          entries: parsed,
        }),
      ),
    );
    const decoded = decodePackArchive(archive);
    expect(decoded.manifest.id).toBe('dict-urimalsam');
    const rows = materializeDictionaryEntries('dict-urimalsam', decoded.entries);
    expect(rows[0]?.headword).toBe('학교');
    expect(rows[0]?.senses?.[0]?.source).toBe('urimalsam');
  });

  it('parses Urimalsaem XML items', () => {
    const xml = `
      <channel>
        <item>
          <word>누리-집</word>
          <pos>명사</pos>
          <pronunciation>누리집</pronunciation>
          <definition>웹사이트를 다듬어 이르는 말.</definition>
          <example>기관 누리집을 방문하다.</example>
          <cat>정보·통신</cat>
        </item>
      </channel>
    `;
    const parsed = parseUrimalsamXml(xml);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      headword: '누리집',
      readings: ['누리집'],
      pos: ['noun'],
      topics: ['정보·통신'],
    });
    expect(parsed[0].senses[0]?.source).toBe('urimalsam');
  });

  it('parses Kaikki Korean Wiktionary JSONL and skips non-Korean / malformed lines', () => {
    const jsonl = [
      'not json',
      JSON.stringify({
        lang_code: 'ja',
        word: '食べる',
        pos: 'verb',
        senses: [{ glosses: ['to eat'] }],
      }),
      JSON.stringify({
        lang_code: 'ko',
        word: '먹다',
        pos: 'verb',
        sounds: [{ hangeul: '[먹따]' }],
        senses: [
          {
            glosses: ['to eat; to consume'],
            examples: [{ text: '밥을 먹다.', english: 'to eat rice.' }],
            antonyms: [{ word: '굶다' }],
          },
        ],
      }),
      JSON.stringify({
        lang_code: 'ko',
        word: '한국',
        pos: 'name',
        forms: [{ form: '韓國', tags: ['hanja'] }],
        sounds: [{ phonetic_hangeul: '한국' }],
        senses: [{ glosses: ['South Korea', 'Korea'] }],
      }),
    ].join('\n');

    const parsed = parseKaikkiKoJsonl(jsonl);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      headword: '먹다',
      pos: ['verb'],
      readings: ['먹따'],
    });
    expect(parsed[0].senses[0]).toMatchObject({
      source: 'kaikki',
      equivalents: ['to eat', 'to consume'],
      examples: [{ text: '밥을 먹다.', translation: 'to eat rice.' }],
      relations: [{ type: 'antonym', word: '굶다' }],
    });
    expect(parsed[1]).toMatchObject({
      headword: '한국',
      altForms: ['韓國'],
      pos: ['noun'],
    });

    const attr = attributionFor('dict-kaikki-ko');
    expect(attr?.licenseName).toBe('CC BY-SA 4.0');
  });
});
