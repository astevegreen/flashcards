import { applyEvents, createEmptyState, type CollectionState } from '../../src/events/replay.ts';
import type { FlashEvent } from '../../src/events/types.ts';

/** A deterministic Fisher-Yates shuffle (LCG), so a failing seed replays the same order. */
export function shuffleWithSeed<T>(arr: readonly T[], s: number): T[] {
  const copy = [...arr];
  let x = s || 1;
  for (let i = copy.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

/** Replays `list` from an empty state `chunk` events at a time, as sync delivers batches. */
export function replayChunked(list: readonly FlashEvent[], chunk: number): CollectionState {
  const st = createEmptyState();
  for (let i = 0; i < list.length; i += chunk) applyEvents(st, list.slice(i, i + chunk));
  return st;
}
