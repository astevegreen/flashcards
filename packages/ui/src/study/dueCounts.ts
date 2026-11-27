import type { StudyCounts } from '@flash/core';

/** The due-count chips as one labelled sentence; the chips themselves are hidden from readers. */
export function dueCountsText(counts: Pick<StudyCounts, 'new' | 'learning' | 'due'>): string {
  return `${counts.new} new, ${counts.learning} learning, ${counts.due} due for review`;
}
