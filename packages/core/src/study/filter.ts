import { default_w } from 'ts-fsrs';
import { isCardSuspended, resolveDeckFsrsConfig, type CollectionState } from '../events/replay.ts';
import { getNextStudyDayRolloverMs, getStudyDayIndex } from '../fsrs/scheduler.ts';
import type { NoteUpsertedPayload } from '../events/types.ts';
import type { Card, Note } from '../model/types.ts';

/**
 * Phase 9 shared filter model (blueprint §15 Phase 9): one plain, JSON-safe description of a
 * card selection used by Browse, filtered Study sessions and (later) synced Study Sets.
 * Every criterion is optional; criteria combine with AND. Evaluation is deterministic for a
 * given `(state, filter, nowMs, tzOffsetMinutes)` and never forks FSRS state.
 */

/** Lapse count at which a card is treated as a leech (Anki / Flashcards Deluxe default). */
export const LEECH_LAPSE_THRESHOLD = 8;

/**
 * The `leech` category. Reaching {@link LEECH_LAPSE_THRESHOLD} lapses tags the note `leech` (a real
 * tag, see {@link planLeechTag}); the filter also keeps matching such cards virtually, so leeches
 * from before the tag existed (or imported histories) still match.
 */
export const LEECH_CATEGORY = 'leech';

export type CardStateKind = 'new' | 'learning' | 'review' | 'due' | 'suspended' | 'leech';

export const CARD_STATE_KINDS: readonly CardStateKind[] = [
  'new',
  'learning',
  'review',
  'due',
  'suspended',
  'leech',
];

export type CategoryMatchMode = 'any' | 'all' | 'none';

export interface CategoryCriterion {
  mode: CategoryMatchMode;
  /** Note tags. `a` also matches the hierarchical children `a::b`, `a::b::c` (case-insensitive). */
  tags: readonly string[];
}

export interface PerformanceCriterion {
  /** FSRS lapses (Review -> Again transitions) >= N. */
  minLapses?: number;
  /** Total active (not undone) Again ratings >= N, including misses while still learning. */
  minAgainCount?: number;
  /** At least one active Again rating within the last N study days (today counts as day 1). */
  failedWithinDays?: number;
  /** Current FSRS recall probability strictly below this value (0..1). Unreviewed cards never match. */
  maxRetrievability?: number;
  /**
   * Keep only the N hardest cards among those matching every other criterion, ranked like MCP
   * `get_weak_cards`: lapses desc, stability asc, difficulty desc, card id. Unreviewed cards are skipped.
   */
  hardest?: number;
}

export interface CardFilter {
  /** Any of these decks. Omitted or empty = every deck. */
  deckIds?: readonly string[];
  categories?: CategoryCriterion;
  /** Card matches when it has ANY of these states. Omitted or empty = any state. */
  states?: readonly CardStateKind[];
  performance?: PerformanceCriterion;
}

export interface CardFilterContext {
  nowMs: number;
  /** Minutes east of UTC (e.g. `-new Date().getTimezoneOffset()`, +540 for KST). */
  tzOffsetMinutes: number;
  /** Global study-day rollover hour override (defaults to `state.preferences.day_start_hour`). */
  dayStartHour?: number;
  /** Drop suspended cards before ranking (the study queue sets this). */
  excludeSuspended?: boolean;
  /** Leech lapse threshold override (defaults to {@link LEECH_LAPSE_THRESHOLD}). */
  leechThreshold?: number;
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

const MS_PER_DAY = 86_400_000;

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 1 ? n : undefined;
}

function normalizeTag(tag: string): string {
  return tag.normalize('NFC').trim().toLowerCase();
}

function normalizeDeckIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = [
    ...new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0)),
  ].sort(cmpStr);
  return ids.length > 0 ? ids : undefined;
}

function normalizeTagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .filter((v): v is string => typeof v === 'string')
        .map(normalizeTag)
        .filter((v) => v.length > 0),
    ),
  ].sort(cmpStr);
}

function isCategoryMatchMode(value: unknown): value is CategoryMatchMode {
  return value === 'any' || value === 'all' || value === 'none';
}

function normalizeCategories(raw: unknown): CategoryCriterion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  const mode = c['mode'];
  const tags = normalizeTagList(c['tags']);
  return isCategoryMatchMode(mode) && tags.length > 0 ? { mode, tags } : undefined;
}

function normalizeStates(raw: unknown): CardStateKind[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const states = CARD_STATE_KINDS.filter((k) => (raw as unknown[]).includes(k));
  return states.length > 0 ? states : undefined;
}

/** Integer performance criteria (>= 1), in canonical key order. */
const POSITIVE_INT_PERFORMANCE_KEYS = [
  'minLapses',
  'minAgainCount',
  'failedWithinDays',
  'hardest',
] as const;

function normalizePerformance(raw: unknown): PerformanceCriterion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const next: PerformanceCriterion = {};
  for (const key of POSITIVE_INT_PERFORMANCE_KEYS) {
    const value = positiveInt(p[key]);
    if (value !== undefined) next[key] = value;
  }
  const maxR = p['maxRetrievability'];
  if (typeof maxR === 'number' && Number.isFinite(maxR) && maxR > 0 && maxR <= 1) {
    next.maxRetrievability = maxR;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Sanitizes an untrusted / partially filled filter into canonical form: dedupes and sorts ids
 * and tags, drops empty criteria and invalid numbers. Idempotent; safe for persistence.
 */
export function normalizeCardFilter(raw: unknown): CardFilter {
  const out: CardFilter = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;

  const deckIds = normalizeDeckIds(r['deckIds']);
  if (deckIds) out.deckIds = deckIds;
  const categories = normalizeCategories(r['categories']);
  if (categories) out.categories = categories;
  const states = normalizeStates(r['states']);
  if (states) out.states = states;
  const performance = normalizePerformance(r['performance']);
  if (performance) out.performance = performance;

  return out;
}

/** True when the filter selects everything (no criterion set). */
export function isCardFilterEmpty(filter: CardFilter | undefined): boolean {
  if (!filter) return true;
  return (
    (filter.deckIds?.length ?? 0) === 0 &&
    (filter.categories?.tags.length ?? 0) === 0 &&
    (filter.states?.length ?? 0) === 0 &&
    (filter.performance === undefined || Object.keys(filter.performance).length === 0)
  );
}

/** True when the filter needs per-card data (state / performance / the virtual leech category). */
export function hasCardLevelCriteria(filter: CardFilter): boolean {
  return (
    (filter.states?.length ?? 0) > 0 ||
    (filter.performance !== undefined && Object.keys(filter.performance).length > 0) ||
    (filter.categories?.tags.includes(LEECH_CATEGORY) ?? false)
  );
}

export function isLeechCard(card: Card, threshold: number = LEECH_LAPSE_THRESHOLD): boolean {
  return card.schedule.lapses >= threshold;
}

/**
 * Optional leech auto-suspend (Phase 9, default off). Decided once, at review time, by the device
 * that records the review: true when the setting is on, the card is not already suspended, and
 * this review takes its lapses from below {@link LEECH_LAPSE_THRESHOLD} to the threshold or above.
 * The caller then appends one `CardSuspended { reason: 'leech' }` next to the `ReviewRecorded`, so
 * every device (older builds included) replays the same suspension from the log.
 */
export function shouldAutoSuspendLeech(
  state: CollectionState,
  cardId: string,
  lapsesBefore: number,
  lapsesAfter: number,
): boolean {
  return (
    state.preferences.leech_auto_suspend === true &&
    lapsesBefore < LEECH_LAPSE_THRESHOLD &&
    lapsesAfter >= LEECH_LAPSE_THRESHOLD &&
    !isCardSuspended(state, cardId)
  );
}

/** True when one of the note's stored tags is exactly the `leech` category (any spelling). */
function hasLeechTag(note: Note): boolean {
  return note.tags.some((t) => normalizeTag(t) === LEECH_CATEGORY);
}

/**
 * Leech tag (Phase 9): the review that takes a card's lapses from below
 * {@link LEECH_LAPSE_THRESHOLD} to the threshold or above also tags its note `leech`, as one
 * tag-only `NoteUpserted` appended next to the `ReviewRecorded` by the reviewing device (so every
 * build replays the same tag). `undefined` when the review doesn't cross the threshold or the note
 * is already tagged. Other tags are kept exactly as stored.
 */
export function planLeechTag(
  state: CollectionState,
  card: Card,
  lapsesBefore: number,
  lapsesAfter: number,
): NoteUpsertedPayload | undefined {
  if (lapsesBefore >= LEECH_LAPSE_THRESHOLD || lapsesAfter < LEECH_LAPSE_THRESHOLD)
    return undefined;
  const note = state.notes.get(card.note_id);
  if (!note || hasLeechTag(note)) return undefined;
  return {
    note_id: note.id,
    deck_id: note.deck_id,
    source_key: note.source_key,
    fields: {},
    tags: [...note.tags, LEECH_CATEGORY],
  };
}

/**
 * Undo of the review that tagged a note `leech` (see {@link planLeechTag}): removes the tag again
 * unless another card of the note is still a leech. `undefined` when nothing changes.
 */
export function planLeechTagUndo(
  state: CollectionState,
  card: Card,
): NoteUpsertedPayload | undefined {
  const note = state.notes.get(card.note_id);
  if (!note || !hasLeechTag(note)) return undefined;
  for (const siblingId of state.cardIdsByNote.get(note.id) ?? []) {
    const sibling = state.cards.get(siblingId);
    if (siblingId !== card.id && sibling && isLeechCard(sibling)) return undefined;
  }
  return {
    note_id: note.id,
    deck_id: note.deck_id,
    source_key: note.source_key,
    fields: {},
    tags: note.tags.filter((t) => normalizeTag(t) !== LEECH_CATEGORY),
  };
}

function tagMatches(noteTagsLower: readonly string[], wanted: string): boolean {
  for (const t of noteTagsLower) {
    if (t === wanted || t.startsWith(`${wanted}::`)) return true;
  }
  return false;
}

/**
 * Category (tag) matching for a set of lowercased tags. `any`: at least one wanted tag,
 * `all`: every wanted tag, `none`: no wanted tag. Hierarchical `parent::child` aware.
 */
export function matchesCategoryCriterion(
  tagsLower: readonly string[],
  criterion: CategoryCriterion | undefined,
): boolean {
  if (!criterion || criterion.tags.length === 0) return true;
  const wanted = criterion.tags.map(normalizeTag);
  switch (criterion.mode) {
    case 'any':
      return wanted.some((w) => tagMatches(tagsLower, w));
    case 'all':
      return wanted.every((w) => tagMatches(tagsLower, w));
    case 'none':
      return !wanted.some((w) => tagMatches(tagsLower, w));
  }
}

function effectiveDayStart(state: CollectionState, deckId: string, ctx: CardFilterContext): number {
  const globalHour = ctx.dayStartHour ?? state.preferences.day_start_hour;
  const override = state.decks.get(deckId)?.settings.day_start_hour;
  return override !== undefined && override >= 0 && override <= 23 ? override : globalHour;
}

/** Every {@link CardStateKind} the card currently has. */
export function getCardStateKinds(
  state: CollectionState,
  card: Card,
  ctx: CardFilterContext,
): Set<CardStateKind> {
  const kinds = new Set<CardStateKind>();
  const s = card.schedule;
  if (s.state === 0) kinds.add('new');
  else if (s.state === 1 || s.state === 3) kinds.add('learning');
  else kinds.add('review');
  if (s.state !== 0) {
    const dayStart = effectiveDayStart(state, card.deck_id, ctx);
    if (s.due < getNextStudyDayRolloverMs(ctx.nowMs, ctx.tzOffsetMinutes, dayStart)) {
      kinds.add('due');
    }
  }
  if (isCardSuspended(state, card.id)) kinds.add('suspended');
  if (isLeechCard(card, ctx.leechThreshold)) kinds.add('leech');
  return kinds;
}

/**
 * Current FSRS recall probability `R(t, S)` from the deck's active parameters (FSRS-6 power
 * forgetting curve; FSRS-5 decay 0.5 for 19-weight parameter sets). `undefined` for new cards.
 */
export function computeCardRetrievability(
  state: CollectionState,
  card: Card,
  nowMs: number,
): number | undefined {
  const s = card.schedule;
  const lastReview = s.last_review ?? card.last_reviewed_at;
  if (s.state === 0 || lastReview === undefined || !(s.stability > 0)) return undefined;
  const config = resolveDeckFsrsConfig(state, card.deck_id, nowMs);
  const w = config.w ?? default_w;
  const w20 = w.length > 20 ? w[20] : undefined;
  const decay = w20 !== undefined && w20 > 0 ? w20 : 0.5;
  const factor = Math.pow(0.9, -1 / decay) - 1;
  const elapsedDays = Math.max(0, nowMs - lastReview) / MS_PER_DAY;
  return Math.pow(1 + (factor * elapsedDays) / s.stability, -decay);
}

/** MCP `get_weak_cards` ordering: lapses desc, stability asc, difficulty desc, card id asc. */
export function compareHardestCards(a: Card, b: Card): number {
  return (
    b.schedule.lapses - a.schedule.lapses ||
    round4(a.schedule.stability) - round4(b.schedule.stability) ||
    round4(b.schedule.difficulty) - round4(a.schedule.difficulty) ||
    cmpStr(a.id, b.id)
  );
}

/** The `n` hardest of `cards` ({@link compareHardestCards} order). */
export function rankHardestCards(cards: readonly Card[], n: number): Card[] {
  return [...cards].sort(compareHardestCards).slice(0, n);
}

/**
 * The "hardest N" cap of a due-only queue, bounded per study day. Each card of the selection
 * already reviewed today holds one of the N slots (and stays queued while it is due again, e.g.
 * in a learning step); the slots left go to the hardest due cards not reviewed yet today.
 * Answering a card therefore never frees a slot for the (N+1)th hardest one: the session stops
 * after N cards and the cap resets at the next study day. Deterministic from `ReviewRecorded`.
 *
 * `reviewedToday` holds the ids of the selection's cards (the filter without `hardest`) with an
 * active review today. Returns the ids of `due` to keep.
 */
export function keepHardestDueToday(
  due: readonly Card[],
  hardest: number,
  reviewedToday: ReadonlySet<string>,
): Set<string> {
  const keep = new Set<string>();
  const fresh: Card[] = [];
  for (const card of due) {
    if (reviewedToday.has(card.id)) keep.add(card.id);
    else fresh.push(card);
  }
  const slots = Math.max(0, hardest - reviewedToday.size);
  for (const card of rankHardestCards(fresh, slots)) keep.add(card.id);
  return keep;
}

/**
 * Splits a filter into its `performance.hardest` cap and everything else. Queues that only take
 * due cards (on-schedule Study Sets, review ahead) apply the other criteria, then the due check,
 * and rank the hardest N last, so "the 50 hardest" means the 50 hardest cards that are due rather
 * than whichever of the 50 hardest overall happen to be due.
 */
export function splitHardestCriterion(filter: CardFilter): {
  base: CardFilter;
  hardest: number | undefined;
} {
  const hardest = filter.performance?.hardest;
  if (hardest === undefined || !filter.performance) return { base: filter, hardest: undefined };
  const performance: PerformanceCriterion = { ...filter.performance };
  delete performance.hardest;
  const base: CardFilter = { ...filter };
  if (Object.keys(performance).length > 0) base.performance = performance;
  else delete base.performance;
  return { base, hardest };
}

function countAgain(
  state: CollectionState,
  card: Card,
  ctx: CardFilterContext,
  withinDays: number | undefined,
): { total: number; recent: number } {
  const reviews = state.reviewsByCard.get(card.id);
  let total = 0;
  let recent = 0;
  if (!reviews) return { total, recent };
  let firstRecentDay = Number.NEGATIVE_INFINITY;
  let dayStart = 4;
  if (withinDays !== undefined) {
    dayStart = effectiveDayStart(state, card.deck_id, ctx);
    firstRecentDay = getStudyDayIndex(ctx.nowMs, ctx.tzOffsetMinutes, dayStart) - (withinDays - 1);
  }
  for (const r of reviews) {
    if (r.rating !== 1 || state.undoneReviewIds.has(r.review_id)) continue;
    total += 1;
    if (
      withinDays !== undefined &&
      r.reviewed_at <= ctx.nowMs &&
      getStudyDayIndex(r.reviewed_at, ctx.tzOffsetMinutes, dayStart) >= firstRecentDay
    ) {
      recent += 1;
    }
  }
  return { total, recent };
}

function matchesCategories(
  card: Card,
  note: Note,
  filter: CardFilter,
  ctx: CardFilterContext,
): boolean {
  if (!filter.categories || filter.categories.tags.length === 0) return true;
  const tags = note.tags.map(normalizeTag);
  if (isLeechCard(card, ctx.leechThreshold)) tags.push(LEECH_CATEGORY);
  return matchesCategoryCriterion(tags, filter.categories);
}

function matchesStates(
  state: CollectionState,
  card: Card,
  filter: CardFilter,
  ctx: CardFilterContext,
): boolean {
  if (!filter.states || filter.states.length === 0) return true;
  const kinds = getCardStateKinds(state, card, ctx);
  return filter.states.some((k) => kinds.has(k));
}

function matchesAgainCriteria(
  state: CollectionState,
  card: Card,
  perf: PerformanceCriterion,
  ctx: CardFilterContext,
): boolean {
  if (perf.minAgainCount === undefined && perf.failedWithinDays === undefined) return true;
  const again = countAgain(state, card, ctx, perf.failedWithinDays);
  if (perf.minAgainCount !== undefined && again.total < perf.minAgainCount) return false;
  return perf.failedWithinDays === undefined || again.recent > 0;
}

function matchesRetrievability(
  state: CollectionState,
  card: Card,
  perf: PerformanceCriterion,
  nowMs: number,
): boolean {
  if (perf.maxRetrievability === undefined) return true;
  const r = computeCardRetrievability(state, card, nowMs);
  return r !== undefined && r < perf.maxRetrievability;
}

function matchesPerformance(
  state: CollectionState,
  card: Card,
  perf: PerformanceCriterion | undefined,
  ctx: CardFilterContext,
): boolean {
  if (!perf) return true;
  if (perf.minLapses !== undefined && card.schedule.lapses < perf.minLapses) return false;
  if (!matchesAgainCriteria(state, card, perf, ctx)) return false;
  if (!matchesRetrievability(state, card, perf, ctx.nowMs)) return false;
  // `hardest` ranks reviewed cards only.
  const unreviewed = card.schedule.reps === 0 && card.schedule.lapses === 0;
  return perf.hardest === undefined || !unreviewed;
}

function cardMatches(
  state: CollectionState,
  card: Card,
  note: Note,
  filter: CardFilter,
  ctx: CardFilterContext,
): boolean {
  return (
    matchesCategories(card, note, filter, ctx) &&
    matchesStates(state, card, filter, ctx) &&
    matchesPerformance(state, card, filter.performance, ctx)
  );
}

/** The card's note when both its deck and its note are active (not archived). */
function activeNoteOf(state: CollectionState, card: Card): Note | undefined {
  const deck = state.decks.get(card.deck_id);
  if (!deck || deck.archived) return undefined;
  const note = state.notes.get(card.note_id);
  return note && !note.archived ? note : undefined;
}

/**
 * Cards matching `filter`, in canonical order: hardest-first when `performance.hardest` is set,
 * otherwise by card id. Cards of archived decks / notes never match.
 */
export function filterCards(
  state: CollectionState,
  filter: CardFilter,
  ctx: CardFilterContext,
): Card[] {
  const deckSet = filter.deckIds && filter.deckIds.length > 0 ? new Set(filter.deckIds) : null;
  const matched: Card[] = [];
  for (const card of state.cards.values()) {
    if (deckSet && !deckSet.has(card.deck_id)) continue;
    const note = activeNoteOf(state, card);
    if (!note) continue;
    // Suspended cards are never studied, even when the filter explicitly asks for them.
    if (ctx.excludeSuspended && isCardSuspended(state, card.id)) continue;
    if (!cardMatches(state, card, note, filter, ctx)) continue;
    matched.push(card);
  }
  const hardest = filter.performance?.hardest;
  if (hardest !== undefined) {
    matched.sort(compareHardestCards);
    return matched.slice(0, hardest);
  }
  matched.sort((a, b) => cmpStr(a.id, b.id));
  return matched;
}

/** Ids of the cards matching `filter` (see {@link filterCards}). */
export function filterCardIds(
  state: CollectionState,
  filter: CardFilter,
  ctx: CardFilterContext,
): Set<string> {
  return new Set(filterCards(state, filter, ctx).map((c) => c.id));
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
    .sort((a, b) => cmpStr(a.tag, b.tag));
}
