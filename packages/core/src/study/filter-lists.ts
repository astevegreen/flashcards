import type { CollectionState } from '../events/replay.ts';
import type { Note } from '../model/types.ts';
import {
  filterCards,
  hasCardLevelCriteria,
  matchesCategoryCriterion,
  normalizeCardFilter,
  type CardFilter,
  type CardFilterContext,
  type PerformanceCriterion,
} from './filter.ts';
import { compareCodeUnits } from '../compare.ts';

/*
 * The parts of the Phase 9 filter model only Browse, Stats and the filter panels use: built-in
 * presets, the note-level view and the category list. Kept apart from `filter.ts`, which the
 * study queue imports, so they stay out of the initial study-screen chunk (§8).
 */

function normalizeTag(tag: string): string {
  return tag.normalize('NFC').trim().toLowerCase();
}

export type BuiltinFilterPresetId = 'trouble-cards' | 'failed-this-week';

export interface BuiltinFilterPreset {
  id: BuiltinFilterPresetId;
  name: string;
  description: string;
  /** Performance criteria merged onto the chosen decks / categories. */
  performance: PerformanceCriterion;
}

export const BUILTIN_FILTER_PRESETS: readonly BuiltinFilterPreset[] = [
  {
    id: 'trouble-cards',
    name: 'Trouble cards',
    description: 'The 50 hardest cards you have missed at least once.',
    performance: { minAgainCount: 1, hardest: 50 },
  },
  {
    id: 'failed-this-week',
    name: 'Failed this week',
    description: 'Cards you rated Again in the last 7 days.',
    performance: { failedWithinDays: 7 },
  },
];

/** Applies a built-in preset on top of a base selection (decks, categories, states are kept). */
export function applyFilterPreset(base: CardFilter, presetId: BuiltinFilterPresetId): CardFilter {
  const preset = BUILTIN_FILTER_PRESETS.find((p) => p.id === presetId);
  if (!preset) return normalizeCardFilter(base);
  return normalizeCardFilter({ ...base, performance: { ...preset.performance } });
}

/**
 * Note-level view for Browse: a note matches when its deck and categories match and, if the
 * filter has card-level criteria, at least one of its cards matches. With `archived: true`
 * only archived notes are considered (they have no cards, so only deck / category apply).
 */
export function filterNoteIds(
  state: CollectionState,
  filter: CardFilter,
  ctx: CardFilterContext,
  options: { archived?: boolean } = {},
): Set<string> {
  const out = new Set<string>();
  const deckSet = filter.deckIds && filter.deckIds.length > 0 ? new Set(filter.deckIds) : null;
  const cardLevel = hasCardLevelCriteria(filter);
  const wantArchived = options.archived === true;

  if (cardLevel && !wantArchived) {
    for (const card of filterCards(state, filter, ctx)) out.add(card.note_id);
    return out;
  }
  for (const note of state.notes.values()) {
    if (note.archived !== wantArchived) continue;
    if (deckSet && !deckSet.has(note.deck_id)) continue;
    if (!matchesCategoryCriterion(note.tags.map(normalizeTag), filter.categories)) continue;
    out.add(note.id);
  }
  return out;
}

export interface CategoryCount {
  /** Lowercased tag; hierarchy parents (`grammar` for `grammar::particles`) are listed too. */
  tag: string;
  noteCount: number;
}

/** A note's lowercased tags plus every hierarchy parent (`a`, `a::b` for `a::b::c`). */
function noteCategoriesWithParents(note: Note): Set<string> {
  const seen = new Set<string>();
  for (const raw of note.tags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const parts = tag.split('::');
    for (let i = 1; i <= parts.length; i++) {
      seen.add(parts.slice(0, i).join('::'));
    }
  }
  return seen;
}

/** Every category used by active notes (optionally limited to decks), with note counts. */
export function listCategories(
  state: CollectionState,
  options: { deckIds?: readonly string[] } = {},
): CategoryCount[] {
  const deckSet = options.deckIds && options.deckIds.length > 0 ? new Set(options.deckIds) : null;
  const counts = new Map<string, number>();
  for (const note of state.notes.values()) {
    if (note.archived) continue;
    if (deckSet && !deckSet.has(note.deck_id)) continue;
    for (const tag of noteCategoriesWithParents(note)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, noteCount]) => ({ tag, noteCount }))
    .sort((a, b) => compareCodeUnits(a.tag, b.tag));
}
