import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { expandAnswerCandidates, matchTypedAnswer } from '../src/study/answer-match.ts';
import {
  hasRichText,
  MAX_RICH_TEXT_DEPTH,
  normalizeTtsText,
  parseCloze,
  parseRichText,
  parseRuby,
  RICH_TEXT_MARKS,
  scanRichTextSpans,
  serializeRichText,
  stripCloze,
  stripRichText,
  stripRuby,
  toggleRichTextMark,
  type RichTextMark,
  type RichTextNode,
} from '../src/index.ts';

describe('rich-text parser golden tests', () => {
  it('parses bold, italic and colour spans', () => {
    expect(parseRichText('The {b:cat} sat')).toEqual([
      { type: 'text', value: 'The ' },
      { type: 'span', mark: 'b', children: [{ type: 'text', value: 'cat' }] },
      { type: 'text', value: ' sat' },
    ]);
    expect(parseRichText('{i:x}{red:y}')).toEqual([
      { type: 'span', mark: 'i', children: [{ type: 'text', value: 'x' }] },
      { type: 'span', mark: 'red', children: [{ type: 'text', value: 'y' }] },
    ]);
  });

  it('recognises every mark in RICH_TEXT_MARKS, and only those', () => {
    for (const mark of RICH_TEXT_MARKS) {
      expect(parseRichText(`{${mark}:x}`)).toEqual([
        { type: 'span', mark, children: [{ type: 'text', value: 'x' }] },
      ]);
    }
    expect(hasRichText('{u:x}{s:x}{yellow:x}{bi:x}')).toBe(false);
  });

  it('nests spans', () => {
    expect(parseRichText('{b:a{blue:b}c}')).toEqual([
      {
        type: 'span',
        mark: 'b',
        children: [
          { type: 'text', value: 'a' },
          { type: 'span', mark: 'blue', children: [{ type: 'text', value: 'b' }] },
          { type: 'text', value: 'c' },
        ],
      },
    ]);
  });

  it('keeps ruby inside a span for the ruby parser', () => {
    expect(stripRichText('{b:日本[にほん]}語')).toBe('日本[にほん]語');
    expect(stripRichText('{red:{今日|きょう}}は')).toBe('{今日|きょう}は');
    expect(parseRuby(stripRichText('{red:{今日|きょう}}は'))).toEqual([
      { type: 'ruby', base: '今日', reading: 'きょう' },
      { type: 'text', value: 'は' },
    ]);
  });

  it('a span inside a cloze is opaque at the top level and parsed with the answer', () => {
    const text = '私{{c1::{b:は}::topic}}学生';
    expect(scanRichTextSpans(text)).toEqual([]);
    expect(hasRichText(text)).toBe(true);
    expect(stripRichText(text)).toBe('私{{c1::は::topic}}学生');
    expect(parseCloze(text)).toEqual([
      { type: 'text', value: '私' },
      { type: 'cloze', index: 1, answer: '{b:は}', hint: 'topic' },
      { type: 'text', value: '学生' },
    ]);
    expect(hasRichText('{b:は}')).toBe(true);
  });

  it('a span around a cloze keeps the cloze', () => {
    const nodes = parseRichText('{b:{{c1::word}}} here');
    expect(nodes[0]).toEqual({
      type: 'span',
      mark: 'b',
      children: [{ type: 'text', value: '{{c1::word}}' }],
    });
  });

  it('leaves malformed or unknown markup as literal text', () => {
    for (const s of [
      '{b:unclosed',
      '{b:}',
      '{bold:x}',
      '{B:x}',
      '{ b:x}',
      'b:x}',
      '{x|y}',
      '{今日|きょう}',
      '{{c1::x}}',
      '}{b:x',
      'word [formal]',
      '{c1:x}',
      '{red :x}',
    ]) {
      expect(parseRichText(s)).toEqual([{ type: 'text', value: s }]);
      expect(stripRichText(s)).toBe(s);
    }
  });

  it('pairs braces like brackets, so stray braces do not swallow spans', () => {
    expect(stripRichText('a { b {b:x}')).toBe('a { b x');
    expect(stripRichText('{b:x} }')).toBe('x }');
    expect(stripRichText('{b:a {今日|きょう} b}')).toBe('a {今日|きょう} b');
  });

  it('stops parsing spans deeper than the nesting limit', () => {
    const deep = (n: number): string => (n === 0 ? 'x' : `{b:${deep(n - 1)}}`);
    expect(scanRichTextSpans(deep(MAX_RICH_TEXT_DEPTH))).toHaveLength(MAX_RICH_TEXT_DEPTH);
    const tooDeep = deep(MAX_RICH_TEXT_DEPTH + 3);
    expect(scanRichTextSpans(tooDeep)).toHaveLength(MAX_RICH_TEXT_DEPTH);
    expect(serializeRichText(parseRichText(tooDeep))).toBe(tooDeep);
  });

  it('returns the same string when there is no markup', () => {
    const s = '日本語[にほんご]を話す';
    expect(stripRichText(s)).toBe(s);
    expect(stripRichText('')).toBe('');
  });
});

describe('answer matching, TTS and stripping ignore rich-text markup', () => {
  it('typed answers match the plain text', () => {
    expect(expandAnswerCandidates('{b:食べる}')).toEqual(['食べる']);
    expect(expandAnswerCandidates('{red:日本[にほん]}')).toEqual(['日本', 'にほん']);
    expect(matchTypedAnswer('cat', '{b:cat}', { lang: 'en' }).correct).toBe(true);
  });

  it('TTS speaks the plain text', () => {
    expect(normalizeTtsText('The {b:{red:cat}} sat')).toBe('The cat sat');
    expect(normalizeTtsText('{b:{{c1::今日[きょう]}}}は')).toBe('今日は');
  });

  it('stripRichText composes with stripCloze and stripRuby in any order', () => {
    const s = '{b:{{c1::{red:学生[がくせい]}::student}}}です';
    expect(stripRuby(stripCloze(stripRichText(s)))).toBe('学生です');
    expect(stripRichText(stripRuby(stripCloze(s)))).toBe('学生です');
  });
});

describe('existing content renders unchanged', () => {
  const OPENER = new RegExp(`\\{(?:${RICH_TEXT_MARKS.join('|')}):`);
  const roots = ['packages/core/src/samples', 'packages/core/src/starters', 'content'];

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...files(p));
      else if (/\.(ts|json|csv|tsv|md|txt)$/.test(name)) out.push(p);
    }
    return out;
  }

  it('no built-in sample, starter or content text contains a span opener', () => {
    const hits = roots
      .flatMap((r) => files(join(fileURLToPath(new URL('../../..', import.meta.url)), r)))
      .filter((p) => OPENER.test(readFileSync(p, 'utf8')));
    expect(hits).toEqual([]);
  });
});

const markArb = fc.constantFrom<RichTextMark>(...RICH_TEXT_MARKS);
/** Text from an alphabet heavy in markup characters, so the parser sees many near-misses. */
const markupishArb = fc.string({
  unit: fc.constantFrom(
    '{',
    '}',
    ':',
    '|',
    '[',
    ']',
    'b',
    'i',
    'red',
    'blue',
    'c1::',
    '{{',
    '}}',
    '日',
    'に',
    ' ',
    '\n',
    'x',
  ),
  maxLength: 40,
});
/** Plain text that cannot contain a brace, so generated trees serialize unambiguously. */
const plainArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'i', ':', '日', '[', ']', '|', ' ', 'red'),
  minLength: 1,
  maxLength: 6,
});

const treeArb: fc.Arbitrary<RichTextNode[]> = fc.letrec<{ nodes: RichTextNode[] }>((tie) => ({
  nodes: fc
    .array(
      fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        plainArb.map((value): RichTextNode => ({ type: 'text', value })),
        fc
          .record({ mark: markArb, children: tie('nodes') })
          .filter((r) => r.children.length > 0)
          .map((r): RichTextNode => ({ type: 'span', mark: r.mark, children: r.children })),
      ),
      { maxLength: 4 },
    )
    .map(mergeText),
})).nodes;

function mergeText(nodes: RichTextNode[]): RichTextNode[] {
  const out: RichTextNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === 'text' && last?.type === 'text') last.value += n.value;
    else out.push(n.type === 'text' ? { ...n } : n);
  }
  return out;
}

function depth(nodes: readonly RichTextNode[]): number {
  let d = 0;
  for (const n of nodes) if (n.type === 'span') d = Math.max(d, 1 + depth(n.children));
  return d;
}

function plain(nodes: readonly RichTextNode[]): string {
  return nodes.map((n) => (n.type === 'text' ? n.value : plain(n.children))).join('');
}

describe('rich-text property tests', () => {
  it('parsing is lossless for any string', () => {
    fc.assert(
      fc.property(fc.oneof(markupishArb, fc.string(), fc.string({ unit: 'grapheme' })), (s) => {
        expect(serializeRichText(parseRichText(s))).toBe(s);
      }),
      { numRuns: 2000 },
    );
  });

  it('parse never throws, never makes empty spans and respects the depth limit', () => {
    fc.assert(
      fc.property(markupishArb, (s) => {
        const nodes = parseRichText(s);
        expect(depth(nodes)).toBeLessThanOrEqual(MAX_RICH_TEXT_DEPTH);
        const walk = (ns: readonly RichTextNode[]): void => {
          for (const n of ns) {
            if (n.type === 'text') expect(n.value.length).toBeGreaterThan(0);
            else {
              expect(n.children.length).toBeGreaterThan(0);
              walk(n.children);
            }
          }
        };
        walk(nodes);
      }),
      { numRuns: 2000 },
    );
  });

  it('generated trees round-trip through serialize and parse', () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        fc.pre(depth(tree) <= MAX_RICH_TEXT_DEPTH);
        expect(parseRichText(serializeRichText(tree))).toEqual(tree);
        expect(stripRichText(serializeRichText(tree))).toBe(plain(tree));
      }),
      { numRuns: 1000 },
    );
  });

  it('text with no span opener is untouched by parse and strip', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!/\{(?:b|i|red|orange|green|blue|purple):/.test(s));
        expect(parseRichText(s)).toEqual(s ? [{ type: 'text', value: s }] : []);
        expect(stripRichText(s)).toBe(s);
      }),
      { numRuns: 1000 },
    );
  });

  it('strip is idempotent', () => {
    fc.assert(
      fc.property(markupishArb, (s) => {
        // Stripping can expose a new span (`{b:{b:x}` -> ...); stripping until stable terminates.
        let cur = s;
        for (let k = 0; k < s.length + 1 && hasRichText(cur); k++) cur = stripRichText(cur);
        expect(stripRichText(cur)).toBe(cur);
      }),
      { numRuns: 1000 },
    );
  });

  it('toggling a mark twice restores the text', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', ' ', '日', 'x', '.'), maxLength: 20 }),
        fc.nat(),
        fc.nat(),
        markArb,
        (text, a, b, mark) => {
          const start = Math.min(a, b) % (text.length + 1);
          const end = Math.min(text.length, start + (Math.max(a, b) % (text.length + 1)));
          const once = toggleRichTextMark(text, start, end, mark);
          if (start === end) return;
          expect(once).not.toBeNull();
          if (!once) return;
          expect(stripRichText(once.text)).toBe(text);
          const twice = toggleRichTextMark(once.text, once.selectionStart, once.selectionEnd, mark);
          expect(twice?.text).toBe(text);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('toggleRichTextMark', () => {
  it('wraps a selection and selects the content', () => {
    expect(toggleRichTextMark('the cat sat', 4, 7, 'b')).toEqual({
      text: 'the {b:cat} sat',
      selectionStart: 7,
      selectionEnd: 10,
    });
  });

  it('inserts an empty span with the caret inside', () => {
    expect(toggleRichTextMark('ab', 1, 1, 'i')).toEqual({
      text: 'a{i:}b',
      selectionStart: 4,
      selectionEnd: 4,
    });
  });

  it('removes a span when its content or the whole span is selected', () => {
    expect(toggleRichTextMark('the {b:cat} sat', 7, 10, 'b')?.text).toBe('the cat sat');
    expect(toggleRichTextMark('the {b:cat} sat', 4, 11, 'b')?.text).toBe('the cat sat');
  });

  it('swaps one colour for another', () => {
    expect(toggleRichTextMark('{red:cat}', 5, 8, 'blue')).toEqual({
      text: '{blue:cat}',
      selectionStart: 6,
      selectionEnd: 9,
    });
  });

  it('wraps a cloze answer, where the span renders with the answer', () => {
    expect(toggleRichTextMark('{{c1::word}}', 6, 10, 'b')?.text).toBe('{{c1::{b:word}}}');
  });

  it('grows a strict ruby base selection over its reading', () => {
    // Bolding 学生 must not orphan [がくせい].
    expect(toggleRichTextMark('私は学生[がくせい]です', 2, 4, 'b')).toEqual({
      text: '私は{b:学生[がくせい]}です',
      selectionStart: 5,
      selectionEnd: 13,
    });
    // Part of the base, or a selection ending in the base, covers the whole group.
    expect(toggleRichTextMark('学生[がくせい]', 1, 2, 'red')?.text).toBe('{red:学生[がくせい]}');
    expect(toggleRichTextMark('私は学生[がくせい]', 0, 3, 'b')?.text).toBe(
      '{b:私は学生[がくせい]}',
    );
    // Toggling the same base again removes the span.
    expect(toggleRichTextMark('私は{b:学生[がくせい]}です', 5, 7, 'b')?.text).toBe(
      '私は学生[がくせい]です',
    );
    // The screen, TTS and matching agree: the ruby stays one group.
    const once = toggleRichTextMark('学生[がくせい]', 0, 2, 'b');
    expect(stripRichText(once?.text ?? '')).toBe('学生[がくせい]');
  });

  it('refuses a selection or caret inside a [reading]', () => {
    expect(toggleRichTextMark('学生[がくせい]', 3, 5, 'b')).toBeNull();
    expect(toggleRichTextMark('学生[がくせい]', 0, 5, 'b')).toBeNull();
    expect(toggleRichTextMark('学生[がくせい]', 4, 4, 'b')).toBeNull();
    expect(toggleRichTextMark('学生[がくせい]', 1, 1, 'b')).toBeNull();
    expect(toggleRichTextMark('word [formal]', 6, 12, 'b')?.text).toBe('word [{b:formal}]');
  });

  it('refuses a caret inside ruby or cloze braces, but not in a cloze answer', () => {
    expect(toggleRichTextMark('{今日|きょう}', 2, 2, 'b')).toBeNull();
    expect(toggleRichTextMark('{{c1::word}}', 3, 3, 'b')).toBeNull();
    expect(toggleRichTextMark('{{c1::word}}', 1, 1, 'b')).toBeNull();
    expect(toggleRichTextMark('{{c1::word}}', 6, 6, 'b')?.text).toBe('{{c1::{b:}word}}');
    expect(toggleRichTextMark('ab', 1, 1, 'b')?.text).toBe('a{b:}b');
  });

  it("refuses a span across a cloze's :: hint separator", () => {
    expect(toggleRichTextMark('{{c1::word::hint}}', 6, 16, 'b')).toBeNull();
    expect(toggleRichTextMark('{{c1::word::hint}}', 12, 16, 'i')?.text).toBe(
      '{{c1::word::{i:hint}}}',
    );
    // A span around the whole cloze is fine.
    expect(toggleRichTextMark('{{c1::word::hint}}', 0, 18, 'b')?.text).toBe(
      '{b:{{c1::word::hint}}}',
    );
  });

  it('removes the innermost matching span, inside cloze answers too', () => {
    expect(toggleRichTextMark('{b:{i:x}}', 6, 7, 'i')?.text).toBe('{b:x}');
    expect(toggleRichTextMark('{b:{i:x}}', 3, 8, 'i')?.text).toBe('{b:x}');
    expect(toggleRichTextMark('{b:{i:x}}', 3, 8, 'b')?.text).toBe('{i:x}');
    expect(toggleRichTextMark('{red:{blue:x}}', 11, 12, 'green')?.text).toBe('{red:{green:x}}');
    expect(toggleRichTextMark('{{c1::{b:word}}}', 9, 13, 'b')?.text).toBe('{{c1::word}}');
  });

  it('refuses a selection that cuts through ruby braces', () => {
    expect(toggleRichTextMark('{今日|きょう}は', 1, 3, 'b')).toBeNull();
    expect(toggleRichTextMark('{今日|きょう}は', 0, 3, 'b')).toBeNull();
  });
});
