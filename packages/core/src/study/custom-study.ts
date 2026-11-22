import { compareHlc } from '../hlc.ts';
import { isCardSuspended, type CollectionState } from '../events/replay.ts';
import type {
  PracticeRecordedPayload,
  StudySetMode,
  StudySetSavedPayload,
  UnknownEvent,
} from '../events/types.ts';
import { getNextStudyDayRolloverMs, getStudyDayIndex } from '../fsrs/scheduler.ts';
import type { Card, ReviewRating } from '../model/types.ts';
import type { StatsFilter } from '../stats/stats.ts';
import {
  filterCardIds,
  filterCards,
  isCardFilterEmpty,
  normalizeCardFilter,
  type CardFilter,
  type CardFilterContext,
} from './filter.ts';
import { isRaiseOnDay, listNewCardRaises } from './new-card-raises.ts';
import { resolveDayStartHour, type StudyCounts, type StudyQueueResult } from './queue.ts';

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
export const STUDY_SET_MODES: readonly StudySetMode[] = ['schedule', 'practice'];
/** Longest review-ahead window custom study accepts. */
export const MAX_REVIEW_AHEAD_DAYS = 365;
export { MAX_EXTRA_NEW_CARDS } from './new-card-raises.ts';

const MS_PER_DAY = 86_400_000;

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  return compareHlc(a.hlc, b.hlc) || cmpStr(a.id, b.id);
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

/**
 * Every live Study Set, sorted by name (code-point order) then id. Per-field LWW by HLC; a set is
 * deleted while its newest `StudySetDeleted` is newer than its newest `StudySetSaved`.
 */
export function listStudySets(state: CollectionState): StudySet[] {
  const regs = new Map<string, StudySetRegisters>();
  for (const ev of state.unknownEvents) {
    if (ev.type !== 'StudySetSaved' && ev.type !== 'StudySetDeleted') continue;
    const p = asRecord(ev.payload);
    const setId = nonEmptyString(p?.['set_id']);
    if (!p || setId === undefined || typeof ev.hlc !== 'string') continue;
    let r = regs.get(setId);
    if (!r) {
      r = {};
      regs.set(setId, r);
    }
    if (ev.type === 'StudySetDeleted') {
      if (newer(r.lastDelete, ev)) r.lastDelete = ev;
      continue;
    }
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
    if (isStudySetMode(p['mode'])) {
      touched = true;
      if (newer(r.mode?.ev, ev)) r.mode = { ev, value: p['mode'] };
    }
    if (touched && newer(r.lastSave, ev)) r.lastSave = ev;
  }

  const out: StudySet[] = [];
  for (const [id, r] of regs) {
    if (!r.lastSave) continue;
    if (r.lastDelete && compareEventOrder(r.lastDelete, r.lastSave) > 0) continue;
    out.push({
      id,
      name: r.name?.value ?? 'Untitled study set',
      filter: r.filter?.value ?? {},
      mode: r.mode?.value ?? 'schedule',
    });
  }
  out.sort((a, b) => cmpStr(a.name, b.name) || cmpStr(a.id, b.id));
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

/**
 * Active practice answers (not undone), deduplicated by `practice_id`, ordered by
 * `(practiced_at, hlc, practice_id)` like reviews (§4.1). Optionally only one session's.
 */
export function getPracticeRecords(
  state: CollectionState,
  options: { sessionId?: string } = {},
): PracticeRecord[] {
  const undone = new Set<string>();
  for (const ev of state.unknownEvents) {
    if (ev.type !== 'PracticeUndone') continue;
    const id = nonEmptyString(asRecord(ev.payload)?.['practice_id']);
    if (id !== undefined) undone.add(id);
  }
  const byId = new Map<string, PracticeRecord>();
  for (const ev of state.unknownEvents) {
    if (ev.type !== 'PracticeRecorded') continue;
    const p = asRecord(ev.payload) as Partial<Record<keyof PracticeRecordedPayload, unknown>>;
    const practiceId = nonEmptyString(p?.practice_id);
    const sessionId = nonEmptyString(p?.session_id);
    const cardId = nonEmptyString(p?.card_id);
    const practicedAt = p?.practiced_at;
    if (practiceId === undefined || sessionId === undefined || cardId === undefined) continue;
    if (!isRating(p.rating) || typeof practicedAt !== 'number' || !Number.isFinite(practicedAt)) {
      continue;
    }
    if (undone.has(practiceId)) continue;
    if (options.sessionId !== undefined && sessionId !== options.sessionId) continue;
    const rec: PracticeRecord = {
      practiceId,
      sessionId,
      cardId,
      rating: p.rating,
      practicedAt,
      hlc: ev.hlc,
    };
    const prev = byId.get(practiceId);
    // A duplicated practice id keeps one deterministic winner (lowest HLC).
    if (!prev || compareHlc(rec.hlc, prev.hlc) < 0) byId.set(practiceId, rec);
  }
  return [...byId.values()].sort(comparePracticeRecords);
}

export function comparePracticeRecords(a: PracticeRecord, b: PracticeRecord): number {
  return (
    a.practicedAt - b.practicedAt || compareHlc(a.hlc, b.hlc) || cmpStr(a.practiceId, b.practiceId)
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
      let set = out.get(card.note_id);
      if (!set) {
        set = new Set();
        out.set(card.note_id, set);
      }
      set.add(card.id);
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
}

export interface PracticeQueueResult extends StudyQueueResult {
  /** Cards answered Hard / Good / Easy in this session (done). */
  practiced: number;
  /** Cards whose latest answer in this session was Again (shown again at the end). */
  again: number;
}

/**
 * Cram / practice queue for a filter: every matching card (suspended cards excluded), ignoring
 * due dates and daily limits, in the filter's canonical order (hardest first for `hardest`).
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
    ...(options.dayStartHour !== undefined ? { dayStartHour: options.dayStartHour } : {}),
    excludeSuspended: true,
  };
  const candidates = filterCards(state, options.filter, ctx).filter(
    (c) => options.deckId === undefined || c.deck_id === options.deckId,
  );

  const latest = new Map<string, PracticeRecord>();
  const practicedByNote = new Map<string, Set<string>>();
  for (const rec of getPracticeRecords(state, { sessionId: options.sessionId })) {
    latest.set(rec.cardId, rec);
    const card = state.cards.get(rec.cardId);
    if (!card) continue;
    let set = practicedByNote.get(card.note_id);
    if (!set) {
      set = new Set();
      practicedByNote.set(card.note_id, set);
    }
    set.add(card.id);
  }
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
    if (rec && rec.rating !== 1) {
      practiced += 1;
    } else if (rec) {
      againCards.push({ card, rec });
    } else {
      pending.push(card);
    }
  }
  againCards.sort((a, b) => comparePracticeRecords(a.rec, b.rec));

  const queue: Card[] = [];
  const queuedNotes = new Set<string>();
  for (const card of [...pending, ...againCards.map((a) => a.card)]) {
    if (queuedNotes.has(card.note_id)) {
      buriedNoteIds.add(card.note_id);
      continue;
    }
    queuedNotes.add(card.note_id);
    queue.push(card);
  }
  return {
    queue,
    counts: countByState(queue),
    buriedNoteIds,
    practiced,
    again: againCards.length,
  };
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
  const globalHour = options.dayStartHour ?? state.preferences.day_start_hour;
  const allowed =
    options.filter !== undefined && !isCardFilterEmpty(options.filter)
      ? filterCardIds(state, options.filter, {
          nowMs: options.nowMs,
          tzOffsetMinutes: options.tzOffsetMinutes,
          ...(options.dayStartHour !== undefined ? { dayStartHour: options.dayStartHour } : {}),
          excludeSuspended: true,
        })
      : undefined;
  const reviewedToday = cardsReviewedTodayByNote(state, options);

  const learning: Card[] = [];
  const reviews: Card[] = [];
  const buriedNoteIds = new Set<string>();
  let nextLearningDueAt: number | undefined;
  for (const card of state.cards.values()) {
    if (options.deckId !== undefined && card.deck_id !== options.deckId) continue;
    if (allowed !== undefined && !allowed.has(card.id)) continue;
    if (isCardSuspended(state, card.id)) continue;
    const deck = state.decks.get(card.deck_id);
    const note = state.notes.get(card.note_id);
    if (!deck || deck.archived || !note || note.archived) continue;
    const s = card.schedule;
    if (s.state === 0) continue;
    const touched = reviewedToday.get(card.note_id);
    const dayStart = dayStartFor(state, card.deck_id, globalHour);
    const endOfToday = getNextStudyDayRolloverMs(options.nowMs, options.tzOffsetMinutes, dayStart);
    if (s.state === 1 || s.state === 3) {
      if (hasOtherCard(touched, card.id)) {
        buriedNoteIds.add(card.note_id);
        continue;
      }
      if (s.due <= options.nowMs) learning.push(card);
      else if (s.due < endOfToday && (nextLearningDueAt === undefined || s.due < nextLearningDueAt))
        nextLearningDueAt = s.due;
      continue;
    }
    if (touched) {
      buriedNoteIds.add(card.note_id);
      continue;
    }
    if (s.due < endOfToday + days * MS_PER_DAY) reviews.push(card);
  }
  const byDue = (a: Card, b: Card) => a.schedule.due - b.schedule.due || cmpStr(a.id, b.id);
  learning.sort(byDue);
  reviews.sort(byDue);

  const queue: Card[] = [];
  const queuedNotes = new Set<string>();
  for (const card of [...learning, ...reviews]) {
    if (queuedNotes.has(card.note_id)) {
      buriedNoteIds.add(card.note_id);
      continue;
    }
    queuedNotes.add(card.note_id);
    queue.push(card);
  }
  const result: StudyQueueResult = { queue, counts: countByState(queue), buriedNoteIds };
  if (nextLearningDueAt !== undefined && queue.length === 0) {
    result.nextLearningDueAt = nextLearningDueAt;
  }
  return result;
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

/**
 * Extra new cards custom study granted today by raises whose deck scope includes `deckId`
 * (`NewCardLimitRaised`, kept verbatim in `unknownEvents`), whatever their category scope. A raise
 * counts on the study day containing its `raised_at` (in the raising device's offset, with the
 * deck's rollover hour). Raises add up; a repeated `raise_id` counts once (its largest value), so
 * the result is independent of delivery order and duplicates.
 *
 * This is the gross grant: a raise shared by several decks is counted in full for each of them.
 * {@link buildStudyQueue} spends each raise once, as one pool for its whole scope.
 */
export function getExtraNewCardsToday(
  state: CollectionState,
  deckId: string,
  nowMs: number,
  tzOffsetMinutes: number,
  dayStartHour: number,
): number {
  const today = getStudyDayIndex(nowMs, tzOffsetMinutes, dayStartHour);
  let extra = 0;
  for (const r of listNewCardRaises(state)) {
    if (r.deckIds !== null && !r.deckIds.has(deckId)) continue;
    if (!isRaiseOnDay(r, today, tzOffsetMinutes, dayStartHour)) continue;
    extra += r.extra;
  }
  return extra;
}
