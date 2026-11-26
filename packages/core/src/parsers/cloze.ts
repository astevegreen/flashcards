/**
 * Pure, zero-dependency Cloze deletion parser per blueprint §5.2.
 * Supports `{{cN::answer}}` and optional hint `{{cN::answer::hint}}` (`N` in 1..99).
 * Safely preserves nested single braces (e.g. `{{c1::{今日|きょう}::today}}` and
 * `{{c1::学生[がくせい]::student}}`) and keeps malformed/unclosed tags verbatim as plain text.
 */

export type ClozeSegment =
  { type: 'text'; value: string } | { type: 'cloze'; index: number; answer: string; hint?: string };

function pushText(segments: ClozeSegment[], value: string): void {
  if (!value) return;
  const last = segments[segments.length - 1];
  if (last && last.type === 'text') {
    last.value += value;
  } else {
    segments.push({ type: 'text', value });
  }
}

/**
 * Finds the matching `}}` for a cloze marker starting after `{{cN::`, respecting nested
 * single-brace ruby syntax `{base|reading}` so `{{c1::{今日|きょう}}}` closes at the outer `}}`!
 * When the braces inside never balance (`{{c1::{a}}`), it closes at the first `}}`, as Anki
 * reads it (C19).
 */
function findClozeClose(input: string, bodyStart: number): number {
  let i = bodyStart;
  let singleBraceDepth = 0;

  while (i < input.length - 1) {
    const ch = input[i];
    const next = input[i + 1];

    // A new `{{` before this cloze balanced: unbalanced body, or an unclosed outer cloze.
    if (ch === '{' && next === '{') break;

    if (ch === '{') {
      singleBraceDepth += 1;
      i += 1;
      continue;
    }

    if (ch === '}') {
      if (singleBraceDepth > 0) {
        singleBraceDepth -= 1;
        i += 1;
        continue;
      }
      if (next === '}') {
        return i;
      }
    }

    i += 1;
  }

  // Fall back to the first `}}` before where the scan stopped (C19).
  const close = input.indexOf('}}', bodyStart);
  return close < i ? close : -1;
}

/**
 * Splits a cloze body into `[answer, hint?]` on the first `::` outside nested `{...}`.
 */
function splitAnswerAndHint(body: string): { answer: string; hint?: string } {
  let depth = 0;
  let separator = -1;
  for (let i = 0; i < body.length - 1; i++) {
    const ch = body[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
    } else if (depth === 0 && ch === ':' && body[i + 1] === ':') {
      separator = i;
      break;
    }
  }
  // Braces that never balance (`a{b::hint`) don't hide the separator (C19).
  if (depth > 0) separator = body.indexOf('::');
  if (separator === -1) return { answer: body };
  const answer = body.slice(0, separator);
  const hint = body.slice(separator + 2);
  return hint.length > 0 ? { answer, hint } : { answer };
}

/**
 * Parses `{{cN::answer}}` and `{{cN::answer::hint}}` markers into pure segments.
 */
export function parseCloze(input: string): ClozeSegment[] {
  if (!input) return [];

  const segments: ClozeSegment[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const openIdx = input.indexOf('{{', cursor);
    if (openIdx === -1) {
      pushText(segments, input.slice(cursor));
      break;
    }

    if (openIdx > cursor) {
      pushText(segments, input.slice(cursor, openIdx));
    }

    // Match header `{{cN::` where N is 1..99 (no leading zero)
    const sliceFromOpen = input.slice(openIdx);
    const headerMatch = /^\{\{c([1-9][0-9]?)::/i.exec(sliceFromOpen);
    if (!headerMatch || !headerMatch[1]) {
      pushText(segments, '{{');
      cursor = openIdx + 2;
      continue;
    }

    const clozeIndex = Number.parseInt(headerMatch[1], 10);
    const bodyStart = openIdx + headerMatch[0].length;
    const closeIdx = findClozeClose(input, bodyStart);

    if (closeIdx === -1) {
      // Malformed / unclosed tag -> preserve literal `{{` and continue scanning
      pushText(segments, '{{');
      cursor = openIdx + 2;
      continue;
    }

    const body = input.slice(bodyStart, closeIdx);
    const { answer, hint } = splitAnswerAndHint(body);

    if (answer.length === 0) {
      // Empty answer like `{{c1::}}` -> keep verbatim as plain text
      pushText(segments, input.slice(openIdx, closeIdx + 2));
      cursor = closeIdx + 2;
      continue;
    }

    segments.push({
      type: 'cloze',
      index: clozeIndex,
      answer,
      ...(hint !== undefined ? { hint } : {}),
    });
    cursor = closeIdx + 2;
  }

  return segments;
}

/**
 * Extracts all unique cloze deletion numbers (`1..99`) in ascending numerical order.
 */
export function extractClozeNumbers(input: string): number[] {
  if (!input || !input.includes('{{')) return [];
  const nums = new Set<number>();
  for (const seg of parseCloze(input)) {
    if (seg.type === 'cloze') {
      nums.add(seg.index);
    }
  }
  return [...nums].sort((a, b) => a - b);
}

/**
 * Returns all cloze answers matching `variant` (`c<variant>`) in document order.
 */
export function extractClozeAnswersForVariant(input: string, variant: number): string[] {
  if (!input || variant < 1) return [];
  const out: string[] = [];
  for (const seg of parseCloze(input)) {
    if (seg.type === 'cloze' && seg.index === variant) {
      out.push(seg.answer);
    }
  }
  return out;
}

/**
 * Strips cloze markup (`{{c1::answer::hint}}` -> `answer`) for search indexing, previews, and TTS.
 */
export function stripCloze(input: string): string {
  if (!input || !input.includes('{{')) return input;
  return parseCloze(input)
    .map((seg) => (seg.type === 'cloze' ? seg.answer : seg.value))
    .join('');
}
