import { parseRuby } from '../../parsers/ruby.ts';
import { convertAnkiFuriganaRun, type AnkiFuriganaOutput } from './furigana.ts';

/**
 * Converts an Anki field (HTML) into this app's plain-text + ruby model (§13: no raw HTML).
 * A small single-pass tokenizer, not a regex and not a DOM:
 * - `<br>` and block elements (`div`, `p`, `li`, …) become line breaks;
 * - inline formatting (`b`, `i`, `u`, `span`, `font`, `a`, …) has no plain-text equivalent, so
 *   only its text is kept; every attribute is dropped;
 * - `script`, `style`, `iframe`, `object`, `svg`, … are dropped together with their content;
 * - `<img src>` and `[sound:…]` are collected as media references and removed from the text;
 * - HTML `<ruby>base<rt>reading</rt></ruby>` becomes `{base|reading}`;
 * - entities are decoded and HTML whitespace is collapsed.
 */

export interface AnkiFieldText {
  text: string;
  /** `<img src>` file names, in document order. */
  images: string[];
  /** `[sound:…]` file names, in document order. */
  sounds: string[];
  /** True when script/style/iframe/… content was removed. */
  droppedActiveContent: boolean;
}

export interface AnkiFieldTextOptions {
  /** Convert Anki furigana (`日本語[にほんご]`) to ruby syntax. */
  furigana: boolean;
  /** What converted furigana becomes (default `ruby`; `kana` = reading only, `kanji` = base). */
  furiganaOutput?: AnkiFuriganaOutput;
}

/** Elements dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'applet',
  'noscript',
  'noembed',
  'noframes',
  'template',
  'textarea',
  'select',
  'title',
  'head',
  'svg',
  'math',
  'xmp',
]);

const BLOCK_ELEMENTS = new Set([
  'div',
  'p',
  'li',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'tr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'blockquote',
  'pre',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'section',
  'article',
  'header',
  'footer',
  'figure',
  'figcaption',
]);

const CELL_ELEMENTS = new Set(['td', 'th']);

/** A `Map`, not an object literal, so `&constructor;` / `&__proto__;` never hit inherited keys. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['ensp', ' '],
  ['emsp', ' '],
  ['thinsp', ' '],
  ['shy', ''],
  ['zwnj', '‌'],
  ['zwj', '‍'],
  ['ndash', '–'],
  ['mdash', '—'],
  ['hellip', '…'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['laquo', '«'],
  ['raquo', '»'],
  ['middot', '·'],
  ['bull', '•'],
  ['times', '×'],
  ['divide', '÷'],
  ['deg', '°'],
  ['plusmn', '±'],
  ['copy', '©'],
  ['reg', '®'],
  ['trade', '™'],
  ['hearts', '♥'],
  ['larr', '←'],
  ['rarr', '→'],
  ['uarr', '↑'],
  ['darr', '↓'],
]);

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagNameChar(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 45;
}

function isHtmlSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

const REPLACEMENT_CHAR = String.fromCodePoint(0xfffd);

function isDigitFor(code: number, hex: boolean): boolean {
  if (code >= 48 && code <= 57) return true;
  return hex && ((code >= 65 && code <= 70) || (code >= 97 && code <= 102));
}

function decodeNumericEntity(body: string): string | undefined {
  const hex = body[1] === 'x' || body[1] === 'X';
  const digits = body.slice(hex ? 2 : 1);
  if (digits.length === 0 || digits.length > 8) return undefined;
  for (let i = 0; i < digits.length; i++) {
    if (!isDigitFor(digits.charCodeAt(i), hex)) return undefined;
  }
  const cp = Number.parseInt(digits, hex ? 16 : 10);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return REPLACEMENT_CHAR;
  return String.fromCodePoint(cp);
}

/**
 * Index of the first `;` after `amp`, reusing `semi` while it is still ahead (the next `;` is
 * shared by every `&` before it, which keeps decoding linear). `Number.MAX_SAFE_INTEGER` = none.
 */
function nextSemicolon(text: string, amp: number, semi: number): number {
  if (semi === Number.MAX_SAFE_INTEGER || semi > amp) return semi;
  const found = text.indexOf(';', amp + 1);
  return found === -1 ? Number.MAX_SAFE_INTEGER : found;
}

/** The decoded text of one entity body (between `&` and `;`), or `undefined` if unknown. */
function decodeEntityBody(body: string): string | undefined {
  if (body.startsWith('#')) return decodeNumericEntity(body);
  return NAMED_ENTITIES.get(body);
}

/**
 * Decodes HTML character references (named subset + numeric). Unknown ones stay literal.
 * `mapDecoded`, when given, rewrites each decoded reference (the importer guards ruby syntax).
 */
export function decodeHtmlEntities(text: string, mapDecoded?: (decoded: string) => string): string {
  if (!text.includes('&')) return text;
  let out = '';
  let pos = 0;
  let semi = -1;
  for (let amp = text.indexOf('&'); amp !== -1; amp = text.indexOf('&', pos)) {
    semi = nextSemicolon(text, amp, semi);
    const decoded = semi - amp > 34 ? undefined : decodeEntityBody(text.slice(amp + 1, semi));
    if (decoded === undefined) {
      out += text.slice(pos, amp + 1);
      pos = amp + 1;
    } else {
      out += text.slice(pos, amp) + (mapDecoded ? mapDecoded(decoded) : decoded);
      pos = semi + 1;
    }
  }
  return out + text.slice(pos);
}

function collapseWhitespace(raw: string): string {
  let out = '';
  let pendingSpace = false;
  for (const ch of raw) {
    if (isHtmlSpace(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) out += ' ';
    pendingSpace = false;
    out += ch;
  }
  return pendingSpace ? out + ' ' : out;
}

/** Removes `[sound:…]` tags from `text`, collecting their file names. */
function extractSounds(text: string, sounds: string[]): string {
  if (!text.includes('[sound:')) return text;
  let out = '';
  let pos = 0;
  for (;;) {
    const start = text.indexOf('[sound:', pos);
    if (start === -1) break;
    const end = text.indexOf(']', start + 7);
    if (end === -1) break;
    const name = decodeHtmlEntities(text.slice(start + 7, end)).trim();
    if (name) sounds.push(name);
    out += text.slice(pos, start);
    pos = end + 1;
  }
  return out + text.slice(pos);
}

interface ParsedTag {
  name: string;
  closing: boolean;
  attrs: Map<string, string>;
  end: number;
}

function isAttrNameEnd(ch: string | undefined): boolean {
  return isHtmlSpace(ch) || ch === '=' || ch === '>' || ch === '/';
}

/** Reads one attribute value starting at `pos` (quoted or bare). */
function readAttrValue(html: string, pos: number): { value: string; end: number } {
  const quote = html[pos];
  if (quote === '"' || quote === "'") {
    const close = html.indexOf(quote, pos + 1);
    if (close === -1) return { value: html.slice(pos + 1), end: html.length };
    return { value: html.slice(pos + 1, close), end: close + 1 };
  }
  let end = pos;
  while (end < html.length && !isHtmlSpace(html[end]) && html[end] !== '>') end += 1;
  return { value: html.slice(pos, end), end };
}

/** Parses attributes from `pos` up to the tag's `>`; returns -1 as `end` if there is none. */
function readAttributes(html: string, pos: number): { attrs: Map<string, string>; end: number } {
  const attrs = new Map<string, string>();
  let i = pos;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '>') return { attrs, end: i + 1 };
    if (isHtmlSpace(ch) || ch === '/') {
      i += 1;
      continue;
    }
    let nameEnd = i;
    while (nameEnd < html.length && !isAttrNameEnd(html[nameEnd])) nameEnd += 1;
    const name = html.slice(i, Math.max(nameEnd, i + 1)).toLowerCase();
    i = Math.max(nameEnd, i + 1);
    while (isHtmlSpace(html[i])) i += 1;
    if (html[i] !== '=') {
      attrs.set(name, '');
      continue;
    }
    i += 1;
    while (isHtmlSpace(html[i])) i += 1;
    const { value, end } = readAttrValue(html, i);
    attrs.set(name, value);
    i = end;
  }
  return { attrs, end: -1 };
}

/**
 * Parses a start or end tag at `lt` (`html[lt] === '<'`): `undefined` if `<` does not start a
 * tag, `'eof'` if the tag never ends (then no later `<` can end one either, so the caller keeps
 * the rest as text instead of rescanning it from every `<`).
 */
function parseTag(html: string, lt: number): ParsedTag | 'eof' | undefined {
  const closing = html[lt + 1] === '/';
  const nameStart = lt + (closing ? 2 : 1);
  if (!isAsciiLetter(html.charCodeAt(nameStart))) return undefined;
  let nameEnd = nameStart;
  while (nameEnd < html.length && isTagNameChar(html.charCodeAt(nameEnd))) nameEnd += 1;
  const { attrs, end } = readAttributes(html, nameEnd);
  if (end === -1) return 'eof';
  return { name: html.slice(nameStart, nameEnd).toLowerCase(), closing, attrs, end };
}

/** Index just past the `</name …>` that closes a dropped element, or the end of input. */
function skipElementContent(html: string, name: string, from: number): number {
  let pos = from;
  for (;;) {
    const lt = html.indexOf('</', pos);
    if (lt === -1) return html.length;
    const candidate = html.slice(lt + 2, lt + 2 + name.length).toLowerCase();
    const after = html.charCodeAt(lt + 2 + name.length);
    if (candidate === name && !isTagNameChar(after)) {
      const gt = html.indexOf('>', lt);
      return gt === -1 ? html.length : gt + 1;
    }
    pos = lt + 2;
  }
}

/** Skips `<!-- … -->`, `<!DOCTYPE …>` and `<? … >`; returns -1 if `lt` starts none of them. */
function skipMarkupDeclaration(html: string, lt: number): number {
  if (html.startsWith('<!--', lt)) {
    const end = html.indexOf('-->', lt + 4);
    return end === -1 ? html.length : end + 3;
  }
  const next = html[lt + 1];
  if (next === '!' || next === '?') {
    const end = html.indexOf('>', lt + 2);
    return end === -1 ? html.length : end + 1;
  }
  return -1;
}

/** Accumulates converted output; text runs are flushed at every tag (a furigana boundary). */
class FieldTextBuilder {
  private lines = '';
  private run = '';
  private rubyBase: string | null = null;
  private rtText: string | null = null;
  readonly images: string[] = [];
  readonly sounds: string[] = [];
  droppedActiveContent = false;

  private readonly options: AnkiFieldTextOptions;

  constructor(options: AnkiFieldTextOptions) {
    this.options = options;
  }

  addRaw(raw: string): void {
    this.run += raw;
  }

  /** Ends the current text run (every tag is a run boundary). */
  flush(): void {
    if (!this.run) return;
    const raw = this.run.replace(GUARD_RE, '');
    this.run = '';
    // Sounds and furigana are read before other entities are decoded, as Anki does: an escaped
    // `&#91;abc&#93;` is literal text in Anki, not furigana. `&nbsp;` still ends a ruby base.
    // Decoded ruby syntax characters stay placeholders until `finish` (see `resolveGuarded`).
    const spaced = collapseWhitespace(raw).replace(/&nbsp;|\u00a0/gi, ' ');
    let text = extractSounds(spaced, this.sounds);
    if (this.options.furigana) {
      text = convertAnkiFuriganaRun(text, this.options.furiganaOutput ?? 'ruby');
    }
    this.append(decodeHtmlEntities(text, guardRubySyntax).replaceAll('\u00a0', ' '));
  }

  private append(text: string): void {
    if (this.rtText !== null) this.rtText += text;
    else if (this.rubyBase !== null) this.rubyBase += text;
    else this.lines += text;
  }

  lineBreak(): void {
    this.flush();
    this.append('\n');
  }

  blockBoundary(): void {
    this.flush();
    if (this.rubyBase !== null) return;
    if (this.lines.length > 0 && !this.lines.endsWith('\n')) this.lines += '\n';
  }

  space(): void {
    this.flush();
    this.append(' ');
  }

  rubyTag(name: string, closing: boolean): void {
    this.flush();
    if (name === 'ruby' && !closing) {
      this.endRuby();
      this.rubyBase = '';
    } else if (name === 'ruby') {
      this.endRuby();
    } else if (name === 'rt' && this.rubyBase !== null) {
      this.toggleRt(closing);
    }
  }

  private toggleRt(closing: boolean): void {
    if (!closing) {
      this.rtText = '';
      return;
    }
    this.emitRubyPair();
  }

  private emitRubyPair(): void {
    const base = (this.rubyBase ?? '').trim();
    const reading = (this.rtText ?? '').trim();
    this.rtText = null;
    this.rubyBase = '';
    if (!base) return;
    const safe = !/[{}|[\]\n]/.test(base + reading);
    this.lines += reading && safe ? `{${base}|${reading}}` : base;
  }

  private endRuby(): void {
    if (this.rtText !== null) this.emitRubyPair();
    if (this.rubyBase) this.lines += this.rubyBase;
    this.rubyBase = null;
  }

  finish(): AnkiFieldText {
    this.flush();
    this.endRuby();
    const text = this.lines
      .split('\n')
      .map((line) => line.trim())
      .join('\n');
    return {
      text: resolveGuarded(collapseBlankLines(text).trim()),
      images: this.images,
      sounds: this.sounds,
      droppedActiveContent: this.droppedActiveContent,
    };
  }
}

/**
 * Ruby and cloze syntax characters that came from an entity (`&#91;`, `&#124;`, …). Anki shows
 * them as plain text, but as literal characters here they could form this app's ruby
 * (`漢字&#91;かんじ&#93;` → `漢字[かんじ]`, or `A&#124;B[えーびー]` → `{A|B|えーびー}`). While a
 * field is built they are noncharacters U+FDD0–U+FDD4 (stripped from the input first); `finish`
 * turns them back into the literal characters when that changes no ruby or cloze, and into
 * their fullwidth lookalikes (`［］｛｝｜`) when it would.
 */
const GUARDED_CHARS = ['[', ']', '{', '}', '|'];
const FULLWIDTH_CHARS = ['［', '］', '｛', '｝', '｜'];
const GUARD_BASE = 0xfdd0;
const GUARD_RE = /[﷐-﷔]/g;

function guardRubySyntax(decoded: string): string {
  const i = GUARDED_CHARS.indexOf(decoded);
  return i === -1 ? decoded : String.fromCharCode(GUARD_BASE + i);
}

function unguard(text: string, chars: readonly string[]): string {
  return text.replace(GUARD_RE, (ch) => chars[ch.charCodeAt(0) - GUARD_BASE] ?? '');
}

/** The ruby structure of `text`, with adjacent text segments merged (for comparing). */
function rubyShape(text: string, restore: (s: string) => string): string {
  const out: string[] = [];
  let pending = '';
  for (const seg of parseRuby(text)) {
    if (seg.type === 'text') {
      pending += restore(seg.value);
      continue;
    }
    out.push(`t:${pending}`, `r:${restore(seg.base)}|${restore(seg.reading)}`);
    pending = '';
  }
  out.push(`t:${pending}`);
  return JSON.stringify(out);
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function resolveGuarded(text: string): string {
  if (!/[﷐-﷔]/.test(text)) return text;
  const literal = unguard(text, GUARDED_CHARS);
  const safe = unguard(text, FULLWIDTH_CHARS);
  const sameRuby =
    rubyShape(text, (s) => unguard(s, GUARDED_CHARS)) === rubyShape(literal, (s) => s);
  const sameCloze =
    countOf(literal, '{{') === countOf(safe, '{{') &&
    countOf(literal, '}}') === countOf(safe, '}}');
  return sameRuby && sameCloze ? literal : safe;
}

/** At most one empty line in a row. */
function collapseBlankLines(text: string): string {
  const out: string[] = [];
  let blank = 0;
  for (const line of text.split('\n')) {
    blank = line === '' ? blank + 1 : 0;
    if (blank <= 1) out.push(line);
  }
  return out.join('\n');
}

/** Handles elements skipped with their content; returns where scanning continues, if handled. */
function applyDropOrRp(b: FieldTextBuilder, html: string, tag: ParsedTag): number | undefined {
  const { name, closing } = tag;
  if (DROP_WITH_CONTENT.has(name)) {
    b.flush();
    b.droppedActiveContent = true;
    return closing ? tag.end : skipElementContent(html, name, tag.end);
  }
  if (name === 'rp' && !closing) {
    b.flush();
    return skipElementContent(html, name, tag.end);
  }
  return undefined;
}

/** Line breaks, block and cell boundaries, ruby; every other tag only ends the text run. */
function applyFormattingTag(b: FieldTextBuilder, tag: ParsedTag): void {
  const { name, closing } = tag;
  if (name === 'br') b.lineBreak();
  else if (BLOCK_ELEMENTS.has(name)) b.blockBoundary();
  else if (CELL_ELEMENTS.has(name) && closing) b.space();
  else if (name === 'ruby' || name === 'rt') b.rubyTag(name, closing);
  else b.flush();
}

/** Records an `<img src>` reference (the element itself is never rendered). */
function collectImage(b: FieldTextBuilder, tag: ParsedTag): void {
  if (tag.name !== 'img' || tag.closing) return;
  const src = decodeHtmlEntities(tag.attrs.get('src') ?? '').trim();
  if (src) b.images.push(src);
}

/** Applies one parsed tag to the builder; returns where scanning continues. */
function applyTag(b: FieldTextBuilder, html: string, tag: ParsedTag): number {
  const skipped = applyDropOrRp(b, html, tag);
  if (skipped !== undefined) return skipped;
  applyFormattingTag(b, tag);
  collectImage(b, tag);
  return tag.end;
}

/** Converts one Anki field's HTML into plain text + ruby, collecting media references. */
export function ankiHtmlToText(html: string, options: AnkiFieldTextOptions): AnkiFieldText {
  const b = new FieldTextBuilder(options);
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) {
      b.addRaw(html.slice(pos));
      break;
    }
    b.addRaw(html.slice(pos, lt));
    const declarationEnd = skipMarkupDeclaration(html, lt);
    if (declarationEnd !== -1) {
      b.flush();
      pos = declarationEnd;
      continue;
    }
    const tag = parseTag(html, lt);
    if (tag === 'eof') {
      b.addRaw(html.slice(lt));
      break;
    }
    if (!tag) {
      b.addRaw('<');
      pos = lt + 1;
      continue;
    }
    pos = applyTag(b, html, tag);
  }
  return b.finish();
}
