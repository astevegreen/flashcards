import { isStrictHttpsUrl } from '@flash/content-schema';
import type { CollectionState, EventFactory } from '../events/replay.ts';
import type { KnownEvent } from '../events/types.ts';
import { FLASH_NAMESPACE_UUID, uuidv5 } from '../ids.ts';
import type { SourceRef } from '../model/types.ts';
import { computePageContentHash } from './content-hash.ts';
import { isSafeRelativeMediaPath } from './tabular.ts';

export type PageWarningCode = 'raw_html_stripped' | 'unsafe_url_stripped';

export interface PageNormalizeWarning {
  code: PageWarningCode;
  message: string;
}

export class PageSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageSecurityError';
  }
}

export interface ParsedFrontmatter {
  id?: string;
  title?: string;
  slug?: string;
  lang?: string;
  tags: string[];
  body: string;
}

function unquoteYamlScalar(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Lightweight, zero-dependency YAML-subset frontmatter parser for Markdown Pages.
 */
export function parseMarkdownFrontmatter(raw: string): ParsedFrontmatter {
  const input = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(input);
  if (!match) {
    return { tags: [], body: input };
  }

  const yamlBlock = match[1] ?? '';
  const body = input.slice(match[0].length);
  let id: string | undefined;
  let title: string | undefined;
  let slug: string | undefined;
  let lang: string | undefined;
  const tags: string[] = [];

  const lines = yamlBlock.split(/\r?\n/);
  let readingTagList = false;

  for (const line of lines) {
    if (readingTagList) {
      const itemMatch = /^\s*-\s+(.+)$/.exec(line);
      if (itemMatch) {
        const val = unquoteYamlScalar(itemMatch[1] ?? '');
        if (val) tags.push(val);
        continue;
      }
      readingTagList = false;
    }

    const kvMatch = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kvMatch) continue;
    const key = (kvMatch[1] ?? '').toLowerCase();
    const rawVal = (kvMatch[2] ?? '').trim();

    if (key === 'id' && rawVal) {
      id = unquoteYamlScalar(rawVal);
    } else if (key === 'title' && rawVal) {
      title = unquoteYamlScalar(rawVal);
    } else if (key === 'slug' && rawVal) {
      slug = unquoteYamlScalar(rawVal);
    } else if (key === 'lang' && rawVal) {
      lang = unquoteYamlScalar(rawVal);
    } else if (key === 'tags') {
      if (!rawVal) {
        readingTagList = true;
      } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        const inner = rawVal.slice(1, -1);
        for (const part of inner.split(',')) {
          const v = unquoteYamlScalar(part);
          if (v) tags.push(v);
        }
      } else {
        for (const part of rawVal.split(/[;,]/)) {
          const v = unquoteYamlScalar(part);
          if (v) tags.push(v);
        }
      }
    }
  }

  return {
    ...(id !== undefined ? { id } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(lang !== undefined ? { lang } : {}),
    tags,
    body,
  };
}

export interface SanitizeMarkdownOptions {
  mode?: 'strip' | 'reject';
  allowRelativeMediaPaths?: boolean;
  mediaPathMap?: Readonly<Record<string, string>>;
}

export interface SanitizeMarkdownResult {
  markdown: string;
  warnings: PageNormalizeWarning[];
  referencedRelativeMediaPaths: string[];
}

type TextRange = readonly [start: number, end: number];

/** Removes sorted, non-overlapping ranges from `text`. */
function cutRanges(text: string, ranges: readonly TextRange[]): string {
  let out = '';
  let copied = 0;
  for (const [start, end] of ranges) {
    out += text.slice(copied, start);
    copied = end;
  }
  return out + text.slice(copied);
}

const DANGEROUS_BLOCK_NAMES = ['script', 'style', 'iframe', 'object', 'embed', 'svg'] as const;
const DANGEROUS_CLOSE_RES = new Map<string, RegExp>(
  DANGEROUS_BLOCK_NAMES.map((name) => [name, new RegExp(String.raw`<\s*\/\s*${name}\s*>`, 'gi')]),
);

/**
 * Finds the matches of `/<\s*(script|…)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi` in linear time. Once a
 * tag name has no closing tag after some point, no later opening tag of that name has one either.
 */
function findDangerousBlocks(text: string): TextRange[] {
  const openRe = new RegExp(String.raw`<\s*(${DANGEROUS_BLOCK_NAMES.join('|')})\b`, 'gi');
  const ranges: TextRange[] = [];
  const unclosed = new Set<string>();
  let nextGt = -2;
  for (let open = openRe.exec(text); open !== null; open = openRe.exec(text)) {
    const name = (open[1] ?? '').toLowerCase();
    const closeRe = DANGEROUS_CLOSE_RES.get(name);
    if (closeRe === undefined || unclosed.has(name)) continue;
    if (nextGt !== -1 && nextGt < openRe.lastIndex) nextGt = text.indexOf('>', openRe.lastIndex);
    if (nextGt === -1) break;
    closeRe.lastIndex = nextGt + 1;
    if (closeRe.exec(text) === null) {
      unclosed.add(name);
      continue;
    }
    ranges.push([open.index, closeRe.lastIndex]);
    openRe.lastIndex = closeRe.lastIndex;
  }
  return ranges;
}

/** Finds the matches of `/<!--[\s\S]*?-->/g` in linear time. */
function findHtmlComments(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let pos = 0;
  for (;;) {
    const start = text.indexOf('<!--', pos);
    if (start < 0) break;
    const end = text.indexOf('-->', start + 4);
    if (end < 0) break;
    ranges.push([start, end + 3]);
    pos = end + 3;
  }
  return ranges;
}

/**
 * Replaces the matches of `/(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g` in linear time.
 * Every `[` before the same `]` gives the same result, and so does every target that ends at the
 * same place, so a failed attempt is never rescanned.
 */
function replaceMarkdownLinks(
  text: string,
  rewrite: (pre: string, target: string, post: string) => string,
): string {
  const targetEndRe = /[)\s]/g;
  const titleRe = /\s+"[^"]*"\)/y;
  let out = '';
  let copied = 0;
  let pos = 0;
  let failedTargetEnd = -1;
  for (;;) {
    const open = text.indexOf('[', pos);
    if (open < 0) break;
    const close = text.indexOf(']', open + 1);
    if (close < 0) break;
    pos = close + 1;
    const targetStart = close + 2;
    if (text[close + 1] !== '(' || targetStart <= failedTargetEnd) continue;
    targetEndRe.lastIndex = targetStart;
    const targetEnd = targetEndRe.exec(text)?.index ?? text.length;
    if (targetEnd === targetStart) continue;
    let end = -1;
    if (text[targetEnd] === ')') {
      end = targetEnd + 1;
    } else if (targetEnd < text.length) {
      titleRe.lastIndex = targetEnd;
      if (titleRe.test(text)) end = titleRe.lastIndex;
    }
    if (end < 0) {
      failedTargetEnd = targetEnd;
      continue;
    }
    const start = open > copied && text[open - 1] === '!' ? open - 1 : open;
    out +=
      text.slice(copied, start) +
      rewrite(
        text.slice(start, targetStart),
        text.slice(targetStart, targetEnd),
        text.slice(targetEnd, end),
      );
    copied = end;
    pos = end;
  }
  return out + text.slice(copied);
}

/** Index of the last entry of ascending `sorted` that is below `limit`, or -1. */
function lastIndexBelow(sorted: readonly number[], limit: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? limit) < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Replaces the matches of `/(::image\[[^\]]*\]\{[^}]*\bsrc=)(?:"([^"]+)"|'([^']+)'|([^\s}]+))/g`
 * in linear time. Like the regex, it takes the last `src=` before the `}` that has a value.
 */
function replaceImageDirectiveSrcs(
  text: string,
  rewrite: (pre: string, src: string) => string,
): string {
  // A `src=` has a value unless whitespace, `}` or the end of the text follows it.
  const srcStarts: number[] = [];
  for (const m of text.matchAll(/\bsrc=/g)) {
    const next = text[m.index + 4];
    if (next !== undefined && next !== '}' && !/\s/.test(next)) srcStarts.push(m.index);
  }
  // Each scan below only moves forward, so a result found earlier stays valid until passed.
  const nextFrom = new Map<string, number>();
  const nextIndexOf = (char: string, from: number): number => {
    const known = nextFrom.get(char);
    if (known === -1 || (known !== undefined && known >= from)) return known;
    const found = text.indexOf(char, from);
    nextFrom.set(char, found);
    return found;
  };
  const bareEndRe = /[\s}]/g;
  let out = '';
  let copied = 0;
  let pos = 0;
  for (;;) {
    const start = text.indexOf('::image[', pos);
    if (start < 0) break;
    const close = nextIndexOf(']', start + 8);
    if (close < 0) break;
    pos = close + 1;
    if (text[close + 1] !== '{') continue;
    const braceStart = close + 2;
    const brace = nextIndexOf('}', braceStart);
    const braceEnd = brace < 0 ? text.length : brace;
    const src = srcStarts[lastIndexBelow(srcStarts, braceEnd - 4)];
    if (src === undefined || src < braceStart) continue;
    const valueStart = src + 4;
    const quote = text[valueStart] ?? '';
    const quoteEnd = quote === '"' || quote === "'" ? nextIndexOf(quote, valueStart + 1) : -1;
    let value: string;
    let end: number;
    if (quoteEnd > valueStart + 1) {
      value = text.slice(valueStart + 1, quoteEnd);
      end = quoteEnd + 1;
    } else {
      bareEndRe.lastIndex = valueStart;
      end = bareEndRe.exec(text)?.index ?? text.length;
      value = text.slice(valueStart, end);
    }
    out += text.slice(copied, start) + rewrite(text.slice(start, valueStart), value);
    copied = end;
    pos = end;
  }
  return out + text.slice(copied);
}

function sanitizeTextSegment(
  segment: string,
  options: SanitizeMarkdownOptions,
  warnings: PageNormalizeWarning[],
  referencedMedia: Set<string>,
): string {
  const mode = options.mode ?? 'strip';
  let text = segment;
  let strippedHtml = false;
  let strippedUrl = false;

  // Page text comes from `.flashpkg` files and Google Docs, so every pass below must stay linear in
  // the input length (S5). Each regex or scan is written so that a failed match never rescans the
  // text a previous attempt already covered.

  // 1. Strip/reject dangerous HTML blocks including inner content (<script>, <style>, <iframe>, <object>, <embed>)
  const blocks = findDangerousBlocks(text);
  if (blocks.length > 0) {
    if (mode === 'reject') {
      throw new PageSecurityError('Raw HTML block element rejected in Markdown page (§13).');
    }
    strippedHtml = true;
    text = cutRanges(text, blocks);
  }

  // 2. HTML comments <!-- ... -->
  const comments = findHtmlComments(text);
  if (comments.length > 0) {
    if (mode === 'reject') {
      throw new PageSecurityError('HTML comment rejected in Markdown page (§13).');
    }
    strippedHtml = true;
    text = cutRanges(text, comments);
  }

  // 3. Any remaining raw HTML opening/closing/self-closing tags (e.g. <div>, <img onerror=...>, <br/>)
  // `\s[^<>]*`, not `\s+[^<>]*`: both parts match spaces, so the `+` form backtracks quadratically.
  const rawTagRe = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g;
  if (rawTagRe.test(text)) {
    if (mode === 'reject') {
      throw new PageSecurityError('Raw HTML tag rejected in Markdown page (§13).');
    }
    strippedHtml = true;
    text = text.replace(rawTagRe, '');
  }

  // 4. Validate Markdown links & images: ![alt](target) and [label](target)
  text = replaceMarkdownLinks(text, (pre, urlRaw, post) => {
    const target = urlRaw.trim();
    if (/^media:[0-9a-f]{64}$/i.test(target)) {
      return `${pre}${target.toLowerCase()}${post}`;
    }
    if (isStrictHttpsUrl(target)) {
      const normalized = `https://${target.slice(8)}`;
      const mapped = String(pre).startsWith('!')
        ? (options.mediaPathMap?.[normalized] ?? options.mediaPathMap?.[target])
        : undefined;
      return `${pre}${mapped ?? normalized}${post}`;
    }
    if (options.allowRelativeMediaPaths && isSafeRelativeMediaPath(target)) {
      referencedMedia.add(target);
      const mapped = options.mediaPathMap?.[target] ?? target;
      return `${pre}${mapped}${post}`;
    }
    if (target.startsWith('#')) {
      return `${pre}${target}${post}`;
    }
    if (mode === 'reject') {
      throw new PageSecurityError(`Unsafe URL scheme rejected in Markdown link/image: "${target}"`);
    }
    strippedUrl = true;
    return `${pre}#blocked${post}`;
  });

  // 5. Validate directive image src: ::image[alt]{src=...}
  text = replaceImageDirectiveSrcs(text, (pre, rawSrc) => {
    const target = rawSrc.trim();
    if (/^media:[0-9a-f]{64}$/i.test(target)) {
      return `${pre}"${target.toLowerCase()}"`;
    }
    if (isStrictHttpsUrl(target)) {
      const normalized = `https://${target.slice(8)}`;
      const mapped = options.mediaPathMap?.[normalized] ?? options.mediaPathMap?.[target];
      return `${pre}"${mapped ?? normalized}"`;
    }
    if (options.allowRelativeMediaPaths && isSafeRelativeMediaPath(target)) {
      referencedMedia.add(target);
      const mapped = options.mediaPathMap?.[target] ?? target;
      return `${pre}"${mapped}"`;
    }
    if (mode === 'reject') {
      throw new PageSecurityError(`Unsafe ::image src rejected: "${target}"`);
    }
    strippedUrl = true;
    return `${pre}""`;
  });

  if (strippedHtml) {
    warnings.push({
      code: 'raw_html_stripped',
      message: 'Raw HTML was stripped from Markdown page content (§13).',
    });
  }
  if (strippedUrl) {
    warnings.push({
      code: 'unsafe_url_stripped',
      message: 'Unsafe non-HTTPS URL(s) were blocked in Markdown page content (§13).',
    });
  }

  return text;
}

/**
 * Strips or rejects raw HTML and unsafe URL schemes outside fenced code blocks and inline code spans (§13).
 */
export function sanitizePageMarkdown(
  rawMarkdown: string,
  options: SanitizeMarkdownOptions = {},
): SanitizeMarkdownResult {
  const warnings: PageNormalizeWarning[] = [];
  const referencedMedia = new Set<string>();

  // Split by fenced code blocks (``` or ~~~) first so code examples stay verbatim
  const lines = rawMarkdown.replace(/\r\n/g, '\n').split('\n');
  const outLines: string[] = [];
  let inFence: string | null = null;
  let proseBuffer: string[] = [];

  const flushProse = () => {
    if (proseBuffer.length === 0) return;
    const chunk = proseBuffer.join('\n');
    proseBuffer = [];
    // Protect inline code spans (`...`) while sanitizing non-code prose
    const tokens = chunk.split(/(`[^`\n]+`)/g);
    const sanitized = tokens
      .map((tok, idx) =>
        idx % 2 === 1 ? tok : sanitizeTextSegment(tok, options, warnings, referencedMedia),
      )
      .join('');
    outLines.push(sanitized);
  };

  for (const line of lines) {
    const fenceMatch = /^([ \t]{0,3})(`{3,}|~{3,})/.exec(line);
    if (!inFence && fenceMatch) {
      flushProse();
      inFence = fenceMatch[2]?.[0] ?? '`';
      outLines.push(line);
    } else if (inFence) {
      outLines.push(line);
      if (
        (inFence === '`' && /^[ \t]{0,3}`{3,}[ \t]*$/.test(line)) ||
        (inFence === '~' && /^[ \t]{0,3}~{3,}[ \t]*$/.test(line))
      ) {
        inFence = null;
      }
    } else {
      proseBuffer.push(line);
    }
  }
  flushProse();

  // Deduplicate warnings by code
  const deduped: PageNormalizeWarning[] = [];
  const seenCodes = new Set<PageWarningCode>();
  for (const w of warnings) {
    if (!seenCodes.has(w.code)) {
      seenCodes.add(w.code);
      deduped.push(w);
    }
  }

  return {
    markdown: outLines.join('\n').trim(),
    warnings: deduped,
    referencedRelativeMediaPaths: [...referencedMedia].sort(),
  };
}

function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'page';
}

/**
 * Returns what `/^#[ \t]+(.+?)[ \t]*#*$/m` captures, trimmed. That regex retries its lazy group at
 * every character of a long heading line, so the line is parsed by hand instead (S5).
 */
function extractFirstHeading(markdown: string): string | undefined {
  for (const line of markdown.split(/[\n\r\u2028\u2029]/)) {
    if (line[0] !== '#') continue;
    let bodyStart = 1;
    while (line[bodyStart] === ' ' || line[bodyStart] === '\t') bodyStart++;
    if (bodyStart === 1 || line.length < 3) continue;
    // `[ \t]+` gives back one character when nothing else is left for the heading text.
    if (bodyStart === line.length) bodyStart--;
    let end = line.length;
    while (end > bodyStart && line[end - 1] === '#') end--;
    while (end > bodyStart && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
    return line.slice(bodyStart, Math.max(end, bodyStart + 1)).trim();
  }
  return undefined;
}

export interface NormalizePageOptions {
  /** Stable source identifier used to derive deterministic `page_id = uuidv5(NS, sourceKey)`. */
  sourceKey: string;
  fallbackTitle: string;
  rawMarkdown: string;
  source: SourceRef;
  state: CollectionState;
  eventFactory: EventFactory;
  htmlMode?: 'strip' | 'reject';
  allowRelativeMediaPaths?: boolean;
  mediaPathMap?: Readonly<Record<string, string>>;
  nowMs?: number;
}

export interface NormalizePageResult {
  pageId: string;
  slug: string;
  title: string;
  contentHash: string;
  changed: boolean;
  events: KnownEvent[];
  warnings: PageNormalizeWarning[];
  referencedRelativeMediaPaths: string[];
}

/**
 * Normalizes a Google Doc Markdown export or local `.md` file into a deterministic `PageUpserted` event.
 * Skips emitting events when the page's content hash is unchanged.
 */
export function normalizeMarkdownPage(options: NormalizePageOptions): NormalizePageResult {
  const nowMs = options.nowMs ?? Date.now();
  const fm = parseMarkdownFrontmatter(options.rawMarkdown);
  const sanitized = sanitizePageMarkdown(fm.body, {
    ...(options.htmlMode !== undefined ? { mode: options.htmlMode } : {}),
    ...(options.allowRelativeMediaPaths !== undefined
      ? { allowRelativeMediaPaths: options.allowRelativeMediaPaths }
      : {}),
    ...(options.mediaPathMap !== undefined ? { mediaPathMap: options.mediaPathMap } : {}),
  });

  const title = fm.title || extractFirstHeading(sanitized.markdown) || options.fallbackTitle;
  const slug = fm.slug ? slugify(fm.slug) : slugify(title || options.fallbackTitle);
  const pageId = uuidv5(FLASH_NAMESPACE_UUID, `page:${options.sourceKey}`);
  const contentHash = computePageContentHash({
    title,
    markdown: sanitized.markdown,
    ...(fm.lang !== undefined ? { lang: fm.lang } : {}),
    tags: fm.tags,
  });

  const existing = options.state.pages.get(pageId);
  const prevHash = existing
    ? computePageContentHash({
        title: existing.title,
        markdown: existing.markdown,
        ...(existing.lang !== undefined ? { lang: existing.lang } : {}),
        tags: existing.tags,
      })
    : undefined;

  const changed = !existing || prevHash !== contentHash || existing.slug !== slug;
  const events: KnownEvent[] = [];

  if (changed) {
    events.push(
      options.eventFactory.create(
        'PageUpserted',
        {
          page_id: pageId,
          slug,
          title,
          markdown: sanitized.markdown,
          ...(fm.lang !== undefined ? { lang: fm.lang } : {}),
          tags: fm.tags,
          source: {
            ...options.source,
            content_hash: contentHash,
            last_synced_at: nowMs,
          },
        },
        nowMs,
      ),
    );
  }

  return {
    pageId,
    slug,
    title,
    contentHash,
    changed,
    events,
    warnings: sanitized.warnings,
    referencedRelativeMediaPaths: sanitized.referencedRelativeMediaPaths,
  };
}
