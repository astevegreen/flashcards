import { stripCloze, stripRuby } from '@flash/core';

/**
 * Auto-fit card text (Phase 13). The heavy lifting is CSS: every `card-fit-*` class in
 * `apps/web/src/styles.css` sizes text with `clamp(rem, cqmin, rem)` against the card's
 * size container, times the user's `--card-text-scale`. JS only picks a tier from the
 * visible text length, so a single Hanja fills the card while a grammar paragraph drops to a
 * readable size and scrolls inside the card.
 */
export type CardTextRole = 'prompt' | 'answer' | 'detail';

/** Number of user-perceived characters once ruby readings and cloze markup are removed. */
export function visibleTextLength(value: string): number {
  const plain = stripRuby(stripCloze(value)).replace(/\s+/g, ' ').trim();
  return [...plain].length;
}

export function cardTextFitTier(value: string, role: CardTextRole = 'prompt'): string {
  const len = visibleTextLength(value);
  if (role === 'detail') return len > 120 ? 'd long' : 'd';
  if (role === 'answer') return len <= 12 ? 'a1' : len <= 60 ? 'a2' : 'a3 long';
  if (len <= 2) return 'p1';
  if (len <= 6) return 'p2';
  if (len <= 16) return 'p3';
  if (len <= 60) return 'p4';
  return 'p5 long';
}

/** `className` for a card field: `card-fit card-fit-<tier>` (plus `card-fit-long` for paragraphs). */
export function cardTextFitClass(value: string, role: CardTextRole = 'prompt'): string {
  return `card-fit ${cardTextFitTier(value, role)
    .split(' ')
    .map((t) => `card-fit-${t}`)
    .join(' ')}`;
}
