import { type Layout, type Note, noteField } from '@flash/core';

/** Reveal steps with at least one non-empty field on the note (never zero steps). */
export function populatedRevealStepsFor(
  layout: Layout | undefined,
  note: Note | undefined,
): string[][] {
  if (!layout || !note) return [];
  const steps = layout.reveal_steps
    .map((stepKeys) => stepKeys.filter((key) => (noteField(note, key)?.trim().length ?? 0) > 0))
    .filter((stepKeys) => stepKeys.length > 0);
  return steps.length > 0 ? steps : [layout.reveal_steps[0] ?? []];
}
