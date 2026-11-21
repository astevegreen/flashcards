/**
 * Pure Markdown-to-AST parser built on `mdast-util-from-markdown` (micromark tokenizer) +
 * GFM tables + CommonMark directives.
 * Strictly lazy-loaded inside the Page Viewer/Editor chunk (0 KB initial study JS, §8).
 * Produces a typed AST with ZERO HTML string compilation (§13).
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { directiveFromMarkdown } from 'mdast-util-directive';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { directive } from 'micromark-extension-directive';
import { gfmTable } from 'micromark-extension-gfm-table';

export interface AstNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  url?: string;
  alt?: string | null;
  title?: string | null;
  lang?: string | null;
  name?: string;
  attributes?: Record<string, string | null | undefined>;
  align?: Array<'left' | 'right' | 'center' | null> | null;
  children?: AstNode[];
}

/**
 * Returns true if `trimmedLine` consists SOLELY of a single `::(say|deck-link|image)` leaf directive
 * (with optional nested `[...]` label and `{...}` attributes) and no trailing text.
 */
function isStandaloneLeafDirectiveLine(trimmedLine: string): boolean {
  const m = /^::(say|deck-link|image)/.exec(trimmedLine);
  if (!m) return false;
  let i = m[0].length;
  if (trimmedLine[i] === '[') {
    let depth = 0;
    while (i < trimmedLine.length) {
      if (trimmedLine[i] === '[') depth += 1;
      else if (trimmedLine[i] === ']') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
    if (depth !== 0) return false;
  }
  if (trimmedLine[i] === '{') {
    let depth = 0;
    while (i < trimmedLine.length) {
      if (trimmedLine[i] === '{') depth += 1;
      else if (trimmedLine[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
    if (depth !== 0) return false;
  }
  return i === trimmedLine.length;
}

/**
 * Code-safe pre-pass normalizing two author-friendly §2.3 conveniences before micromark parsing:
 * 1. Inline `::say[...]{...}` (anywhere in a line with surrounding prose, including column 0) -> `:say[...]{...}`
 *    so micromark parses it as a clean `textDirective` without leaving a stray `:` or failing leafDirective parsing.
 * 2. Standalone `---` inside `:::example` blocks -> surrounded by blank lines so CommonMark
 *    parses it as a `thematicBreak` instead of a Setext H2 heading.
 */
function preprocessDirectiveMarkdown(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence: string | null = null;
  let inExampleContainer = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fenceMatch = /^([ \t]{0,3})(`{3,}|~{3,})/.exec(line);
    if (!inFence && fenceMatch) {
      inFence = fenceMatch[2]?.[0] ?? '`';
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      if (
        (inFence === '`' && /^[ \t]{0,3}`{3,}[ \t]*$/.test(line)) ||
        (inFence === '~' && /^[ \t]{0,3}~{3,}[ \t]*$/.test(line))
      ) {
        inFence = null;
      }
      continue;
    }

    if (/^[ \t]*:::example\b/.test(line)) {
      inExampleContainer = true;
      out.push(line);
      continue;
    }
    if (inExampleContainer && /^[ \t]*:::[ \t]*$/.test(line)) {
      inExampleContainer = false;
      out.push(line);
      continue;
    }
    if (inExampleContainer && /^[ \t]*---[ \t]*$/.test(line)) {
      if (out.length > 0 && out[out.length - 1]?.trim() !== '') {
        out.push('');
      }
      out.push('---');
      const next = lines[i + 1];
      if (next !== undefined && next.trim() !== '') {
        out.push('');
      }
      continue;
    }

    // Keep true standalone leaf directives (`::image[...]{...}`, `::deck-link{...}`, `::say[...]{...}` alone on a line)
    if (isStandaloneLeafDirectiveLine(line.trim())) {
      out.push(line);
      continue;
    }

    // Protect inline code spans (`...`) while normalizing inline `::say` / `::deck-link` / `::image` -> `:name`
    const tokens = line.split(/(`[^`]+`)/g);
    const normalizedLine = tokens
      .map((tok, idx) => {
        if (idx % 2 === 1) return tok;
        return tok.replace(/(^|[^:\n])::(say|deck-link|image)(?=\[|\{)/g, '$1:$2');
      })
      .join('');
    out.push(normalizedLine);
  }

  return out.join('\n');
}

export function parsePageMarkdownToAst(markdown: string): AstNode {
  const prepared = preprocessDirectiveMarkdown(markdown);
  const tree = fromMarkdown(prepared, {
    extensions: [gfmTable(), directive()],
    mdastExtensions: [gfmTableFromMarkdown(), directiveFromMarkdown()],
  });
  return tree as unknown as AstNode;
}
