import { compareHlc } from '../hlc.ts';
import { isCardSuspended, type CollectionState } from '../events/replay.ts';
import type {
  PracticeRecordedPayload,
  StudySetMode,
  StudySetSavedPayload,
  UnknownEvent,
} from '../events/types.ts';
import { getNextStudyDayRolloverMs, getStudyDayIndex } from '../fsrs/scheduler.ts';
import type { Card, PracticeOrder, ReviewRating } from '../model/types.ts';
import type { StatsFilter } from '../stats/stats.ts';
import {
  compareHardestCards,
  filterCardIds,
  filterCards,
  isCardFilterEmpty,
  keepHardestDueToday,
  normalizeCardFilter,
  splitHardestCriterion,
  type CardFilter,
  type CardFilterContext,
} from './filter.ts';
import { compareSeededRandom, compareSourceOrder } from './card-order.ts';
import { resolveDayStartHour, type StudyCounts, type StudyQueueResult } from './queue.ts';
import { compareCodeUnits } from '../compare.ts';

/**
 * Phase 9 Study Sets and custom study (blueprint §15 Phase 9), all derived from the event log.
 *
 * `StudySetSaved`, `StudySetDeleted`, `PracticeRecorded`, `PracticeUndone` and
 * `NewCardLimitRaised` are log-retained: replay keeps them verbatim in `state.unknownEvents`
 * (exactly what an older build does with them), and the functions here fold them with
 * order-independent rules (HLC last-writer-wins, id-deduplicated sets), so any delivery order,
 * chunking or snapshot hydration gives the same answer on every device.
 *
 * Nothing here touches FSRS: practice answers never reach `replaySingleCard`, so card schedules,
 * due dates, daily limits and the scheduled queue are identical with or without them.
 */

export const STUDY_SET_NAME_MAX_LENGTH = 80;
/** Longest review-ahead window custom study accepts. */
export const MAX_REVIEW_AHEAD_DAYS = 365;
export { MAX_EXTRA_NEW_CARDS } from './new-card-raises.ts';

const MS_PER_DAY = 86_400_000;

/** The set stored under `key`, created on first use. */
function setFor<K>(map: Map<K, Set<string>>, key: K): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** Keeps the first card of each note, in order; later siblings are buried. */
function takeOnePerNote(cards: Iterable<Card>, buriedNoteIds: Set<string>): Card[] {
  const queue: Card[] = [];
  const queuedNotes = new Set<string>();
  for (const card of cards) {
    if (queuedNotes.has(card.note_id)) {
      buriedNoteIds.add(card.note_id);
      continue;
    }
    queuedNotes.add(card.note_id);
    queue.push(card);
  }
  return queue;
}

function asRecord(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Total order on events used for LWW: HLC first, event id as the tiebreak. */
function compareEventOrder(a: UnknownEvent, b: UnknownEvent): number {
  return compareHlc(a.hlc, b.hlc) || compareCodeUnits(a.id, b.id);
}

// ---------------------------------------------------------------------------------------------
// Study Sets
// ---------------------------------------------------------------------------------------------

export interface StudySet {
  id: string;
  name: string;
  /** Normalized filter (decks, categories, states, performance). */
  filter: CardFilter;
  /** `schedule` = only due cards with the normal FSRS queue; `practice` = every match, no FSRS. */
  mode: StudySetMode;
}

/** Trims and collapses whitespace; `undefined` when nothing is left. */
export function normalizeStudySetName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, STUDY_SET_NAME_MAX_LENGTH).trim();
  return name.length > 0 ? name : undefined;
}

function isStudySetMode(value: unknown): value is StudySetMode {
  return value === 'schedule' || value === 'practice';
}

/**
 * Builds a canonical `StudySetSaved` payload (only the given fields; each is its own LWW
 * register). Returns `undefined` when nothing valid would be saved.
 */
export function buildStudySetSavedPayload(input: {
  setId: string;
  name?: string;
  filter?: unknown;
  mode?: StudySetMode;
}): StudySetSavedPayload | undefined {
  if (!input.setId) return undefined;
  const out: StudySetSavedPayload = { set_id: input.setId };
  if (input.name !== undefined) {
    const name = normalizeStudySetName(input.name);
    if (name === undefined) return undefined;
    out.name = name;
  }
  if (input.filter !== undefined) out.filter = normalizeCardFilter(input.filter);
  if (input.mode !== undefined) {
    if (!isStudySetMode(input.mode)) return undefined;
    out.mode = input.mode;
  }
  return Object.keys(out).length > 1 ? out : undefined;
}

interface StudySetRegisters {
  name?: { ev: UnknownEvent; value: string };
  filter?: { ev: UnknownEvent; value: CardFilter };
  mode?: { ev: UnknownEvent; value: StudySetMode };
  lastSave?: UnknownEvent;
  lastDelete?: UnknownEvent;
}

function newer(current: UnknownEvent | undefined, ev: UnknownEvent): boolean {
  return current === undefined || compareEventOrder(ev, current) > 0;
}

/** Applies the fields a `StudySetSaved` carries to their LWW registers; false when it carries none. */
function applyStudySetSave(r: StudySetRegisters, ev: UnknownEvent, p: Record<string, unknown>) {
  let touched = false;
  const name = normalizeStudySetName(p['name']);
  if (name !== undefined) {
    touched = true;
    if (newer(r.name?.ev, ev)) r.name = { ev, value: name };
  }
  if (p['filter'] !== undefined) {
    touched = true;
    if (newer(r.filter?.ev, ev)) r.filter = { ev, value: normalizeCardFilter(p['filter']) };
  }
  const mode = p['mode'];
  if (isStudySetMode(mode)) {
    touched = true;
    if (newer(r.mode?.ev, ev)) r.mode = { ev, value: mode };
  }
  // A background category rewrite never makes a set live (see `tag_rewrite`).
  if (touched && p['tag_rewrite'] !== true && newer(r.lastSave, ev)) r.lastSave = ev;
}

function applyStudySetEvent(regs: Map<string, StudySetRegisters>, ev: UnknownEvent): void {
  const p = asRecord(ev.payload);
  const setId = nonEmptyString(p?.['set_id']);
  if (!p || setId === undefined || typeof ev.hlc !== 'string') return;
  let r = regs.get(setId);
  if (!r) {
    r = {};
    regs.set(setId, r);
  }
  if (ev.type === 'StudySetDeleted') {
    if (newer(r.lastDelete, ev)) r.lastDelete = ev;
  } else {
    applyStudySetSave(r, ev, p);
  }
}

/** The set its registers describe, or `undefined` when never saved or deleted since. */
function liveStudySet(id: string, r: StudySetRegisters): StudySet | undefined {
  if (!r.lastSave) return undefined;
  if (r.lastDelete && compareEventOrder(r.lastDelete, r.lastSave) > 0) return undefined;
  return {
    id,
    name: r.name?.value ?? 'Untitled study set',
    filter: r.filter?.value ?? {},
    mode: r.mode?.value ?? 'schedule',
  };
}

/**
 * Every live Study Set, sorted by name (code-point order) then id. Per-field LWW by HLC; a set is
 * deleted while its newest `StudySetDeleted` is newer than its newest user `StudySetSaved` (one
 * without `tag_rewrite`).
 */
export function listStudySets(state: CollectionState): StudySet[] {
  const regs = new Map<string, StudySetRegisters>();
  for (const ev of state.unknownEvents) {
    if (ev.type === 'StudySetSaved' || ev.type === 'StudySetDeleted') applyStudySetEvent(regs, ev);
  }
  const out: StudySet[] = [];
  for (const [id, r] of regs) {
    const set = liveStudySet(id, r);
    if (set) out.push(set);
  }
  out.sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Practice (cram) records
// ---------------------------------------------------------------------------------------------

export interface PracticeRecord {
  practiceId: string;
  sessionId: string;
  cardId: string;
  rating: ReviewRating;
  practicedAt: number;
  hlc: string;
}

function isRating(value: unknown): value is ReviewRating {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function undonePracticeIds(state: CollectionState): Set<string> {
  const undone = new Set<string>();
  for (const ev of state.unknownEvents) {
    if (ev.type !== 'PracticeUndone') continue;
    const id = nonEmptyString(asRecord(ev.payload)?.['practice_id']);
    if (id !== undefined) undone.add(id);
  }
  return undone;
}

/** A well-formed `PracticeRecorded` as a record, else `undefined`. */
function parsePracticeRecord(ev: UnknownEvent): PracticeRecord | undefined {
  const p = asRecord(ev.payload) as Partial<Record<keyof PracticeRecordedPayload, unknown>>;
  const practiceId = nonEmptyString(p?.practice_id);
  const sessionId = nonEmptyString(p?.session_id);
  const cardId = nonEmptyString(p?.card_id);
  const practicedAt = p?.practiced_at;
  if (practiceId === undefined || sessionId === undefined || cardId === undefined) return undefined;
  if (!isRating(p.rating) || typeof practicedAt !== 'number' || !Number.isFinite(practicedAt)) {
    return undefined;
  }
  return { practiceId, sessionId, cardId, rating: p.rating, practicedAt, hlc: ev.hlc };
}

/**
 * Active practice answers (not undone), deduplicated by `practice_id`, ordered by
 * `(practiced_at, hlc, practice_id)` like reviews (§4.1). Optionally only one session's.
 */
export function getPracticeRecords(
  state: CollectionState,
  options: { sessionId?: string } = {},
): PracticeRecord[] {
  const undone = undonePracticeIds(state);
  const byId = new Map<string, PracticeRecord>();
  for (const ev of state.unknownEvents) {
    if (ev.type !== 'PracticeRecorded') continue;
    const rec = parsePracticeRecord(ev);
    if (!rec || undone.has(rec.practiceId)) continue;
    if (options.sessionId !== undefined && rec.sessionId !== options.sessionId) continue;
    const prev = byId.get(rec.practiceId);
    // A duplicated practice id keeps one deterministic winner (lowest HLC).
    if (!prev || compareHlc(rec.hlc, prev.hlc) < 0) byId.set(rec.practiceId, rec);
  }
  return [...byId.values()].sort(comparePracticeRecords);
}

export function comparePracticeRecords(a: PracticeRecord, b: PracticeRecord): number {
  return (
    a.practicedAt - b.practicedAt ||
    compareHlc(a.hlc, b.hlc) ||
    compareCodeUnits(a.practiceId, b.practiceId)
  );
}

// ---------------------------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------------------------

interface QueueScope {
  /** Study deck selection (`undefined` = every deck). */
  deckId?: string;
  nowMs: number;
  tzOffsetMinutes: number;
  dayStartHour?: number;
}

function dayStartFor(state: CollectionState, deckId: string, globalHour: number): number {
  return resolveDayStartHour(state.decks.get(deckId)?.settings.day_start_hour, globalHour);
}

/** noteId -> ids of its cards with an active review on today's study day (sibling burying). */
function cardsReviewedTodayByNote(
  state: CollectionState,
  scope: QueueScope,
): Map<string, Set<string>> {
  const globalHour = scope.dayStartHour ?? state.preferences.day_start_hour;
  const out = new Map<string, Set<string>>();
  for (const [cardId, reviews] of state.reviewsByCard) {
    const card = state.cards.get(cardId);
    if (!card) continue;
    const dayStart = dayStartFor(state, card.deck_id, globalHour);
    const today = getStudyDayIndex(scope.nowMs, scope.tzOffsetMinutes, dayStart);
    for (const r of reviews) {
      if (state.undoneReviewIds.has(r.review_id)) continue;
      if (getStudyDayIndex(r.reviewed_at, scope.tzOffsetMinutes, dayStart) !== today) continue;
      setFor(out, card.note_id).add(card.id);
      break;
    }
  }
  return out;
}

function hasOtherCard(set: ReadonlySet<string> | undefined, cardId: string): boolean {
  if (!set) return false;
  for (const id of set) if (id !== cardId) return true;
  return false;
}

function countByState(queue: readonly Card[]): StudyCounts {
  const counts: StudyCounts = { new: 0, learning: 0, due: 0, total: queue.length };
  for (const c of queue) {
    if (c.schedule.state === 0) counts.new += 1;
    else if (c.schedule.state === 2) counts.due += 1;
    else counts.learning += 1;
  }
  return counts;
}

export interface PracticeQueueOptions extends QueueScope {
  filter: CardFilter;
  /** The practice session whose answers advance the queue. */
  sessionId: string;
  /**
   * Study-screen practice order. Omitted = the filter's canonical order (hardest first for a
   * hardest filter, else card id). 
andom is seeded by the session id (reproducible).
   */
  order?: PracticeOrder;
}

/**
 * Practice cards in order: deck = by deck id, then source order (note order, Recognition
 * before Production, variant); 
andom = seeded shuffle (same seed, same order); hardest = most
 * lapses, lowest stability, highest difficulty first.
 */
export function sortPracticeCards(
  state: CollectionState,
  cards: readonly Card[],
  order: PracticeOrder,
  seed: string,
): Card[] {
  const out = [...cards];
  if (order === 'hardest') return out.sort(compareHardestCards);
  if (order === 'random') return out.sort(compareSeededRandom(`practice:${seed}`));
  const bySource = compareSourceOrder(state);
  return out.sort((a, b) => compareCodeUnits(a.deck_id, b.deck_id) || bySource(a, b));
}

export interface PracticeQueueResult extends StudyQueueResult {
  /** Cards answered Hard / Good / Easy in this session (done). */
  practiced: number;
  /** Cards whose latest answer in this session was Again (shown again at the end). */
  again: number;
}

/**
 * Cram / practice queue for a filter: every matching card (suspended cards excluded), ignoring
 * due dates and daily limits, in `order` (default: the filter's canonical order, hardest first for
 * `hardest`).
 * A card leaves the queue once answered Hard/Good/Easy in this session; Again sends it to the
 * back. Sibling burying applies: at most one card per note per session, and a note's other cards
 * are buried when one of its cards was reviewed today or practiced in this session.
 */
export function buildPracticeQueue(
  state: CollectionState,
  options: PracticeQueueOptions,
): PracticeQueueResult {
  const ctx: CardFilterContext = {
    nowMs: options.nowMs,
    tzOffsetMinutes: options.tzOffsetMinutes,
    ...(options.dayStartHour === undefined ? {} : { dayStartHour: options.dayStartHour }),
    excludeSuspended: true,
  };
  const matched = filterCards(state, options.filter, ctx).filter(
    (c) => options.deckId === undefined || c.deck_id === options.deckId,
  );
  const candidates =
    options.order === undefined
      ? matched
      : sortPracticeCards(state, matched, options.order, options.sessionId);

  const { latest, practicedByNote } = practiceSessionState(state, options.sessionId);
  const reviewedToday = cardsReviewedTodayByNote(state, options);

  const pending: Card[] = [];
  const againCards: Array<{ card: Card; rec: PracticeRecord }> = [];
  const buriedNoteIds = new Set<string>();
  let practiced = 0;
  for (const card of candidates) {
    if (
      hasOtherCard(reviewedToday.get(card.note_id), card.id) ||
      hasOtherCard(practicedByNote.get(card.note_id), card.id)
    ) {
      buriedNoteIds.add(card.note_id);
      continue;
    }
    const rec = latest.get(card.id);
    if (!rec) pending.push(card);
    else if (rec.rating === 1) againCards.push({ card, rec });
    else practiced += 1;
  }
  againCards.sort((a, b) => comparePracticeRecords(a.rec, b.rec));

  const queue = takeOnePerNote([...pending, ...againCards.map((a) => a.card)], buriedNoteIds);
  return {
    queue,
    counts: countByState(queue),
    buriedNoteIds,
    practiced,
    again: againCards.length,
  };
}

/** One session's latest answer per card, and the cards practiced per note (sibling burying). */
function practiceSessionState(state: CollectionState, sessionId: string) {
  const latest = new Map<string, PracticeRecord>();
  const practicedByNote = new Map<string, Set<string>>();
  for (const rec of getPracticeRecords(state, { sessionId })) {
    latest.set(rec.cardId, rec);
    const card = state.cards.get(rec.cardId);
    if (card) setFor(practicedByNote, card.note_id).add(card.id);
  }
  return { latest, practicedByNote };
}

export interface ReviewAheadOptions extends QueueScope {
  /** Review cards due before the end of today + `days` study days (1..365). */
  days: number;
  filter?: CardFilter;
}

/**
 * Custom study "review ahead": review cards due within the next `days` study days (today's due
 * cards included) plus learning cards due now, earliest due first. Answers are normal
 * `ReviewRecorded` reviews (FSRS handles the early review); daily review limits are not applied.
 * New cards are never included. Suspended cards are excluded and sibling burying applies exactly
 * as in `buildStudyQueue`.
 */
export function buildReviewAheadQueue(
  state: CollectionState,
  options: ReviewAheadOptions,
): StudyQueueResult {
  const days = Math.max(1, Math.min(MAX_REVIEW_AHEAD_DAYS, Math.floor(options.days) || 1));
  const sort: AheadSort = {
    learning: [],
    reviews: [],
    buriedNoteIds: new Set<string>(),
    nextLearningDueAt: undefined,
  };
  const { allowed, hardest } = aheadAllowedCardIds(state, options);
  const reviewedToday = cardsReviewedTodayByNote(state, options);
  const globalHour = options.dayStartHour ?? state.preferences.day_start_hour;
  for (const card of state.cards.values()) {
    if (!isAheadCandidate(state, card, options.deckId, allowed)) continue;
    const dayStart = dayStartFor(state, card.deck_id, globalHour);
    const endOfToday = getNextStudyDayRolloverMs(options.nowMs, options.tzOffsetMinutes, dayStart);
    const window = { nowMs: options.nowMs, endOfToday, aheadUntil: endOfToday + days * MS_PER_DAY };
    placeAheadCard(sort, card, reviewedToday.get(card.note_id), window);
  }
  if (hardest !== undefined) {
    keepHardestAhead(
      sort,
      hardest,
      aheadSelectionReviewedToday(state, reviewedToday, options, allowed),
    );
  }
  const byDue = (a: Card, b: Card) =>
    a.schedule.due - b.schedule.due || compareCodeUnits(a.id, b.id);
  sort.learning.sort(byDue);
  sort.reviews.sort(byDue);

  const queue = takeOnePerNote([...sort.learning, ...sort.reviews], sort.buriedNoteIds);
  const result: StudyQueueResult = {
    queue,
    counts: countByState(queue),
    buriedNoteIds: sort.buriedNoteIds,
  };
  if (sort.nextLearningDueAt !== undefined && queue.length === 0) {
    result.nextLearningDueAt = sort.nextLearningDueAt;
  }
  return result;
}

/** Review-ahead buckets while scanning the collection. */
interface AheadSort {
  learning: Card[];
  reviews: Card[];
  buriedNoteIds: Set<string>;
  nextLearningDueAt: number | undefined;
}

/** The filter's allowed card ids without its `hardest` cap, which ranks the in-window cards only. */
function aheadAllowedCardIds(
  state: CollectionState,
  options: ReviewAheadOptions,
): { allowed: Set<string> | undefined; hardest: number | undefined } {
  if (options.filter === undefined || isCardFilterEmpty(options.filter)) {
    return { allowed: undefined, hardest: undefined };
  }
  const { base, hardest } = splitHardestCriterion(options.filter);
  if (isCardFilterEmpty(base)) return { allowed: undefined, hardest };
  const allowed = filterCardIds(state, base, {
    nowMs: options.nowMs,
    tzOffsetMinutes: options.tzOffsetMinutes,
    ...(options.dayStartHour === undefined ? {} : { dayStartHour: options.dayStartHour }),
    excludeSuspended: true,
  });
  return { allowed, hardest };
}

/** The selection's cards (scope and filter without `hardest`) with an active review today. */
function aheadSelectionReviewedToday(
  state: CollectionState,
  reviewedToday: ReadonlyMap<string, ReadonlySet<string>>,
  options: ReviewAheadOptions,
  allowed: ReadonlySet<string> | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const cardIds of reviewedToday.values()) {
    for (const cardId of cardIds) {
      const card = state.cards.get(cardId);
      if (card && isAheadCandidate(state, card, options.deckId, allowed)) out.add(cardId);
    }
  }
  return out;
}

/**
 * Keeps the `hardest` hardest of the cards inside the review-ahead window, with the selection's
 * cards reviewed today holding their slots, so answering one never frees a slot for the next.
 */
function keepHardestAhead(
  sort: AheadSort,
  hardest: number,
  selectionReviewedToday: ReadonlySet<string>,
): void {
  const keep = keepHardestDueToday(
    [...sort.learning, ...sort.reviews],
    hardest,
    selectionReviewedToday,
  );
  sort.learning = sort.learning.filter((c) => keep.has(c.id));
  sort.reviews = sort.reviews.filter((c) => keep.has(c.id));
}

/** A studied (not new), unsuspended card of an active deck and note inside the selection. */
function isAheadCandidate(
  state: CollectionState,
  card: Card,
  deckId: string | undefined,
  allowed: ReadonlySet<string> | undefined,
): boolean {
  if (deckId !== undefined && card.deck_id !== deckId) return false;
  if (allowed !== undefined && !allowed.has(card.id)) return false;
  if (card.schedule.state === 0 || card.empty === true || isCardSuspended(state, card.id)) {
    return false;
  }
  const deck = state.decks.get(card.deck_id);
  const note = state.notes.get(card.note_id);
  return Boolean(deck && !deck.archived && note && !note.archived);
}

/**
 * Learning cards: due now (else the next intraday due time), buried when a sibling was reviewed
 * today. Review cards: due before `aheadUntil`, buried when any card of the note was reviewed today.
 */
function placeAheadCard(
  sort: AheadSort,
  card: Card,
  touched: ReadonlySet<string> | undefined,
  window: { nowMs: number; endOfToday: number; aheadUntil: number },
): void {
  const s = card.schedule;
  const isLearning = s.state === 1 || s.state === 3;
  if (isLearning ? hasOtherCard(touched, card.id) : touched !== undefined) {
    sort.buriedNoteIds.add(card.note_id);
    return;
  }
  if (!isLearning) {
    if (s.due < window.aheadUntil) sort.reviews.push(card);
    return;
  }
  if (s.due <= window.nowMs) sort.learning.push(card);
  else if (s.due < window.endOfToday) {
    sort.nextLearningDueAt = Math.min(sort.nextLearningDueAt ?? s.due, s.due);
  }
}

// ---------------------------------------------------------------------------------------------
// Stats bridge
// ---------------------------------------------------------------------------------------------

/**
 * Compiles a Phase 9 `CardFilter` into the Phase 11 `StatsFilter`, so the Stats screen and MCP
 * `get_stats` select exactly the cards Browse and Study select for the same filter. Suspended cards
 * stay in (the stats forecast drops them itself).
 */
export function cardFilterToStatsFilter(
  state: CollectionState,
  rawFilter: unknown,
  ctx: CardFilterContext,
): StatsFilter {
  const filter = normalizeCardFilter(rawFilter);
  const out: StatsFilter = {};
  if (filter.deckIds) out.deckIds = filter.deckIds;
  const cardLevel: CardFilter = { ...filter };
  delete cardLevel.deckIds;
  if (!isCardFilterEmpty(cardLevel)) {
    const ids = filterCardIds(state, filter, { ...ctx, excludeSuspended: false });
    out.includeCard = (card) => ids.has(card.id);
  }
  return out;
}
