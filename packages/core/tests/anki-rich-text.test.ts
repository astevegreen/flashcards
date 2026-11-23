import { describe, expect, it } from 'vitest';
import {
  ANKI_RICH_TEXT_COLORS,
  ankiFieldHtml,
  ankiRichTextToHtml,
  AnkiMediaNamer,
  planAnkiCsvExport,
  rubyTextToAnkiHtml,
} from '../src/export/anki/index.ts';
import { planAnkiApkgExport } from '../src/export/anki/apkg.ts';
import { exportCsv } from '../src/import/csv-export.ts';
import { RICH_TEXT_COLORS } from '../src/parsers/rich-text.ts';
import {
  buildAnkiExportState,
  PNG_HASH,
  T0,
  VOCAB_DECK,
  VOCAB_TYPE,
} from './helpers/anki-export-state.ts';

const field = VOCAB_TYPE.fields[0];
if (!field) throw new Error('fixture');
const conv = (text: string) => ankiRichTextToHtml(text, rubyTextToAnkiHtml, field);

describe('Anki rich-text converter', () => {
  it('maps bold and italic', () => {
    expect(conv('{b:word}')).toBe('<b>word</b>');
    expect(conv('a {i:word} b')).toBe('a <i>word</i> b');
  });

  it('maps every colour to its light-theme shade', () => {
    for (const c of RICH_TEXT_COLORS) {
      expect(conv(`{${c}:x}`)).toBe(`<span style="color: ${ANKI_RICH_TEXT_COLORS[c]}">x</span>`);
    }
    expect(ANKI_RICH_TEXT_COLORS).toEqual({
      red: '#dc2626',
      orange: '#c2410c',
      green: '#15803d',
      blue: '#2563eb',
      purple: '#7c3aed',
    });
  });

  it('nests', () => {
    expect(conv('{b:{red:x}{i:y}}')).toBe('<b><span style="color: #dc2626">x</span><i>y</i></b>');
  });

  it('escapes text but never the tags it writes', () => {
    expect(conv('{b:<script>"&"</script>}')).toBe(
      '<b>&lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;</b>',
    );
    expect(conv('{b:a\nb}')).toBe('<b>a<br>b</b>');
    expect(conv('{b:x} <i onclick="y">')).toBe('<b>x</b> &lt;i onclick=&quot;y&quot;&gt;');
  });

  it('keeps ruby as Anki furigana, inside and next to spans', () => {
    expect(conv('{b:日本[にほん]}')).toBe('<b>日本[にほん]</b>');
    expect(conv('{red:{今日|きょう}}')).toBe('<span style="color: #dc2626">今日[きょう]</span>');
    expect(conv('私の{b:日本[にほん]}')).toBe('私の<b>日本[にほん]</b>');
    expect(conv('{b:x} 日本[にほん]')).toBe('<b>x</b>&#32; 日本[にほん]');
    expect(conv('{b:x}日本[にほん]')).toBe('<b>x</b>日本[にほん]');
    expect(conv('日本[にほん]')).toBe('日本[にほん]');
  });

  it('keeps cloze working in both nesting orders', () => {
    expect(conv('{{c1::{b:word}}}')).toBe('{{c1::<b>word</b>}}');
    expect(conv('{b:{{c1::word}}}')).toBe('<b>{{c1::word}}</b>');
    expect(conv('{{c1::a::{b:h}}}')).toBe('{{c1::a::<b>h</b>}}');
    expect(conv('{{c2::{red:a}::hint}}')).toBe(
      '{{c2::<span style="color: #dc2626">a</span>::hint}}',
    );
  });

  it('leaves empty, unclosed, unknown and uppercase spans literal', () => {
    expect(conv('{b:}')).toBe('{b:}');
    expect(conv('{b:open')).toBe('{b:open');
    expect(conv('close}')).toBe('close}');
    expect(conv('{x:word}')).toBe('{x:word}');
    expect(conv('{B:word}')).toBe('{B:word}');
    expect(conv('{b:{i:}}')).toBe('<b>{i:}</b>');
  });

  it('is identical to the plain path for text without markup', () => {
    for (const t of ['', 'plain', '日本[にほん]', 'a<b', '{{c1::x}}', '{日本|にほん}']) {
      expect(conv(t)).toBe(rubyTextToAnkiHtml(t));
    }
  });

  it('keeps media references working', () => {
    const state = buildAnkiExportState();
    const ctx = { media: new AnkiMediaNamer(state), richText: ankiRichTextToHtml };
    const pic = VOCAB_TYPE.fields.find((f) => f.kind === 'image') ?? field;
    expect(ankiFieldHtml(`media:${PNG_HASH}`, pic, ctx)).toBe(`<img src="${PNG_HASH}.png">`);
    expect(ankiFieldHtml('{b:media:x}', field, ctx)).toBe('<b>media:x</b>');
  });
});

describe('rich text in the Anki writers and plain CSV', () => {
  const state = buildAnkiExportState();
  const note = state.notes.get('note-2');
  if (!note) throw new Error('fixture');
  state.notes.set('note-2', {
    ...note,
    fields: { ...note.fields, meaning: '{b:to<day>} {red:今日[きょう]}' },
  });

  it('converts by default in the Anki CSV', () => {
    const plan = planAnkiCsvExport(state, { deckId: VOCAB_DECK, noteIds: ['note-2'] });
    expect(plan.text).toContain(
      ',"<b>to&lt;day&gt;</b> <span style=""color: #dc2626"">今日[きょう]</span>",',
    );
  });

  it('converts by default in the apkg plan', () => {
    const plan = planAnkiApkgExport(state, {
      nowMs: T0,
      deckIds: [VOCAB_DECK],
      noteIds: ['note-2'],
    });
    const table = plan.collection.tables.find((t) => t.name === 'notes');
    const flds = table?.rows[0]?.[table.columns.indexOf('flds')];
    expect(String(flds).split('')[1]).toBe(
      '<b>to&lt;day&gt;</b> <span style="color: #dc2626">今日[きょう]</span>',
    );
  });

  it('keeps markup in plain CSV as typed, and strips it on request', () => {
    const kept = exportCsv(state, { deckId: VOCAB_DECK, noteIds: ['note-2'] }).text;
    expect(kept).toContain('{b:to<day>} {red:今日[きょう]}');
    const stripped = exportCsv(state, {
      deckId: VOCAB_DECK,
      noteIds: ['note-2'],
      stripRichText: true,
    }).text;
    expect(stripped).toContain('to<day> 今日[きょう]');
    expect(stripped).not.toContain('{b:');
  });
});
