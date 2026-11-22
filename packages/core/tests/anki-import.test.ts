import { describe, expect, it } from 'vitest';
import {
  ankiEaseToRating,
  ankiHtmlToText,
  AnkiImportError,
  assertZstdWithinLimit,
  convertAnkiFuriganaRun,
  decodeHtmlEntities,
  decodeProtobuf,
  encodeZstdRaw,
  inspectZstdStream,
  normalizeAnkiPackage,
  parseAnkiMediaMap,
  parseAnkiTemplate,
  planApkg,
  type AnkiRawPackage,
} from '../src/import/anki/index.ts';
import { encodeUtf8 } from '../src/ids.ts';
import { unsafeArchivePathReason } from '../src/import/safe-unzip.ts';
import { parseRuby } from '../src/parsers/ruby.ts';

const text = (html: string, furigana = false) => ankiHtmlToText(html, { furigana }).text;

describe('ankiHtmlToText (tokenizer, no raw HTML)', () => {
  it('turns br / div / p / li into line breaks and drops inline formatting', () => {
    expect(text('a<br>b<BR/>c')).toBe('a\nb\nc');
    expect(text('one<div>two</div><div>three</div>')).toBe('one\ntwo\nthree');
    expect(text('<p>Para 1</p><p>Para 2</p>')).toBe('Para 1\nPara 2');
    expect(text('<ul><li>x</li><li>y</li></ul>')).toBe('x\ny');
    expect(text('<b>bold</b> <i>it</i> <u>u</u> <span style="color:red">red</span>')).toBe(
      'bold it u red',
    );
    expect(text('a<br><br><br><br>b')).toBe('a\n\nb');
  });

  it('collapses HTML whitespace and decodes entities', () => {
    expect(text('  many\n\n   spaces\there  ')).toBe('many spaces here');
    expect(text('&lt;tag&gt; &amp; &quot;q&quot; &#39;s&#39; &#x41;&#66; caf&eacute;')).toBe(
      `<tag> & "q" 's' AB caf&eacute;`,
    );
    expect(text('a&nbsp;&nbsp;b')).toBe('a  b');
    // Inherited object keys are not entities (untrusted input must not reach the prototype).
    expect(decodeHtmlEntities('&constructor; &__proto__; &hasOwnProperty; &toString;')).toBe(
      '&constructor; &__proto__; &hasOwnProperty; &toString;',
    );
    expect(decodeHtmlEntities('&#0; &#xD800; &#99999999; &#123456789; &#xZZ; &')).toBe(
      '\uFFFD \uFFFD \uFFFD &#123456789; &#xZZ; &',
    );
  });

  it('drops script, style, iframe, object, svg, template, noscript with their content', () => {
    const out = ankiHtmlToText(
      'A<script>alert(1)</script>B<STYLE>p{}</STYLE>C<iframe src=x>inner</iframe>D<svg><text>t</text></svg>E<template>t</template>F<noscript>n</noscript>G<object>o</object>H',
      { furigana: false },
    );
    expect(out.text).toBe('ABCDEFGH');
    expect(out.droppedActiveContent).toBe(true);
    expect(text('ok<script>never closed <b>x</b>')).toBe('ok');
    expect(text('a<script>x</script >b')).toBe('ab');
    expect(text('a<script>"</scriptx>"</script>b')).toBe('ab');
  });

  it('ignores attributes (event handlers, javascript: URLs) and comments', () => {
    expect(text('<a href="javascript:alert(1)" onclick=\'x()\'>link</a>')).toBe('link');
    expect(text('<div title="a > b">x</div>')).toBe('x');
    expect(text('a<!-- <script>alert(1)</script> -->b<!DOCTYPE html><?xml x?>c')).toBe('abc');
    expect(text('1 < 2 and 3 <4 and <>')).toBe('1 < 2 and 3 <4 and <>');
    expect(text('unterminated <b class="x')).toBe('unterminated <b class="x');
  });

  it('collects <img src> and [sound:] references and removes them from the text', () => {
    const out = ankiHtmlToText(
      '<img src="cat.jpg"> cat <IMG SRC=\'b&amp;w.png\' alt="x">[sound:meow.mp3] [sound:purr.ogg]',
      { furigana: false },
    );
    expect(out.images).toEqual(['cat.jpg', 'b&w.png']);
    expect(out.sounds).toEqual(['meow.mp3', 'purr.ogg']);
    expect(out.text).toBe('cat');
  });

  it('converts HTML <ruby> to explicit ruby syntax and drops <rp>', () => {
    expect(text('<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>です')).toBe(
      '{漢字|かんじ}です',
    );
    expect(text('<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>')).toBe('{漢|かん}{字|じ}');
    expect(text('<ruby>base only</ruby>')).toBe('base only');
  });

  it('stays linear on pathological input (no backtracking)', () => {
    const inputs = [
      '<'.repeat(200_000),
      '<a '.repeat(50_000),
      '&'.repeat(200_000),
      '[sound:'.repeat(30_000),
      '日本['.repeat(50_000),
      ' ['.repeat(100_000),
      '</'.repeat(100_000),
      '<script>' + '</scrip'.repeat(30_000),
    ];
    const start = Date.now();
    for (const input of inputs) {
      ankiHtmlToText(input, { furigana: true });
    }
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe('Anki furigana -> ruby syntax', () => {
  it('uses the leading-space word boundary and drops the delimiter space', () => {
    expect(convertAnkiFuriganaRun('私は 日本語[にほんご]を 勉強[べんきょう]します')).toBe(
      '私は日本語[にほんご]を勉強[べんきょう]します',
    );
    expect(parseRuby(convertAnkiFuriganaRun('私は 日本語[にほんご]'))).toEqual([
      { type: 'text', value: '私は' },
      { type: 'ruby', base: '日本語', reading: 'にほんご' },
    ]);
  });

  it('without a space the base runs from the start of the text (Anki behaviour)', () => {
    expect(convertAnkiFuriganaRun('私は日本語[にほんご]')).toBe('{私は日本語|にほんご}');
    expect(convertAnkiFuriganaRun('食べる[たべる]')).toBe('{食べる|たべる}');
  });

  it('keeps bases separate when the previous text ends in Han (explicit form)', () => {
    expect(convertAnkiFuriganaRun('漢字 日本[にほん]')).toBe('漢字{日本|にほん}');
    expect(parseRuby('漢字{日本|にほん}')).toEqual([
      { type: 'text', value: '漢字' },
      { type: 'ruby', base: '日本', reading: 'にほん' },
    ]);
    expect(convertAnkiFuriganaRun('日本[にほん]語[ご]')).toBe('日本[にほん]語[ご]');
  });

  it('leaves sound tags, empty bases and syntax characters alone', () => {
    expect(convertAnkiFuriganaRun('word [formal]')).toBe('word [formal]');
    expect(convertAnkiFuriganaRun('x[sound:a.mp3]')).toBe('x[sound:a.mp3]');
    expect(convertAnkiFuriganaRun('a|b[c]')).toBe('a|b[c]');
    expect(convertAnkiFuriganaRun('no brackets')).toBe('no brackets');
    expect(convertAnkiFuriganaRun('open[ended')).toBe('open[ended');
  });

  it('treats cloze delimiters as word boundaries', () => {
    expect(convertAnkiFuriganaRun('{{c1::日本[にほん]}}です')).toBe('{{c1::日本[にほん]}}です');
    expect(convertAnkiFuriganaRun('{{c1::答え::東京[とうきょう]}}')).toBe(
      '{{c1::答え::東京[とうきょう]}}',
    );
  });

  it('applies per HTML text run (tags end a base, like Anki)', () => {
    expect(text('<b>私は</b>日本[にほん]', true)).toBe('私は日本[にほん]');
    expect(text(' 日本[にほん]&nbsp;語[ご]', true)).toBe('日本[にほん]語[ご]');
    expect(text('漢字[かんじ]', false)).toBe('漢字[かんじ]');
  });
});

describe('parseAnkiTemplate', () => {
  it('collects fields with filters, FrontSide, type:, tts and conditionals', () => {
    const side = parseAnkiTemplate(
      '{{FrontSide}}<hr id=answer>{{#Notes}}{{furigana:Reading}}{{/Notes}}{{Meaning}}{{ type:Answer }}{{type:cloze:Text}}{{tts ja_JP voices=Apple:Word}}{{Tags}}{{!comment}}{{Meaning}}{{text:kanji:Reading}}',
    );
    expect(side.includesFrontSide).toBe(true);
    expect(side.refs).toEqual([
      { field: 'Reading', filters: ['furigana'] },
      { field: 'Meaning', filters: [] },
    ]);
    expect(side.typed).toEqual(['Answer']);
    expect(side.typedCloze).toEqual(['Text']);
    expect(side.tts).toEqual([{ field: 'Word', lang: 'ja_JP' }]);
    expect(side.conditions).toEqual(['Notes']);
  });

  it('tolerates unterminated markers', () => {
    expect(parseAnkiTemplate('{{Front').refs).toEqual([]);
  });
});

describe('archive planning, media map, protobuf and zstd', () => {
  const files = (names: string[]) => new Map(names.map((n) => [n, new Uint8Array(1)]));

  it('prefers anki21b > anki21 > anki2', () => {
    expect(planApkg(files(['collection.anki2', 'collection.anki21b'])).format).toBe('anki21b');
    expect(planApkg(files(['collection.anki2', 'collection.anki21'])).format).toBe('anki21');
    expect(planApkg(files(['collection.anki2'])).format).toBe('anki2');
    expect(() => planApkg(files(['media']))).toThrow(AnkiImportError);
  });

  it('parses legacy JSON and protobuf media maps', () => {
    expect(parseAnkiMediaMap(encodeUtf8('{"0":"a.png","1":"b.mp3","2":5}'), false)).toEqual([
      { zipEntry: '0', fileName: 'a.png' },
      { zipEntry: '1', fileName: 'b.mp3' },
    ]);
    // entries=1 { name=1 "a.png" }, entries=1 { name=1 "b.mp3" }
    const entry = (name: string) => [0x0a, name.length + 2, 0x0a, name.length, ...encodeUtf8(name)];
    const pb = new Uint8Array([...entry('a.png'), ...entry('b.mp3')]);
    expect(parseAnkiMediaMap(pb, true)).toEqual([
      { zipEntry: '0', fileName: 'a.png' },
      { zipEntry: '1', fileName: 'b.mp3' },
    ]);
    expect(() => parseAnkiMediaMap(encodeUtf8('[1]'), false)).toThrow(AnkiImportError);
    expect(() => parseAnkiMediaMap(new Uint8Array([0x0a, 0x7f]), true)).toThrow(
      /Support older Anki versions/,
    );
  });

  it('protobuf reader rejects truncated input', () => {
    expect(() => decodeProtobuf(new Uint8Array([0x08]))).toThrow();
    expect(() => decodeProtobuf(new Uint8Array([0x0a, 0x05, 0x01]))).toThrow();
    expect(decodeProtobuf(new Uint8Array([0x08, 0x96, 0x01])).get(1)).toEqual([
      { wire: 0, value: 150 },
    ]);
  });

  it('inspects zstd frames: raw round trip, RLE bombs and garbage', () => {
    const data = new Uint8Array(300_000).fill(7);
    const info = inspectZstdStream(encodeZstdRaw(data));
    expect(info.frames).toBe(1);
    expect(info.maxOutputBytes).toBe(300_000);
    const bomb = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58];
    for (let i = 0; i < 10; i++) {
      const bh = (((1 << 21) - 1) << 3) | (1 << 1) | (i === 9 ? 1 : 0);
      bomb.push(bh & 0xff, (bh >> 8) & 0xff, (bh >> 16) & 0xff, 0);
    }
    expect(() => assertZstdWithinLimit(new Uint8Array(bomb), 10 * 1024 * 1024, 'x')).toThrow(
      expect.objectContaining({ code: 'too_large' }),
    );
    expect(() => assertZstdWithinLimit(new Uint8Array([1, 2, 3, 4, 5]), 1000, 'x')).toThrow(
      expect.objectContaining({ code: 'unsupported_format' }),
    );
    // A frame asking for a 2 GiB window is refused before any decoder allocates it.
    const hugeWindow = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xa8, 0x01, 0x00, 0x00]);
    expect(() => assertZstdWithinLimit(hugeWindow, 1024 * 1024, 'x')).toThrow(
      expect.objectContaining({ code: 'too_large' }),
    );
  });

  it('archive path checks reject traversal, absolute, backslash and drive-letter names', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/x', '\\x', 'a\\b', 'C:/x', 'c:x', '', 'a\0b']) {
      expect(unsafeArchivePathReason(bad)).toBeDefined();
    }
    for (const ok of ['collection.anki2', 'media', '0', '12', 'a/b', '..x', 'x..']) {
      expect(unsafeArchivePathReason(ok)).toBeUndefined();
    }
  });
});

describe('ankiEaseToRating', () => {
  it('maps ease 1-4 directly on the v2/v3 schedulers', () => {
    for (const type of [0, 1, 2]) {
      expect([1, 2, 3, 4].map((e) => ankiEaseToRating(e, type, 2))).toEqual([1, 2, 3, 4]);
    }
  });

  it('maps the v1 three-button learning answers (Again/Good/Easy)', () => {
    expect([1, 2, 3, 4].map((e) => ankiEaseToRating(e, 0, 1))).toEqual([1, 3, 4, undefined]);
    expect([1, 2, 3, 4].map((e) => ankiEaseToRating(e, 1, 1))).toEqual([1, 2, 3, 4]);
  });

  it('rejects out-of-range eases', () => {
    expect(ankiEaseToRating(0, 1, 2)).toBeUndefined();
    expect(ankiEaseToRating(5, 1, 2)).toBeUndefined();
    expect(ankiEaseToRating(2.5, 1, 2)).toBeUndefined();
  });
});

describe('normalizeAnkiPackage', () => {
  const rawWith = (tables: AnkiRawPackage['tables']): AnkiRawPackage => ({
    format: 'anki2',
    tables,
    media: [],
    warnings: [],
  });

  it('enforces row caps with a user-facing message', () => {
    const raw = rawWith({
      col: { columns: ['models', 'decks', 'conf'], rows: [['{}', '{}', '{}']] },
      notes: { columns: ['id'], rows: [[1], [2], [3]] },
    });
    expect(() =>
      normalizeAnkiPackage(raw, {
        maxNotes: 2,
        maxCards: 10,
        maxRevlog: 10,
        maxFiles: 1,
        maxCompressedBytes: 1,
        maxSingleFileBytes: 1,
        maxTotalUncompressedBytes: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'too_large' }));
  });

  it('skips malformed model JSON entries instead of trusting them', () => {
    const models = JSON.stringify({
      1: { id: 1, name: 'Good', type: 0, flds: [{ name: 'F', ord: 0 }, 7], tmpls: [null] },
      2: 'not an object',
      3: { name: 'no id' },
    });
    const collection = normalizeAnkiPackage(
      rawWith({
        col: { columns: ['models', 'decks', 'conf'], rows: [[models, '{}', '{"schedVer":1}']] },
        notes: {
          columns: ['id', 'guid', 'mid', 'tags', 'flds'],
          rows: [[5, 'g', 1, ' a  b ', 'x']],
        },
      }),
    );
    expect(collection.models).toEqual([
      { id: '1', name: 'Good', kind: 'standard', fields: [{ name: 'F', ord: 0 }], templates: [] },
    ]);
    expect(collection.schedVer).toBe(1);
    expect(collection.notes[0]?.tags).toEqual(['a', 'b']);
  });

  it('rejects a collection without col / notes and damaged JSON', () => {
    expect(() => normalizeAnkiPackage(rawWith({}))).toThrow(AnkiImportError);
    expect(() =>
      normalizeAnkiPackage(
        rawWith({
          col: { columns: ['models'], rows: [['{broken']] },
          notes: { columns: [], rows: [] },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_collection' }));
  });
});
