import { compareCodeUnits } from '../compare.ts';
import type { FlashEvent } from './types.ts';

/**
 * `media:<sha256>` references in notes and pages, and which hashes a batch of edits starts to use.
 *
 * Why the second: `MediaRemoved` (Check media on another device) and `MediaAdded` are last writer
 * wins per hash. An edit that starts using a file the collection already lists emits no add of
 * its own, so a removal decided elsewhere before the edit synced would still drop a file a live
 * note uses. Re-adding the hash with the edit makes the newer use win on every device.
 */

const MEDIA_REF_RE = /media:([0-9a-f]{64})/gi;

/** Calls `onHash` (lower case) for every `media:<sha256>` in `value` (a string or JSON value). */
export function forEachMediaRef(value: unknown, onHash: (hash: string) => void): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text?.includes('media:')) return;
  MEDIA_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_REF_RE.exec(text)) !== null) {
    if (m[1]) onHash(m[1].toLowerCase());
  }
}

function refsOf(value: unknown): Set<string> {
  const out = new Set<string>();
  forEachMediaRef(value, (h) => out.add(h));
  return out;
}

/** What {@link newlyReferencedMedia} reads of the collection before the edits (a `CollectionState` fits). */
export interface MediaRefSource {
  notes: ReadonlyMap<string, { fields: Record<string, string> }>;
  pages: ReadonlyMap<string, { markdown: string }>;
}

/**
 * Hashes `events` start to reference: in a note's fields or a page's text, and not already used
 * there before this batch. Hashes the batch adds itself (`MediaAdded`) are left out. Sorted.
 */
export function newlyReferencedMedia(
  state: MediaRefSource,
  events: readonly FlashEvent[],
): string[] {
  const noteRefs = new Map<string, Set<string>>();
  const pageRefs = new Map<string, Set<string>>();
  const added = new Set<string>();
  const found = new Set<string>();
  const track = (prior: Set<string>, next: Set<string>): void => {
    for (const h of next) if (!prior.has(h)) found.add(h);
  };
  for (const ev of events) {
    const p = ev.payload as Record<string, unknown> | null;
    if (p === null || typeof p !== 'object') continue;
    if (ev.type === 'MediaAdded') {
      const media = p['media'] as { hash?: unknown } | undefined;
      if (typeof media?.hash === 'string') added.add(media.hash.toLowerCase());
    } else if (ev.type === 'NoteUpserted' && typeof p['note_id'] === 'string') {
      const id = p['note_id'];
      const prior = noteRefs.get(id) ?? refsOf(state.notes.get(id)?.fields ?? '');
      const next = refsOf(p['fields']);
      track(prior, next);
      noteRefs.set(id, next);
    } else if (ev.type === 'PageUpserted' && typeof p['page_id'] === 'string') {
      const id = p['page_id'];
      const prior = pageRefs.get(id) ?? refsOf(state.pages.get(id)?.markdown ?? '');
      const next = refsOf(p['markdown']);
      track(prior, next);
      pageRefs.set(id, next);
    }
  }
  return [...found].filter((h) => !added.has(h)).sort(compareCodeUnits);
}
