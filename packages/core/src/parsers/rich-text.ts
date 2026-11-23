/**
 * Pure, zero-dependency limited rich-text parser for note fields (bold, italic, a fixed colour
 * palette). Never produces HTML strings; the UI renders React elements from these nodes (§13).
 *
 * Syntax: `{mark:content}` where `mark` is exactly one of {@link RICH_TEXT_MARKS}:
 * - `{b:word}` bold, `{i:word}` italic;
 * - `{red:word}`, `{orange:word}`, `{green:word}`, `{blue:word}`, `{purple:word}` colour.
 *
 * Rules (strict; anything else stays literal text):
 * 1. Braces are paired like brackets over the whole string. An unpaired `{` or `}` is plain text.
 * 2. A pair is a span only when it opens with a known mark and `:`, its content is non-empty, and
 *    every pair around it is a span too. Inside any other pair (ruby `{base|reading}`, cloze
 *    `{{c1::...}}`) the text is opaque here and parsed again when that part is rendered, so
 *    `{{c1::{b:word}}}` keeps its cloze and the answer renders bold.
 * 3. Spans nest (`{b:{red:word}}`) up to {@link MAX_RICH_TEXT_DEPTH}; deeper ones stay literal.
 * 4. Parsing is lossless: `serializeRichText(parseRichText(s)) === s` for every string.
 *
 * Ruby (`漢字[かんじ]`, `{base|reading}`) and cloze keep working inside spans:
 * `{b:日本[にほん]}`, `{red:{今日|きょう}}`, `{b:{{c1::word}}}`.
 */

export const RICH_TEXT_COLORS = ['red', 'orange', 'green', 'blue', 'purple'] as const;
export type RichTextColor = (typeof RICH_TEXT_COLORS)[number];

export const RICH_TEXT_MARKS = ['b', 'i', ...RICH_TEXT_COLORS] as const;
export type RichTextMark = (typeof RICH_TEXT_MARKS)[number];

/** Deepest span nesting that is parsed; a deeper span stays literal text. */
export const MAX_RICH_TEXT_DEPTH = 8;

export type RichTextNode =
  { type: 'text'; value: string } | { type: 'span'; mark: RichTextMark; children: RichTextNode[] };

/** A span's position: `open` is its `{`, `contentStart` follows the `:`, `close` is its `}`. */
export interface RichTextSpanRange {
  mark: RichTextMark;
  open: number;
  contentStart: number;
  close: number;
}

const OPENER = /\{(b|i|red|orange|green|blue|purple):/y;
const ANY_OPENER = /\{(?:b|i|red|orange|green|blue|purple):/;

function markAt(input: string, i: number): RichTextMark | null {
  OPENER.lastIndex = i;
  return (OPENER.exec(input)?.[1] as RichTextMark | undefined) ?? null;
}

/** Cheap check before the full scan: does the string contain any `{mark:` opener at all? */
const mayHaveSpan = (input: string): boolean => ANY_OPENER.test(input);

export interface ScanRichTextOptions {
  /**
   * Also find spans inside cloze answers and hints (`{{c1::{b:word}}}`), as if the cloze braces
   * were not there. Rendering leaves this off and parses each answer again; stripping turns it
   * on so every span that can ever render is removed.
   */
  throughCloze?: boolean;
}

const CLOZE_HEADER = /^c[1-9][0-9]?::/i;

/** Lists every span in document order (outer before inner), per the rules above. */
export function scanRichTextSpans(input: string, opts?: ScanRichTextOptions): RichTextSpanRange[] {
  if (!input || !mayHaveSpan(input)) return [];

  // 1. Pair braces like brackets.
  const closeOf = new Map<number, number>();
  const openStack: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '{') openStack.push(i);
    else if (ch === '}') {
      const open = openStack.pop();
      if (open !== undefined) closeOf.set(open, i);
    }
  }

  // 2. Walk the pairs; a pair is a span only when every pair around it is a span.
  const spans: RichTextSpanRange[] = [];
  const pending: { close: number; kind: 'span' | 'opaque' | 'clear' }[] = [];
  let opaque = 0;
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '{') {
      const close = closeOf.get(i);
      if (close === undefined) continue;
      const mark = opaque === 0 && depth < MAX_RICH_TEXT_DEPTH ? markAt(input, i) : null;
      const contentStart = mark ? i + mark.length + 2 : -1;
      if (mark && close > contentStart) {
        spans.push({ mark, open: i, contentStart, close });
        pending.push({ close, kind: 'span' });
        depth += 1;
      } else if (
        opts?.throughCloze &&
        input[i + 1] === '{' &&
        closeOf.get(i + 1) === close - 1 &&
        CLOZE_HEADER.test(input.slice(i + 2, i + 8))
      ) {
        // Both braces of `{{cN::...}}` stay transparent.
        pending.push({ close, kind: 'clear' }, { close: close - 1, kind: 'clear' });
        i += 1;
      } else {
        pending.push({ close, kind: 'opaque' });
        opaque += 1;
      }
    } else if (ch === '}') {
      const top = pending[pending.length - 1];
      if (top && top.close === i) {
        pending.pop();
        if (top.kind === 'span') depth -= 1;
        else if (top.kind === 'opaque') opaque -= 1;
      }
    }
  }
  return spans;
}

function pushText(nodes: RichTextNode[], value: string): void {
  if (!value) return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === 'text') last.value += value;
  else nodes.push({ type: 'text', value });
}

/** Parses field text into text and span nodes. Text without any span is one text node. */
export function parseRichText(input: string, opts?: ScanRichTextOptions): RichTextNode[] {
  if (!input) return [];
  const spans = scanRichTextSpans(input, opts);
  if (spans.length === 0) return [{ type: 'text', value: input }];

  let next = 0;
  const build = (from: number, to: number): RichTextNode[] => {
    const nodes: RichTextNode[] = [];
    let cursor = from;
    while (next < spans.length) {
      const span = spans[next];
      if (!span || span.open >= to) break;
      next += 1;
      pushText(nodes, input.slice(cursor, span.open));
      nodes.push({
        type: 'span',
        mark: span.mark,
        children: build(span.contentStart, span.close),
      });
      cursor = span.close + 1;
    }
    pushText(nodes, input.slice(cursor, to));
    return nodes;
  };
  return build(0, input.length);
}

/** Writes nodes back to markup; the inverse of {@link parseRichText}. */
export function serializeRichText(nodes: readonly RichTextNode[]): string {
  let out = '';
  for (const node of nodes) {
    out += node.type === 'text' ? node.value : `{${node.mark}:${serializeRichText(node.children)}}`;
  }
  return out;
}

/**
 * Removes bold, italic and colour markup, including inside cloze answers and hints, and keeps
 * everything else, ruby and cloze markup too (`{b:日本[にほん]}` -> `日本[にほん]`,
 * `{{c1::{b:word}}}` -> `{{c1::word}}`). Pure; for answer matching, TTS, search, dedupe and
 * exports. Text without markup is returned unchanged (same string).
 */
export function stripRichText(input: string): string {
  const spans = scanRichTextSpans(input, { throughCloze: true });
  if (spans.length === 0) return input;
  const drop = new Set<number>();
  for (const s of spans) {
    for (let i = s.open; i < s.contentStart; i++) drop.add(i);
    drop.add(s.close);
  }
  let out = '';
  for (let i = 0; i < input.length; i++) if (!drop.has(i)) out += input[i];
  return out;
}

/** True when the text holds at least one bold, italic or colour span, cloze answers included. */
export function hasRichText(input: string): boolean {
  return scanRichTextSpans(input, { throughCloze: true }).length > 0;
}
