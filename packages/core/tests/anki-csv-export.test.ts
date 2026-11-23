import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ankiFieldNames,
  ankiTags,
  planAnkiCsvExport,
  rubyTextToAnkiHtml,
  zipAnkiCsvExport,
} from '../src/export/anki/index.ts';
import { ankiHtmlToText } from '../src/import/anki/html.ts';
import { parseDelimitedText } from '../src/import/csv.ts';
import { decodeUtf8 } from '../src/ids.ts';
import { stripRuby } from '../src/parsers/ruby.ts';
import {
  buildAnkiExportState,
  MP3,
  MP3_HASH,
  PNG,
  PNG_HASH,
  VOCAB_DECK,
  VOCAB_TYPE,
} from './helpers/anki-export-state.ts';

describe('ruby to Anki furigana', () => {
  it.each([
    ['日本語[にほんご]', '日本語[にほんご]'],
    ['私の日本[にほん]', '私の 日本[にほん]'],
    ['{食べる|たべる}', '食べる[たべる]'],
    ['{日本|に|ほん}', '日[に] 本[ほん]'],
    ['學[학]교', '學[학]교'],
    ['{New York|ニューヨーク}', 'New&nbsp;York[ニューヨーク]'],
    ['test[abc] a<b', 'test&#91;abc&#93; a&lt;b'],
    ['a\nb', 'a<br>b'],
  ])('%s -> %s', (input, expected) => {
    expect(rubyTextToAnkiHtml(input)).toBe(expected);
  });

  it('reads back through the Anki importer with the same bases and readings', () => {
    for (const input of [
      '私の日本[にほん]',
      '日本語[にほんご]を{食べる|たべる}',
      '{日本|に|ほん}語',
      '學[학]교',
    ]) {
      const back = ankiHtmlToText(rubyTextToAnkiHtml(input), { furigana: true }).text;
      expect(stripRuby(back)).toBe(stripRuby(input));
      expect(stripRuby(back, 'readings')).toBe(stripRuby(input, 'readings'));
    }
  });
});

describe('Anki tags and field names', () => {
  it('replaces spaces inside tags and keeps the :: hierarchy', () => {
    expect(ankiTags(['jlpt n5', 'grammar::verbs', 'JLPT N5', ' '])).toEqual([
      'jlpt_n5',
      'grammar::verbs',
    ]);
  });

  it('drops characters Anki forbids in field names and keeps names unique', () => {
    expect(ankiFieldNames(VOCAB_TYPE)).toEqual([
      'Word',
      'Meaning',
      'Picture',
      'Audio',
      'Notes extra',
    ]);
    expect(
      ankiFieldNames({
        id: 'x',
        name: 'x',
        fields: [
          { key: 'a', label: '#Front', kind: 'text', lang: 'en' },
          { key: 'b', label: 'front', kind: 'text', lang: 'en' },
          { key: 'c', label: '{}', kind: 'text', lang: 'en' },
        ],
      }),
    ).toEqual(['Front', 'front 2', 'Field 3']);
  });
});

describe('Export for Anki CSV', () => {
  const state = buildAnkiExportState();

  it('writes the Anki file headers, then one row per note', () => {
    const plan = planAnkiCsvExport(state, { deckId: VOCAB_DECK });
    const lines = plan.text.split('\r\n');
    expect(plan.text.startsWith('#separator:Comma\r\n')).toBe(true);
    expect(lines.slice(0, 7)).toEqual([
      '#separator:Comma',
      '#html:true',
      '#columns:GUID,Note type,Deck,Word,Meaning,Picture,Audio,Notes extra,Tags',
      '#guid column:1',
      '#notetype column:2',
      '#deck column:3',
      '#tags column:9',
    ]);
    const parsed = parseDelimitedText(lines.slice(7).join('\n'), { delimiter: ',' });
    const rows = [parsed.headers, ...parsed.rows];
    expect(plan.noteCount).toBe(3);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([
      'note-1',
      'Japanese Vocab',
      'Japanese::Vocab',
      '日本語[にほんご]を 食べる[たべる]',
      'Japanese, &quot;quoted&quot; &lt;b&gt;',
      `<img src="${PNG_HASH}.png">`,
      `[sound:${MP3_HASH}.mp3]`,
      'line one<br>line two',
      'jlpt_n5 grammar::verbs',
    ]);
    // A note imported from Anki gets its original GUID back.
    expect(rows[1]?.[0]).toBe('AbC123guid');
    // The text's own space stays; the second one is the furigana base marker Anki consumes.
    expect(rows[1]?.[3]).toBe('test&#91;abc&#93; &amp;  今日[きょう]');
    // Media the collection doesn't list is left out (and counted).
    expect(rows[2]?.[5]).toBe('');
    expect(plan.unknownMediaCount).toBe(1);
    expect(plan.media.map((m) => m.name).sort()).toEqual(
      [`${MP3_HASH}.mp3`, `${PNG_HASH}.png`].sort(),
    );
  });

  it('honours tab separators, selections and archived notes', () => {
    const tsv = planAnkiCsvExport(state, { deckId: VOCAB_DECK, delimiter: '\t' });
    expect(tsv.text.split('\r\n')[0]).toBe('#separator:Tab');
    expect(tsv.text.split('\r\n')[2]).toBe(
      '#columns:GUID\tNote type\tDeck\tWord\tMeaning\tPicture\tAudio\tNotes extra\tTags',
    );
    expect(planAnkiCsvExport(state, { deckId: VOCAB_DECK, noteIds: ['note-2'] }).noteCount).toBe(1);
    expect(planAnkiCsvExport(state, { deckId: VOCAB_DECK, includeArchived: true }).noteCount).toBe(
      4,
    );
  });

  it('runs text fields through the rich-text hook when one is given', () => {
    const plan = planAnkiCsvExport(state, {
      deckId: VOCAB_DECK,
      noteIds: ['note-2'],
      richText: (text, plain, field) =>
        field.key === 'meaning' ? `<b>${plain(text)}</b>` : plain(text),
    });
    expect(plan.text).toContain('<b>today</b>');
  });

  it('zips the CSV, the media it uses and a README', () => {
    const plan = planAnkiCsvExport(state, { deckId: VOCAB_DECK });
    const result = zipAnkiCsvExport(plan, new Map([[PNG_HASH, PNG]]));
    expect(result.fileName).toBe('japanese-vocab-anki.zip');
    expect(result.mediaCount).toBe(1);
    expect(result.missingMediaCount).toBe(2); // the MP3 bytes + the unlisted image
    const files = unzipSync(result.zip);
    expect(Object.keys(files).sort()).toEqual(
      ['README.txt', 'collection.media/' + `${PNG_HASH}.png`, 'japanese-vocab.csv'].sort(),
    );
    expect(decodeUtf8(files['japanese-vocab.csv'] ?? new Uint8Array())).toBe(plan.text);
    expect(files[`collection.media/${PNG_HASH}.png`]).toEqual(PNG);
    const full = zipAnkiCsvExport(
      plan,
      new Map([
        [PNG_HASH, PNG],
        [MP3_HASH, MP3],
      ]),
    );
    expect(full.mediaCount).toBe(2);
  });
});
