import { parseCloze } from '../parsers/cloze.ts';

// Used only by the lazy Cloze answer mode, so it lives outside cloze.ts (§8).

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
