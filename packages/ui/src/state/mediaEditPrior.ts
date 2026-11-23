import type { CollectionState, KnownEvent, MediaRefSource } from '@flash/core';

/**
 * The notes and pages a batch of edits rewrites with `media:` references, as they were before
 * the batch, or `null` when no edit mentions media. Taken before the batch applies (note fields
 * change in place), so `planMediaReAdds` (lazy, `mediaReAdds.ts`) can tell which files the batch
 * starts to use. On the initial bundle: keep it this small.
 */
export function priorOfMediaEdits(
  state: CollectionState,
  events: readonly KnownEvent[],
): MediaRefSource | null {
  let prior: {
    notes: Map<string, { fields: Record<string, string> }>;
    pages: Map<string, { markdown: string }>;
  } | null = null;
  for (const ev of events) {
    if (ev.type === 'NoteUpserted' && JSON.stringify(ev.payload.fields).includes('media:')) {
      prior ??= { notes: new Map(), pages: new Map() };
      const id = ev.payload.note_id;
      if (!prior.notes.has(id)) prior.notes.set(id, { fields: { ...state.notes.get(id)?.fields } });
    } else if (ev.type === 'PageUpserted' && ev.payload.markdown.includes('media:')) {
      prior ??= { notes: new Map(), pages: new Map() };
      const id = ev.payload.page_id;
      if (!prior.pages.has(id))
        prior.pages.set(id, { markdown: state.pages.get(id)?.markdown ?? '' });
    }
  }
  return prior;
}
