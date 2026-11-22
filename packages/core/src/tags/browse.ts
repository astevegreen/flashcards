import type { CollectionState } from '../events/replay.ts';
import { compareHlc } from '../hlc.ts';
import type { Note } from '../model/types.ts';
import { stripCloze } from '../parsers/cloze.ts';
import { stripRuby } from '../parsers/ruby.ts';
import {
  filterCards,
  filterNoteIds,
  matchesCategoryCriterion,
  type CardFilter,
  type CardFilterContext,
} from '../study/filter.ts';

/**
 * Note ids Browse shows for a filter. Same as {@link filterNoteIds}, plus one Browse rule: the
 * "Due today" state means cards Study would show today, so suspended cards never count as due
 * (unless the filter also asks for suspended cards).
 */
export function filterBrowseNoteIds(
  state: CollectionState,
  filter: CardFilter,
  ctx: CardFilterContext,
  options: { archived?: boolean } = {},
): Set<string> {
  const states = filter.states ?? [];
  const excludeSuspended =
    ctx.excludeSuspended === true || (states.includes('due') && !states.includes('suspended'));
  return filterNoteIds(
    state,
    filter,
    excludeSuspended ? { ...ctx, excludeSuspended } : ctx,
    options,
  );
}

/** Lowercased, NFC-normalized search text (the Browse search box normalization). */
function normalizeSearchText(text: string): string {
  return text.normalize('NFC').trim().toLowerCase();
}

/** Field text match, also against the ruby / cloze-stripped text of marked-up fields. */
function fieldMatchesText(value: string, needle: string): boolean {
  if (value.normalize('NFC').toLowerCase().includes(needle)) return true;
  if (!value.includes('[') && !value.includes('{')) return false;
  return stripRuby(stripCloze(value)).normalize('NFC').toLowerCase().includes(needle);
}

/**
 * The Browse search box rule: `#tag` matches the category (exact tag or `tag::child`), any other
 * text matches a field (also its ruby / cloze-stripped text) or a tag substring. An empty query
 * matches every note.
 */
export function noteMatchesSearchText(note: Note, query: string): boolean {
  const q = normalizeSearchText(query);
  if (q === '') return true;
  const tags = note.tags.map(normalizeSearchText);
  if (q.startsWith('#')) {
    const tag = q.slice(1);
    return tag !== '' && matchesCategoryCriterion(tags, { mode: 'any', tags: [tag] });
  }
  return (
    Object.values(note.fields).some((value) => fieldMatchesText(value, q)) ||
    tags.some((tag) => tag.includes(q))
  );
}

export interface NoteSearchOptions {
  /** Browse search box text (see {@link noteMatchesSearchText}). */
  query?: string;
  /** Archived notes only (the Browse "Archived" toggle). */
  archived?: boolean;
  /** Maximum notes returned (`total` still counts every match). */
  limit?: number;
}

export interface NoteSearchResult {
  notes: Note[];
  /** Every matching note, before `limit`. */
  total: number;
}

/** Rank of each note: the position of its first card in the filter's hardest-first ranking. */
function hardestNoteRanks(
  state: CollectionState,
  filter: CardFilter,
  ctx: CardFilterContext,
): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const card of filterCards(state, filter, ctx)) {
    if (!ranks.has(card.note_id)) ranks.set(card.note_id, ranks.size);
  }
  return ranks;
}

function compareNotesByCreation(a: Note, b: Note): number {
  return a.created_order - b.created_order || compareHlc(a.id, b.id);
}

/**
 * Notes for a Phase 9 filter plus the Browse search text: exactly the notes Browse lists for the
 * same filter and query, in Browse order (creation order), or hardest-first when the filter ranks
 * its `hardest` cards. Used by the MCP `search_notes` tool.
 */
export function searchNotes(
  state: CollectionState,
  filter: CardFilter,
  ctx: CardFilterContext,
  options: NoteSearchOptions = {},
): NoteSearchResult {
  const archived = options.archived === true;
  const query = options.query ?? '';
  const matched: Note[] = [];
  for (const id of filterBrowseNoteIds(state, filter, ctx, { archived })) {
    const note = state.notes.get(id);
    if (note && noteMatchesSearchText(note, query)) matched.push(note);
  }
  const ranked = filter.performance?.hardest !== undefined && !archived;
  const ranks = ranked ? hardestNoteRanks(state, filter, ctx) : undefined;
  matched.sort((a, b) =>
    ranks
      ? (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0) || compareNotesByCreation(a, b)
      : compareNotesByCreation(a, b),
  );
  const limit = options.limit;
  const notes =
    limit !== undefined && Number.isFinite(limit) ? matched.slice(0, Math.max(0, limit)) : matched;
  return { notes, total: matched.length };
}
