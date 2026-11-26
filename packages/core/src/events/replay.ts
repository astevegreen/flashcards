import {
  applyReviewToSchedule,
  createInitialSchedule,
  DEFAULT_FSRS_CONFIG,
} from '../fsrs/scheduler.ts';
import { compareHlc, formatHlc, tickHlc, type HlcState } from '../hlc.ts';
import { deriveCardId, uuidv7 } from '../ids.ts';
import { normalizeLanguage } from '../languages/normalize.ts';
import { noteField } from '../model/note-fields.ts';
import { hasOptionalCardRules, layoutRuleMet } from '../model/optional-cards.ts';
import { BUILTIN_LAYOUTS, BUILTIN_NOTE_TYPES } from '../model/presets.ts';
import { extractClozeNumbers } from '../parsers/cloze.ts';
import {
  DEFAULT_COLLECTION_PREFERENCES,
  DEFAULT_DECK_SETTINGS,
  type Card,
  type CollectionPreferences,
  type Course,
  type Deck,
  type DeckFSRSParamsVersion,
  type DeckSettings,
  type FSRSParamsConfig,
  type Layout,
  type MediaEntry,
  type Note,
  type NoteType,
  type Page,
  type ReviewRecord,
  type SourceRef,
} from '../model/types.ts';
import { applySuspensionRegister, isCardSuspendedIn } from './suspension.ts';
import { applyTagAddRegisters, canonicalizeNoteTags, noteHasTagAdds } from './tag-adds.ts';
import {
  isKnownEventType,
  type DeckFSRSParamsChangedPayload,
  type EventPayloadMap,
  type FlashEvent,
  type KnownEvent,
  type KnownEventType,
  type UnknownEvent,
} from './types.ts';
import { isApplicableEvent } from './validate.ts';
import { compareCodeUnits } from '../compare.ts';
import { addToMapSet, removeFromMapSet } from '../map-set.ts';

export interface PendingDeckPatch {
  name?: string;
  language?: string;
  archived?: boolean;
  settings: Partial<DeckSettings>;
  source?: SourceRef;
}

export interface PendingPagePatch {
  read_at?: number;
  source?: SourceRef;
}

export interface CollectionState {
  noteTypes: Map<string, NoteType>;
  layouts: Map<string, Layout>;
  decks: Map<string, Deck>;
  notes: Map<string, Note>;
  cards: Map<string, Card>;
  reviewsByCard: Map<string, ReviewRecord[]>;
  undoneReviewIds: Set<string>;
  deckFsrsParams: Map<string, DeckFSRSParamsVersion[]>;
  pages: Map<string, Page>;
  courses: Map<string, Course>;
  media: Map<string, MediaEntry>;
  preferences: CollectionPreferences;
  unknownEvents: UnknownEvent[];
  /** Per-field LWW HLC registry: fieldKey -> winning HLC string. */
  fieldHlcs: Map<string, string>;
  /** Pending/resolved archive tombstones for out-of-order NoteArchived/NoteRestored delivery. */
  noteArchivedState: Map<string, boolean>;
  /** Pending patches for out-of-order DeckSettingsChanged / SourceLinked before DeckCreated. */
  pendingDeckPatches: Map<string, PendingDeckPatch>;
  /** Pending patches for out-of-order PageRead / SourceLinked before PageUpserted. */
  pendingPagePatches: Map<string, PendingPagePatch>;
  /** Seen event IDs for idempotent event application since empty/snapshot hydration. */
  appliedEventIds: Set<string>;
  /** Secondary index: noteId -> derived cardIds (O(layouts_per_note) rebuilds). */
  cardIdsByNote: Map<string, Set<string>>;
  /** Secondary index: deckId -> derived cardIds (O(cards_in_deck) rebuilds & param updates). */
  cardIdsByDeck: Map<string, Set<string>>;
  /** Secondary index: deckId -> noteIds (O(notes_in_deck) deck card rebuilds). */
  noteIdsByDeck: Map<string, Set<string>>;
  /** Secondary index: reviewId -> cardId (O(1) ReviewUndone lookup). */
  reviewIdToCardId: Map<string, string>;
  /** Derived index: tts_key (`sha256(text + '\0' + voiceId)`) -> media content hash. */
  ttsMediaByKey: Map<string, string>;
  /** Derived index: tts_lang_key (`sha256(text + '\0' + normLang)`) -> media content hash. */
  ttsMediaByLangKey: Map<string, string>;
  /** Per-device max compacted seq hydrated from a snapshot (skips already-compacted events). */
  snapshotWatermarks: Map<string, number>;
  /** Total event count already compacted into a hydrated snapshot. */
  snapshotEventCount: number;
}

export interface ApplyEventsResult {
  state: CollectionState;
  appliedCount: number;
  changedCardIds: string[];
  removedCardIds: string[];
  maxHlc?: string;
}

/** Internal mutation collector used by `computeStatePatch` to emit compact Worker patches. */
export interface ApplyMutationCollector {
  noteTypeIds: Set<string>;
  layoutIds: Set<string>;
  deckIds: Set<string>;
  noteIds: Set<string>;
  reviewCardIds: Set<string>;
  addedUndoneReviewIds: Set<string>;
  fsrsDeckIds: Set<string>;
  pageIds: Set<string>;
  courseIds: Set<string>;
  mediaHashes: Set<string>;
  ttsKeys: Set<string>;
  ttsLangKeys: Set<string>;
  preferencesChanged: boolean;
  addedUnknownEvents: UnknownEvent[];
  fieldHlcKeys: Set<string>;
  noteArchivedKeys: Set<string>;
  pendingDeckPatchKeys: Set<string>;
  pendingPagePatchKeys: Set<string>;
  appliedEventIds: string[];
}

export function createMutationCollector(): ApplyMutationCollector {
  return {
    noteTypeIds: new Set(),
    layoutIds: new Set(),
    deckIds: new Set(),
    noteIds: new Set(),
    reviewCardIds: new Set(),
    addedUndoneReviewIds: new Set(),
    fsrsDeckIds: new Set(),
    pageIds: new Set(),
    courseIds: new Set(),
    mediaHashes: new Set(),
    ttsKeys: new Set(),
    ttsLangKeys: new Set(),
    preferencesChanged: false,
    addedUnknownEvents: [],
    fieldHlcKeys: new Set(),
    noteArchivedKeys: new Set(),
    pendingDeckPatchKeys: new Set(),
    pendingPagePatchKeys: new Set(),
    appliedEventIds: [],
  };
}

export function getTotalAppliedEventCount(state: CollectionState): number {
  return state.snapshotEventCount + state.appliedEventIds.size;
}

export function createEmptyState(): CollectionState {
  const noteTypes = new Map<string, NoteType>();
  for (const nt of BUILTIN_NOTE_TYPES) {
    noteTypes.set(nt.id, {
      ...nt,
      fields: nt.fields.map((f) => ({ ...f })),
    });
  }

  const layouts = new Map<string, Layout>();
  for (const l of BUILTIN_LAYOUTS) {
    layouts.set(l.id, {
      ...l,
      front_fields: [...l.front_fields],
      reveal_steps: l.reveal_steps.map((s) => [...s]),
    });
  }

  return {
    noteTypes,
    layouts,
    decks: new Map(),
    notes: new Map(),
    cards: new Map(),
    reviewsByCard: new Map(),
    undoneReviewIds: new Set(),
    deckFsrsParams: new Map(),
    pages: new Map(),
    courses: new Map(),
    media: new Map(),
    preferences: { ...DEFAULT_COLLECTION_PREFERENCES },
    unknownEvents: [],
    fieldHlcs: new Map(),
    noteArchivedState: new Map(),
    pendingDeckPatches: new Map(),
    pendingPagePatches: new Map(),
    appliedEventIds: new Set(),
    cardIdsByNote: new Map(),
    cardIdsByDeck: new Map(),
    noteIdsByDeck: new Map(),
    reviewIdToCardId: new Map(),
    ttsMediaByKey: new Map(),
    ttsMediaByLangKey: new Map(),
    snapshotWatermarks: new Map(),
    snapshotEventCount: 0,
  };
}

function setCardInState(state: CollectionState, card: Card): void {
  const prev = state.cards.get(card.id);
  if (prev && (prev.deck_id !== card.deck_id || prev.note_id !== card.note_id)) {
    removeFromMapSet(state.cardIdsByDeck, prev.deck_id, card.id);
    removeFromMapSet(state.cardIdsByNote, prev.note_id, card.id);
  }
  state.cards.set(card.id, card);
  addToMapSet(state.cardIdsByDeck, card.deck_id, card.id);
  addToMapSet(state.cardIdsByNote, card.note_id, card.id);
}

function deleteCardFromState(state: CollectionState, cardId: string): void {
  const existing = state.cards.get(cardId);
  if (!existing) return;
  state.cards.delete(cardId);
  removeFromMapSet(state.cardIdsByDeck, existing.deck_id, cardId);
  removeFromMapSet(state.cardIdsByNote, existing.note_id, cardId);
}

function shouldApplyLww(
  state: CollectionState,
  key: string,
  incomingHlc: string,
  collector?: ApplyMutationCollector,
): boolean {
  const existing = state.fieldHlcs.get(key);
  if (existing === undefined || compareHlc(incomingHlc, existing) >= 0) {
    state.fieldHlcs.set(key, incomingHlc);
    collector?.fieldHlcKeys.add(key);
    return true;
  }
  return false;
}

/**
 * Deterministic ordering of reviews per blueprint §4.1:
 * strictly by (reviewed_at, hlc, review_id) — never wall clock alone.
 */
export function compareReviewRecords(a: ReviewRecord, b: ReviewRecord): number {
  if (a.reviewed_at !== b.reviewed_at) {
    return a.reviewed_at - b.reviewed_at;
  }
  const hlcCmp = compareHlc(a.hlc, b.hlc);
  if (hlcCmp !== 0) {
    return hlcCmp;
  }
  if (a.review_id === b.review_id) return 0;
  return a.review_id < b.review_id ? -1 : 1;
}

/**
 * Resolves the FSRS parameters applicable to a specific review on a deck.
 * Blueprint §4.1: each review replays under the parameter version active at its timestamp
 * unless a newer DeckFSRSParamsChanged explicitly set `reschedule_existing`.
 */
export function resolveDeckFsrsConfig(
  state: CollectionState,
  deckId: string,
  reviewedAtMs: number,
  recordedVersion?: number,
): FSRSParamsConfig {
  const deck = state.decks.get(deckId);
  const versions = state.deckFsrsParams.get(deckId);

  if (!versions || versions.length === 0) {
    return {
      ...DEFAULT_FSRS_CONFIG,
      request_retention: deck?.settings.target_retention ?? DEFAULT_FSRS_CONFIG.request_retention,
    };
  }

  const initialRetention = deck?.initial_retention ?? DEFAULT_FSRS_CONFIG.request_retention;

  // Versions are kept sorted ascending by params_version.
  // The most recent version flagged `reschedule_existing` re-weights every review whose own
  // version is older than it; later non-rescheduling changes never undo that.
  let rescheduler: DeckFSRSParamsVersion | undefined;
  for (const v of versions) {
    if (v.reschedule_existing) rescheduler = v;
  }
  if (rescheduler) {
    const ownVersion = resolveOwnParamsVersion(versions, reviewedAtMs, recordedVersion);
    if (ownVersion < rescheduler.params_version) {
      return {
        ...DEFAULT_FSRS_CONFIG,
        ...rescheduler.params,
      };
    }
  }

  if (recordedVersion !== undefined) {
    if (recordedVersion === 0) {
      return {
        ...DEFAULT_FSRS_CONFIG,
        request_retention: initialRetention,
      };
    }
    const exact = versions.find((v) => v.params_version === recordedVersion);
    if (exact) {
      return {
        ...DEFAULT_FSRS_CONFIG,
        ...exact.params,
      };
    }
  }

  let selected: DeckFSRSParamsVersion | undefined;
  for (const v of versions) {
    if (v.effective_from <= reviewedAtMs) {
      selected = v;
    }
  }
  if (selected) {
    return {
      ...DEFAULT_FSRS_CONFIG,
      ...selected.params,
    };
  }

  return {
    ...DEFAULT_FSRS_CONFIG,
    request_retention: initialRetention,
  };
}

/** The params version a review was (or would have been) recorded under; 0 = deck baseline. */
function resolveOwnParamsVersion(
  versions: readonly DeckFSRSParamsVersion[],
  reviewedAtMs: number,
  recordedVersion: number | undefined,
): number {
  if (recordedVersion !== undefined) {
    if (recordedVersion === 0 || versions.some((v) => v.params_version === recordedVersion)) {
      return recordedVersion;
    }
  }
  let own = 0;
  for (const v of versions) {
    if (v.effective_from <= reviewedAtMs) own = v.params_version;
  }
  return own;
}

/** Returns the FSRS params version a deck uses now: the newest one in its version list. */
export function getActiveFsrsParamsVersion(state: CollectionState, deckId: string): number {
  const versions = state.deckFsrsParams.get(deckId);
  const latest = versions?.[versions.length - 1];
  return latest ? latest.params_version : 0;
}

/**
 * Builds the `DeckFSRSParamsChanged` payload for a target-retention edit. The new version
 * carries the deck's current weights (optimized ones included, Phase 11) so changing only the
 * retention never resets them to the defaults.
 */
export function buildRetentionParamsPayload(
  state: CollectionState,
  deckId: string,
  requestRetention: number,
  nowMs: number,
): DeckFSRSParamsChangedPayload {
  const currentW = resolveDeckFsrsConfig(state, deckId, nowMs).w;
  return {
    deck_id: deckId,
    params_version: getActiveFsrsParamsVersion(state, deckId) + 1,
    effective_from: nowMs,
    params: {
      request_retention: requestRetention,
      enable_fuzz: false,
      enable_short_term: true,
      ...(currentW ? { w: [...currentW] } : {}),
    },
  };
}

/** Returns active layouts enabled for a given deck. */
export function getEnabledLayoutsForDeck(state: CollectionState, deck: Deck): Layout[] {
  const matching: Layout[] = [];
  for (const layout of state.layouts.values()) {
    if (layout.note_type_id !== deck.note_type_id) continue;
    if (deck.settings.enabled_layout_ids !== undefined) {
      if (deck.settings.enabled_layout_ids.includes(layout.id)) {
        matching.push(layout);
      }
    } else if (layout.enabled) {
      matching.push(layout);
    }
  }
  matching.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return matching;
}

/** A card's active (not undone) reviews, in replay order `(reviewed_at, hlc, review_id)`. */
export function getActiveReviews(state: CollectionState, cardId: string): ReviewRecord[] {
  const all = state.reviewsByCard.get(cardId);
  if (!all || all.length === 0) return [];
  return all.filter((r) => !state.undoneReviewIds.has(r.review_id)).sort(compareReviewRecords);
}

/**
 * Replays a single card's schedule deterministically from its active reviews.
 * Runs in < 1 ms for incremental UI updates on rate / undo.
 */
export function replaySingleCard(state: CollectionState, cardId: string): Card | undefined {
  const card = state.cards.get(cardId);
  if (!card) return undefined;

  const active = getActiveReviews(state, cardId);

  let schedule = createInitialSchedule(0);
  let lastReviewedAt: number | undefined;
  let lastReviewedTzOffset: number | undefined;

  for (const rev of active) {
    const config = resolveDeckFsrsConfig(
      state,
      card.deck_id,
      rev.reviewed_at,
      rev.fsrs_params_version,
    );
    const { next } = applyReviewToSchedule(schedule, rev.rating, rev.reviewed_at, config);
    schedule = next;
    lastReviewedAt = rev.reviewed_at;
    lastReviewedTzOffset = rev.tz_offset;
  }

  const updated: Card = {
    ...card,
    schedule,
  };
  if (lastReviewedAt !== undefined) {
    updated.last_reviewed_at = lastReviewedAt;
  } else {
    delete updated.last_reviewed_at;
  }
  if (lastReviewedTzOffset !== undefined) {
    updated.last_reviewed_tz_offset = lastReviewedTzOffset;
  } else {
    delete updated.last_reviewed_tz_offset;
  }

  setCardInState(state, updated);
  return updated;
}

/**
 * Computes the deterministic list of card variants derived for a `(note, layout)` pair.
 * - Non-cloze layouts always yield `[0]`.
 * - Cloze layouts (`answer_mode === 'cloze'`) scan `front_fields` for `{{cN::...}}` numbers
 *   and return unique ascending `N` values, falling back to `[0]` when no cloze markers exist.
 */
export function getVariantsForNoteLayout(note: Note, layout: Layout): number[] {
  if (layout.answer_mode !== 'cloze') {
    return [0];
  }
  const found = new Set<number>();
  for (const fieldKey of layout.front_fields) {
    const val = noteField(note, fieldKey);
    if (!val) continue;
    for (const num of extractClozeNumbers(val)) {
      found.add(num);
    }
  }
  if (found.size === 0) {
    return [0];
  }
  return [...found].sort((a, b) => a - b);
}

/** True when the card has at least one review that is not undone. */
function hasActiveReviews(state: CollectionState, cardId: string): boolean {
  const list = state.reviewsByCard.get(cardId);
  if (!list) return false;
  return list.some((r) => !state.undoneReviewIds.has(r.review_id));
}

interface DerivedCardSets {
  rebuiltIds: Set<string>;
  replayedCards: Set<string>;
  changedCards: Set<string>;
  removedCards: Set<string>;
}

interface PlannedCard {
  cardId: string;
  layout: Layout;
  variant: number;
  empty: boolean;
}

/**
 * The cards one note gets from the deck's enabled layouts. A layout whose usable
 * `required_field` is empty (`model/optional-cards.ts`) makes no card, unless that card already
 * has active reviews: then it is kept with its history and flagged `empty` (hidden from Study,
 * listed in Browse). Depends only on replayed state, so every device derives the same cards.
 *
 * @internal snapshot-upgrade only (`snapshot-upgrade.ts`); otherwise called only inside replay.
 */
export function planNoteCards(
  state: CollectionState,
  note: Note,
  enabledLayouts: readonly Layout[],
): PlannedCard[] {
  const out: PlannedCard[] = [];
  for (const layout of enabledLayouts) {
    const ruleMet = layoutRuleMet(note, layout, state.noteTypes.get(layout.note_type_id));
    for (const variant of getVariantsForNoteLayout(note, layout)) {
      const cardId = deriveCardId(note.id, layout.id, variant);
      if (!ruleMet && !hasActiveReviews(state, cardId)) continue;
      out.push({ cardId, layout, variant, empty: !ruleMet });
    }
  }
  return out;
}

function deriveNoteCards(
  state: CollectionState,
  note: Note,
  deckId: string,
  enabledLayouts: readonly Layout[],
  sets: DerivedCardSets,
): void {
  for (const { cardId, layout, variant, empty } of planNoteCards(state, note, enabledLayouts)) {
    setCardInState(state, {
      id: cardId,
      note_id: note.id,
      deck_id: deckId,
      layout_id: layout.id,
      variant,
      schedule: createInitialSchedule(0),
      ...(empty ? { empty: true as const } : {}),
    });
    replaySingleCard(state, cardId);
    sets.rebuiltIds.add(cardId);
    sets.replayedCards.add(cardId);
    sets.changedCards.add(cardId);
    sets.removedCards.delete(cardId);
  }
}

/**
 * Enabled layouts of the deck that carry a `required_field` (usable or not).
 *
 * @internal snapshot-upgrade only (`snapshot-upgrade.ts`); otherwise called only inside replay.
 */
export function ruleLayoutsForDeck(state: CollectionState, deck: Deck): Layout[] {
  return getEnabledLayoutsForDeck(state, deck).filter(
    (l) => l.required_field !== undefined && l.required_field !== '',
  );
}

/**
 * Notes owning `cardIds` (cards with reviews but no derived card) through a layout whose
 * `required_field` is empty. Such a review may arrive by sync after the field was emptied; the
 * note is then rebuilt so the card comes back as `empty`, exactly as a full replay would make it.
 * Costs nothing when no layout has a rule.
 */
function findNotesOfRuleSkippedCards(
  state: CollectionState,
  cardIds: ReadonlySet<string>,
): Set<string> {
  const noteIds = new Set<string>();
  if (cardIds.size === 0 || !hasOptionalCardRules(state.layouts.values())) return noteIds;
  for (const deck of state.decks.values()) {
    if (deck.archived) continue;
    const ruleLayouts = ruleLayoutsForDeck(state, deck);
    if (ruleLayouts.length === 0) continue;
    for (const noteId of state.noteIdsByDeck.get(deck.id) ?? []) {
      const note = state.notes.get(noteId);
      if (!note || note.archived || note.deck_id !== deck.id) continue;
      for (const layout of ruleLayouts) {
        if (layoutRuleMet(note, layout, state.noteTypes.get(layout.note_type_id))) continue;
        for (const variant of getVariantsForNoteLayout(note, layout)) {
          if (cardIds.has(deriveCardId(note.id, layout.id, variant))) noteIds.add(note.id);
        }
      }
    }
  }
  return noteIds;
}

function rebuildCardsForDeck(
  state: CollectionState,
  deckId: string,
  changedCards: Set<string>,
  removedCards: Set<string>,
  replayedCards: Set<string>,
): void {
  const deck = state.decks.get(deckId);
  const existingSet = state.cardIdsByDeck.get(deckId);
  const prevCardIds = existingSet ? [...existingSet] : [];

  for (const cardId of prevCardIds) {
    deleteCardFromState(state, cardId);
  }

  const rebuiltIds = new Set<string>();
  if (deck && !deck.archived) {
    const enabledLayouts = getEnabledLayoutsForDeck(state, deck);
    const deckNoteIds = state.noteIdsByDeck.get(deckId);
    if (deckNoteIds && enabledLayouts.length > 0) {
      for (const noteId of deckNoteIds) {
        const note = state.notes.get(noteId);
        if (!note || note.deck_id !== deckId || note.archived) continue;
        deriveNoteCards(state, note, deckId, enabledLayouts, {
          rebuiltIds,
          replayedCards,
          changedCards,
          removedCards,
        });
      }
    }
  }

  for (const prevId of prevCardIds) {
    if (!rebuiltIds.has(prevId) && !state.cards.has(prevId)) {
      removedCards.add(prevId);
      changedCards.delete(prevId);
    }
  }
}

/** @internal snapshot-upgrade only (`snapshot-upgrade.ts`); otherwise called only inside replay. */
export function rebuildCardsForNote(
  state: CollectionState,
  noteId: string,
  changedCards: Set<string>,
  removedCards: Set<string>,
  replayedCards: Set<string>,
): void {
  const note = state.notes.get(noteId);
  const existingSet = state.cardIdsByNote.get(noteId);
  const prevCardIds = existingSet ? [...existingSet] : [];

  for (const cardId of prevCardIds) {
    deleteCardFromState(state, cardId);
  }

  const rebuiltIds = new Set<string>();
  if (note && !note.archived) {
    const deck = state.decks.get(note.deck_id);
    if (deck && !deck.archived) {
      const enabledLayouts = getEnabledLayoutsForDeck(state, deck);
      deriveNoteCards(state, note, deck.id, enabledLayouts, {
        rebuiltIds,
        replayedCards,
        changedCards,
        removedCards,
      });
    }
  }

  for (const prevId of prevCardIds) {
    if (!rebuiltIds.has(prevId) && !state.cards.has(prevId)) {
      removedCards.add(prevId);
      changedCards.delete(prevId);
    }
  }
}

function applyDeckSettingsPatchTarget(
  state: CollectionState,
  deckId: string,
  target: Partial<DeckSettings>,
  settings: Partial<DeckSettings>,
  hlc: string,
  collector?: ApplyMutationCollector,
): boolean {
  let layoutsChanged = false;

  if (
    settings.new_cards_per_day !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:new_cards_per_day`, hlc, collector)
  ) {
    target.new_cards_per_day = settings.new_cards_per_day;
  }
  if (
    settings.max_reviews_per_day !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:max_reviews_per_day`, hlc, collector)
  ) {
    target.max_reviews_per_day = settings.max_reviews_per_day;
  }
  if (
    settings.target_retention !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:target_retention`, hlc, collector)
  ) {
    target.target_retention = settings.target_retention;
  }
  if (
    settings.new_card_order !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:new_card_order`, hlc, collector)
  ) {
    target.new_card_order = settings.new_card_order;
  }
  if (
    settings.enabled_layout_ids !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:enabled_layout_ids`, hlc, collector)
  ) {
    target.enabled_layout_ids = [...settings.enabled_layout_ids];
    layoutsChanged = true;
  }
  if (
    settings.day_start_hour !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:day_start_hour`, hlc, collector)
  ) {
    target.day_start_hour = settings.day_start_hour;
  }

  return layoutsChanged;
}

function getOrCreatePendingDeckPatch(state: CollectionState, deckId: string): PendingDeckPatch {
  let pending = state.pendingDeckPatches.get(deckId);
  if (!pending) {
    pending = { settings: {} };
    state.pendingDeckPatches.set(deckId, pending);
  }
  return pending;
}

function getOrCreatePendingPagePatch(state: CollectionState, pageId: string): PendingPagePatch {
  let pending = state.pendingPagePatches.get(pageId);
  if (!pending) {
    pending = {};
    state.pendingPagePatches.set(pageId, pending);
  }
  return pending;
}

/** Per-event mutable context shared by the known-event handlers below. */
interface ApplyEventContext {
  state: CollectionState;
  hlc: string;
  dirtyCards: Set<string>;
  dirtyDecks: Set<string>;
  dirtyNotes: Set<string>;
  collector?: ApplyMutationCollector | undefined;
}

function markDeckCardsDirty(state: CollectionState, deckId: string, dirtyCards: Set<string>): void {
  const deckCards = state.cardIdsByDeck.get(deckId);
  if (deckCards) {
    for (const cardId of deckCards) {
      dirtyCards.add(cardId);
    }
  }
}

function applyNoteTypeChanged(
  ctx: ApplyEventContext,
  payload: EventPayloadMap['NoteTypeChanged'],
): void {
  const { state, hlc, collector } = ctx;
  const nt = payload.note_type;
  if (shouldApplyLww(state, `noteType:${nt.id}`, hlc, collector)) {
    state.noteTypes.set(nt.id, {
      ...nt,
      fields: nt.fields.map((f) => ({ ...f })),
    });
    collector?.noteTypeIds.add(nt.id);
    // A rule only counts for a field the note type has, so its decks re-derive their cards.
    const typeLayouts = [...state.layouts.values()].filter((l) => l.note_type_id === nt.id);
    if (hasOptionalCardRules(typeLayouts)) {
      for (const deck of state.decks.values()) {
        if (deck.note_type_id === nt.id) ctx.dirtyDecks.add(deck.id);
      }
    }
  }
}

function applyLayoutChanged(
  ctx: ApplyEventContext,
  payload: EventPayloadMap['LayoutChanged'],
): void {
  const { state, hlc, collector, dirtyDecks } = ctx;
  const layout = payload.layout;
  if (shouldApplyLww(state, `layout:${layout.id}`, hlc, collector)) {
    state.layouts.set(layout.id, {
      ...layout,
      front_fields: [...layout.front_fields],
      reveal_steps: layout.reveal_steps.map((s) => [...s]),
    });
    collector?.layoutIds.add(layout.id);
    for (const deck of state.decks.values()) {
      if (deck.note_type_id === layout.note_type_id) {
        dirtyDecks.add(deck.id);
      }
    }
  }
}

function buildMergedDeckSettings(pendingSettings: Partial<DeckSettings> | undefined): DeckSettings {
  const mergedSettings: DeckSettings = { ...DEFAULT_DECK_SETTINGS };
  if (pendingSettings) {
    if (pendingSettings.new_cards_per_day !== undefined) {
      mergedSettings.new_cards_per_day = pendingSettings.new_cards_per_day;
    }
    if (pendingSettings.max_reviews_per_day !== undefined) {
      mergedSettings.max_reviews_per_day = pendingSettings.max_reviews_per_day;
    }
    if (pendingSettings.target_retention !== undefined) {
      mergedSettings.target_retention = pendingSettings.target_retention;
    }
    if (pendingSettings.new_card_order !== undefined) {
      mergedSettings.new_card_order = pendingSettings.new_card_order;
    }
    if (pendingSettings.enabled_layout_ids !== undefined) {
      mergedSettings.enabled_layout_ids = [...pendingSettings.enabled_layout_ids];
    }
    if (pendingSettings.day_start_hour !== undefined) {
      mergedSettings.day_start_hour = pendingSettings.day_start_hour;
    }
  }
  return mergedSettings;
}

/**
 * DeckCreated's own fields, the same whether the deck is new or already exists.
 *
 * Starter and `.flashpkg` deck ids are deterministic, so two devices can both
 * emit `DeckCreated` for one deck. Every field is LWW or order-independent so
 * the result does not depend on delivery order (D10). `archived` is owned only
 * by `DeckSettingsChanged`: a create never unarchives a deck another device
 * archived. `created_at` keeps the earliest known value.
 */
function applyDeckCreatedFields(
  ctx: ApplyEventContext,
  deck: Deck,
  p: EventPayloadMap['DeckCreated'],
  initialRet: number,
): void {
  const { state, hlc, collector } = ctx;
  if (shouldApplyLww(state, `deck:${p.deck_id}:name`, hlc, collector)) deck.name = p.name;
  if (shouldApplyLww(state, `deck:${p.deck_id}:note_type_id`, hlc, collector)) {
    deck.note_type_id = p.note_type_id;
  }
  if (shouldApplyLww(state, `deck:${p.deck_id}:language`, hlc, collector)) {
    deck.language = p.language;
  }
  if (shouldApplyLww(state, `deck:${p.deck_id}:initial_retention`, hlc, collector)) {
    deck.initial_retention = initialRet;
  }
  if (p.source !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:source`, hlc, collector)) {
    deck.source = { ...p.source };
  }
  const createdAt = p.created_at ?? 0;
  if (createdAt > 0 && (deck.created_at <= 0 || createdAt < deck.created_at)) {
    deck.created_at = createdAt;
  }
}

function createDeckFromPending(
  ctx: ApplyEventContext,
  p: EventPayloadMap['DeckCreated'],
  initialRet: number,
): Deck {
  const { state, collector } = ctx;
  const pending = state.pendingDeckPatches.get(p.deck_id);
  if (pending) {
    state.pendingDeckPatches.delete(p.deck_id);
    collector?.pendingDeckPatchKeys.add(p.deck_id);
  }

  const mergedSettings = buildMergedDeckSettings(pending?.settings);

  const deck: Deck = {
    id: p.deck_id,
    name: pending?.name ?? p.name,
    note_type_id: p.note_type_id,
    language: pending?.language ?? p.language,
    settings: mergedSettings,
    initial_retention: initialRet,
    archived: pending?.archived ?? false,
    created_at: 0,
  };
  if (pending?.source !== undefined) {
    deck.source = { ...pending.source };
  }
  state.decks.set(p.deck_id, deck);

  applyDeckCreatedFields(ctx, deck, p, initialRet);
  return deck;
}

function applyDeckCreated(ctx: ApplyEventContext, p: EventPayloadMap['DeckCreated']): void {
  const { state, hlc, collector, dirtyDecks } = ctx;
  let deck = state.decks.get(p.deck_id);
  const initialRet = p.settings?.target_retention ?? DEFAULT_FSRS_CONFIG.request_retention;
  if (!deck) {
    deck = createDeckFromPending(ctx, p, initialRet);
  } else {
    applyDeckCreatedFields(ctx, deck, p, initialRet);
  }
  if (p.settings) {
    applyDeckSettingsPatchTarget(state, p.deck_id, deck.settings, p.settings, hlc, collector);
  }
  collector?.deckIds.add(p.deck_id);
  dirtyDecks.add(p.deck_id);
}

/** Buffer out-of-order patch until DeckCreated arrives. */
function bufferPendingDeckSettings(
  ctx: ApplyEventContext,
  p: EventPayloadMap['DeckSettingsChanged'],
): void {
  const { state, hlc, collector } = ctx;
  const pending = getOrCreatePendingDeckPatch(state, p.deck_id);
  if (p.name !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:name`, hlc, collector)) {
    pending.name = p.name;
  }
  if (
    p.language !== undefined &&
    shouldApplyLww(state, `deck:${p.deck_id}:language`, hlc, collector)
  ) {
    pending.language = p.language;
  }
  if (
    p.archived !== undefined &&
    shouldApplyLww(state, `deck:${p.deck_id}:archived`, hlc, collector)
  ) {
    pending.archived = p.archived;
  }
  if (p.settings) {
    applyDeckSettingsPatchTarget(state, p.deck_id, pending.settings, p.settings, hlc, collector);
  }
  collector?.pendingDeckPatchKeys.add(p.deck_id);
}

function applyDeckSettingsChanged(
  ctx: ApplyEventContext,
  p: EventPayloadMap['DeckSettingsChanged'],
): void {
  const { state, hlc, collector, dirtyCards, dirtyDecks } = ctx;
  const deck = state.decks.get(p.deck_id);
  if (!deck) {
    bufferPendingDeckSettings(ctx, p);
    return;
  }
  let mustRebuildDeck = false;
  if (p.name !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:name`, hlc, collector)) {
    deck.name = p.name;
  }
  if (
    p.language !== undefined &&
    shouldApplyLww(state, `deck:${p.deck_id}:language`, hlc, collector)
  ) {
    deck.language = p.language;
  }
  if (
    p.archived !== undefined &&
    shouldApplyLww(state, `deck:${p.deck_id}:archived`, hlc, collector)
  ) {
    deck.archived = p.archived;
    mustRebuildDeck = true;
  }
  if (p.settings) {
    const layoutsChanged = applyDeckSettingsPatchTarget(
      state,
      p.deck_id,
      deck.settings,
      p.settings,
      hlc,
      collector,
    );
    if (layoutsChanged) mustRebuildDeck = true;
  }
  collector?.deckIds.add(p.deck_id);
  if (mustRebuildDeck) {
    dirtyDecks.add(p.deck_id);
  } else if (p.settings?.target_retention !== undefined) {
    markDeckCardsDirty(state, p.deck_id, dirtyCards);
  }
}

function applyDeckFsrsParamsChanged(
  ctx: ApplyEventContext,
  p: EventPayloadMap['DeckFSRSParamsChanged'],
): void {
  const { state, hlc, collector, dirtyCards } = ctx;
  if (!shouldApplyLww(state, `deck:${p.deck_id}:fsrs:${p.params_version}`, hlc, collector)) {
    return;
  }
  const existing = state.deckFsrsParams.get(p.deck_id) ?? [];
  const filtered = existing.filter((v) => v.params_version !== p.params_version);
  const entry: DeckFSRSParamsVersion = {
    params_version: p.params_version,
    effective_from: p.effective_from,
    params: { ...p.params },
  };
  if (p.reschedule_existing !== undefined) {
    entry.reschedule_existing = p.reschedule_existing;
  }
  filtered.push(entry);
  filtered.sort((a, b) => a.params_version - b.params_version);
  state.deckFsrsParams.set(p.deck_id, filtered);
  collector?.fsrsDeckIds.add(p.deck_id);
  markDeckCardsDirty(state, p.deck_id, dirtyCards);
}

function createUpsertedNote(ctx: ApplyEventContext, p: EventPayloadMap['NoteUpserted']): Note {
  const { state, hlc, collector } = ctx;
  const note: Note = {
    id: p.note_id,
    deck_id: p.deck_id,
    fields: {},
    tags: [],
    source_key: p.source_key,
    provenance: p.provenance ? { ...p.provenance } : { source: 'user', reviewed: true },
    archived: state.noteArchivedState.get(p.note_id) ?? false,
    created_order: p.created_order ?? 0,
  };
  state.notes.set(p.note_id, note);
  addToMapSet(state.noteIdsByDeck, note.deck_id, note.id);
  // A fields-only edit that arrives first leaves the header registers to the note's own upsert.
  if (!p.fields_only) {
    shouldApplyLww(state, `note:${p.note_id}:deck_id`, hlc, collector);
    shouldApplyLww(state, `note:${p.note_id}:source_key`, hlc, collector);
  }
  if (p.provenance) shouldApplyLww(state, `note:${p.note_id}:provenance`, hlc, collector);
  if (p.created_order !== undefined) {
    shouldApplyLww(state, `note:${p.note_id}:created_order`, hlc, collector);
  }
  return note;
}

function updateUpsertedNoteHeader(
  ctx: ApplyEventContext,
  note: Note,
  p: EventPayloadMap['NoteUpserted'],
): void {
  const { state, hlc, collector, dirtyDecks } = ctx;
  if (p.fields_only) return;
  if (shouldApplyLww(state, `note:${p.note_id}:deck_id`, hlc, collector)) {
    if (note.deck_id !== p.deck_id) {
      removeFromMapSet(state.noteIdsByDeck, note.deck_id, note.id);
      dirtyDecks.add(note.deck_id);
      note.deck_id = p.deck_id;
      addToMapSet(state.noteIdsByDeck, note.deck_id, note.id);
    }
  }
  if (shouldApplyLww(state, `note:${p.note_id}:source_key`, hlc, collector)) {
    note.source_key = p.source_key;
  }
  if (p.provenance && shouldApplyLww(state, `note:${p.note_id}:provenance`, hlc, collector)) {
    note.provenance = { ...p.provenance };
  }
  if (
    p.created_order !== undefined &&
    shouldApplyLww(state, `note:${p.note_id}:created_order`, hlc, collector)
  ) {
    note.created_order = p.created_order;
  }
}

function applyNoteUpserted(ctx: ApplyEventContext, p: EventPayloadMap['NoteUpserted']): void {
  const { state, hlc, collector, dirtyNotes } = ctx;
  let note = state.notes.get(p.note_id);
  if (!note) {
    note = createUpsertedNote(ctx, p);
  } else {
    updateUpsertedNoteHeader(ctx, note, p);
  }

  // Per-field LWW for note fields
  for (const [fieldKey, fieldValue] of Object.entries(p.fields)) {
    if (shouldApplyLww(state, `note:${p.note_id}:field:${fieldKey}`, hlc, collector)) {
      note.fields[fieldKey] = fieldValue;
    }
  }

  if (p.tags !== undefined && shouldApplyLww(state, `note:${p.note_id}:tags`, hlc, collector)) {
    note.tags = [...p.tags];
  }
  // Set-union `NoteTagsAdded` adds newer than the tags register stay (see ./tag-adds.ts).
  if (noteHasTagAdds(state, p.note_id)) canonicalizeNoteTags(state, note);

  collector?.noteIds.add(p.note_id);
  dirtyNotes.add(p.note_id);
}

function applyNoteArchived(ctx: ApplyEventContext, p: EventPayloadMap['NoteArchived']): void {
  const { state, hlc, collector, dirtyNotes } = ctx;
  if (shouldApplyLww(state, `note:${p.note_id}:archived`, hlc, collector)) {
    state.noteArchivedState.set(p.note_id, true);
    collector?.noteArchivedKeys.add(p.note_id);
    const note = state.notes.get(p.note_id);
    if (note) {
      note.archived = true;
      collector?.noteIds.add(p.note_id);
      dirtyNotes.add(p.note_id);
    }
  }
}

function applyNoteRestored(ctx: ApplyEventContext, p: EventPayloadMap['NoteRestored']): void {
  const { state, hlc, collector, dirtyNotes } = ctx;
  if (shouldApplyLww(state, `note:${p.note_id}:archived`, hlc, collector)) {
    state.noteArchivedState.set(p.note_id, false);
    collector?.noteArchivedKeys.add(p.note_id);
    const note = state.notes.get(p.note_id);
    if (note) {
      note.archived = false;
      collector?.noteIds.add(p.note_id);
      dirtyNotes.add(p.note_id);
    }
  }
}

function applyReviewRecorded(ctx: ApplyEventContext, p: EventPayloadMap['ReviewRecorded']): void {
  const { state, hlc, collector, dirtyCards } = ctx;
  const list = state.reviewsByCard.get(p.card_id) ?? [];
  if (!list.some((r) => r.review_id === p.review_id)) {
    const record: ReviewRecord = {
      review_id: p.review_id,
      card_id: p.card_id,
      rating: p.rating,
      reviewed_at: p.reviewed_at,
      tz_offset: p.tz_offset,
      duration_ms: p.duration_ms,
      answer_mode: p.answer_mode,
      fsrs_params_version: p.fsrs_params_version,
      resulting_due_at: p.resulting_due_at,
      hlc,
    };
    if (p.typed_answer !== undefined) {
      record.typed_answer = p.typed_answer;
    }
    list.push(record);
    state.reviewsByCard.set(p.card_id, list);
    state.reviewIdToCardId.set(p.review_id, p.card_id);
    collector?.reviewCardIds.add(p.card_id);
  }
  dirtyCards.add(p.card_id);
}

function applyReviewUndone(ctx: ApplyEventContext, p: EventPayloadMap['ReviewUndone']): void {
  const { state, collector, dirtyCards } = ctx;
  if (!state.undoneReviewIds.has(p.review_id)) {
    state.undoneReviewIds.add(p.review_id);
    collector?.addedUndoneReviewIds.add(p.review_id);
  }
  const cardId = state.reviewIdToCardId.get(p.review_id);
  if (cardId !== undefined) {
    dirtyCards.add(cardId);
  }
}

function buildUpsertedPage(
  ctx: ApplyEventContext,
  p: EventPayloadMap['PageUpserted'],
  existing: Page | undefined,
  pending: PendingPagePatch | undefined,
): Page {
  const { state, hlc, collector } = ctx;
  const page: Page = {
    id: p.page_id,
    slug: p.slug,
    title: p.title,
    markdown: p.markdown,
    tags: p.tags ? [...p.tags] : [],
  };
  if (p.lang !== undefined) page.lang = p.lang;
  const resolvedSource = existing?.source ?? pending?.source;
  if (resolvedSource !== undefined) page.source = { ...resolvedSource };
  if (p.source !== undefined && shouldApplyLww(state, `page:${p.page_id}:source`, hlc, collector)) {
    page.source = { ...p.source };
  }
  const resolvedReadAt = existing?.read_at ?? pending?.read_at;
  if (resolvedReadAt !== undefined) page.read_at = resolvedReadAt;
  return page;
}

function applyPageUpserted(ctx: ApplyEventContext, p: EventPayloadMap['PageUpserted']): void {
  const { state, hlc, collector } = ctx;
  const pending = state.pendingPagePatches.get(p.page_id);
  if (pending) {
    state.pendingPagePatches.delete(p.page_id);
    collector?.pendingPagePatchKeys.add(p.page_id);
  }
  const existing = state.pages.get(p.page_id);

  if (shouldApplyLww(state, `page:${p.page_id}`, hlc, collector)) {
    const page = buildUpsertedPage(ctx, p, existing, pending);
    state.pages.set(p.page_id, page);
    collector?.pageIds.add(p.page_id);
  } else if (existing && p.source !== undefined) {
    if (shouldApplyLww(state, `page:${p.page_id}:source`, hlc, collector)) {
      existing.source = { ...p.source };
      collector?.pageIds.add(p.page_id);
    }
  }
}

function applyPageRead(ctx: ApplyEventContext, p: EventPayloadMap['PageRead']): void {
  const { state, hlc, collector } = ctx;
  if (shouldApplyLww(state, `page:${p.page_id}:read_at`, hlc, collector)) {
    const page = state.pages.get(p.page_id);
    if (page) {
      page.read_at = p.read_at;
      collector?.pageIds.add(p.page_id);
    } else {
      const pending = getOrCreatePendingPagePatch(state, p.page_id);
      pending.read_at = p.read_at;
      collector?.pendingPagePatchKeys.add(p.page_id);
    }
  }
}

function applyCourseChanged(
  ctx: ApplyEventContext,
  payload: EventPayloadMap['CourseChanged'],
): void {
  const { state, hlc, collector } = ctx;
  const c = payload.course;
  if (shouldApplyLww(state, `course:${c.id}`, hlc, collector)) {
    state.courses.set(c.id, {
      ...c,
      items: c.items.map((item) => ({ ...item })),
    });
    collector?.courseIds.add(c.id);
  }
}

const TTS_FIELDS = ['tts_key', 'tts_lang_key'] as const;

/**
 * Each `MediaEntry` field is its own LWW register, so any delivery order converges (D20): `ext`,
 * `mime` and `size` follow `media:<hash>:added`, and `tts_key` / `tts_lang_key` follow
 * `media:<hash>:tts_key` / `:tts_lang_key`, set only by adds that carry them. An add older than
 * the newest removal contributes nothing to the entry (`applyMediaRemoved` strips what such an
 * add wrote before the removal arrived). The `tts:key:*` / `tts:lang:*` indexes are LWW over
 * every add's own keys, removed or not, so they never depend on what arrived first either.
 */
function applyMediaAdded(ctx: ApplyEventContext, payload: EventPayloadMap['MediaAdded']): void {
  const { state, hlc, collector } = ctx;
  const m = payload.media;
  const normHash = m.hash.toLowerCase();
  if (m.tts_key && shouldApplyLww(state, `tts:key:${m.tts_key}`, hlc, collector)) {
    state.ttsMediaByKey.set(m.tts_key, normHash);
    collector?.ttsKeys.add(m.tts_key);
  }
  if (m.tts_lang_key && shouldApplyLww(state, `tts:lang:${m.tts_lang_key}`, hlc, collector)) {
    state.ttsMediaByLangKey.set(m.tts_lang_key, normHash);
    collector?.ttsLangKeys.add(m.tts_lang_key);
  }
  const won = shouldApplyLww(state, `media:${normHash}:added`, hlc, collector);
  // `MediaRemoved`: an add older than the newest removal of the same hash stays removed.
  const removedAt = state.fieldHlcs.get(`media:${normHash}:removed`);
  if (removedAt !== undefined && compareHlc(hlc, removedAt) < 0) return;
  const prev = state.media.get(normHash);
  const next: MediaEntry =
    won || !prev
      ? { hash: normHash, ext: m.ext.toLowerCase(), mime: m.mime, size: m.size }
      : { ...prev };
  for (const f of TTS_FIELDS) {
    const v =
      m[f] && shouldApplyLww(state, `media:${normHash}:${f}`, hlc, collector) ? m[f] : prev?.[f];
    if (v !== undefined) next[f] = v;
  }
  state.media.set(normHash, next);
  collector?.mediaHashes.add(normHash);
}

/** @internal snapshot-upgrade only (`snapshot-upgrade.ts`); otherwise called only inside replay. */
export function applyMediaRemoved(
  ctx: ApplyEventContext,
  payload: EventPayloadMap['MediaRemoved'],
): void {
  const { state, hlc, collector } = ctx;
  if (typeof payload.hash !== 'string') return;
  const normHash = payload.hash.toLowerCase();
  shouldApplyLww(state, `media:${normHash}:removed`, hlc, collector);
  const addedAt = state.fieldHlcs.get(`media:${normHash}:added`);
  const entry = state.media.get(normHash);
  if (addedAt !== undefined && compareHlc(addedAt, hlc) > 0) {
    // A newer add keeps the file, but TTS keys only an older add gave it go with this removal.
    if (!entry) return;
    const removedAt = state.fieldHlcs.get(`media:${normHash}:removed`) ?? hlc;
    const next: MediaEntry = { hash: normHash, ext: entry.ext, mime: entry.mime, size: entry.size };
    for (const f of TTS_FIELDS) {
      const v = entry[f];
      const at = state.fieldHlcs.get(`media:${normHash}:${f}`);
      if (v !== undefined && !(at !== undefined && compareHlc(at, removedAt) < 0)) next[f] = v;
    }
    state.media.set(normHash, next);
  } else if (!state.media.delete(normHash)) return;
  collector?.mediaHashes.add(normHash);
}

function linkDeckSource(ctx: ApplyEventContext, p: EventPayloadMap['SourceLinked']): void {
  const { state, hlc, collector } = ctx;
  if (shouldApplyLww(state, `deck:${p.target_id}:source`, hlc, collector)) {
    const deck = state.decks.get(p.target_id);
    if (deck) {
      deck.source = { ...p.source };
      collector?.deckIds.add(p.target_id);
    } else {
      const pending = getOrCreatePendingDeckPatch(state, p.target_id);
      pending.source = { ...p.source };
      collector?.pendingDeckPatchKeys.add(p.target_id);
    }
  }
}

function linkPageSource(ctx: ApplyEventContext, p: EventPayloadMap['SourceLinked']): void {
  const { state, hlc, collector } = ctx;
  if (shouldApplyLww(state, `page:${p.target_id}:source`, hlc, collector)) {
    const page = state.pages.get(p.target_id);
    if (page) {
      page.source = { ...p.source };
      collector?.pageIds.add(p.target_id);
    } else {
      const pending = getOrCreatePendingPagePatch(state, p.target_id);
      pending.source = { ...p.source };
      collector?.pendingPagePatchKeys.add(p.target_id);
    }
  }
}

function applySourceLinked(ctx: ApplyEventContext, p: EventPayloadMap['SourceLinked']): void {
  if (p.target_kind === 'deck') {
    linkDeckSource(ctx, p);
  } else {
    linkPageSource(ctx, p);
  }
}

/**
 * `SourceUnlinked`: clears the target's source when the unlink is the newest write to its source
 * register (shared with `SourceLinked`, so an older link arriving later stays out). Before the
 * deck/page exists, the buffered source is dropped instead. Malformed payloads are ignored.
 *
 * @internal snapshot-upgrade only (`snapshot-upgrade.ts`); otherwise called only inside replay.
 */
export function applySourceUnlinkedAt(
  state: CollectionState,
  payload: unknown,
  hlc: string,
  collector?: ApplyMutationCollector,
): void {
  if (typeof payload !== 'object' || payload === null) return;
  const { target_kind: kind, target_id: id } = payload as Partial<
    EventPayloadMap['SourceUnlinked']
  >;
  if ((kind !== 'deck' && kind !== 'page') || typeof id !== 'string' || id === '') return;
  if (!shouldApplyLww(state, `${kind}:${id}:source`, hlc, collector)) return;
  const target = kind === 'deck' ? state.decks.get(id) : state.pages.get(id);
  if (target) {
    delete target.source;
    (kind === 'deck' ? collector?.deckIds : collector?.pageIds)?.add(id);
    return;
  }
  const pending =
    kind === 'deck' ? state.pendingDeckPatches.get(id) : state.pendingPagePatches.get(id);
  if (pending?.source !== undefined) {
    delete pending.source;
    (kind === 'deck' ? collector?.pendingDeckPatchKeys : collector?.pendingPagePatchKeys)?.add(id);
  }
}

type PreferencesPatch = EventPayloadMap['PreferencesChanged']['preferences'];

/** Scalar preference fields; returns true when any field was applied. */
function applyScalarPreferences(ctx: ApplyEventContext, pref: PreferencesPatch): boolean {
  const { state, hlc, collector } = ctx;
  let changed = false;
  if (
    pref.rating_button_mode !== undefined &&
    shouldApplyLww(state, 'prefs:rating_button_mode', hlc, collector)
  ) {
    state.preferences.rating_button_mode = pref.rating_button_mode;
    changed = true;
  }
  if (
    pref.day_start_hour !== undefined &&
    shouldApplyLww(state, 'prefs:day_start_hour', hlc, collector)
  ) {
    state.preferences.day_start_hour = pref.day_start_hour;
    changed = true;
  }
  if (
    pref.pinyin_tone_colors !== undefined &&
    shouldApplyLww(state, 'prefs:pinyin_tone_colors', hlc, collector)
  ) {
    state.preferences.pinyin_tone_colors = pref.pinyin_tone_colors;
    changed = true;
  }
  if (
    pref.ja_kana_equivalent !== undefined &&
    shouldApplyLww(state, 'prefs:ja_kana_equivalent', hlc, collector)
  ) {
    state.preferences.ja_kana_equivalent = pref.ja_kana_equivalent;
    changed = true;
  }
  if (
    pref.zh_ignore_tones !== undefined &&
    shouldApplyLww(state, 'prefs:zh_ignore_tones', hlc, collector)
  ) {
    state.preferences.zh_ignore_tones = pref.zh_ignore_tones;
    changed = true;
  }
  if (
    pref.auto_play_audio !== undefined &&
    shouldApplyLww(state, 'prefs:auto_play_audio', hlc, collector)
  ) {
    state.preferences.auto_play_audio = pref.auto_play_audio;
    changed = true;
  }
  if (
    typeof pref.leech_auto_suspend === 'boolean' &&
    shouldApplyLww(state, 'prefs:leech_auto_suspend', hlc, collector)
  ) {
    state.preferences.leech_auto_suspend = pref.leech_auto_suspend;
    changed = true;
  }
  return changed;
}

/**
 * Settings › Study Preferences defaults (study method, review order), each its own LWW register.
 * Values an older or newer build doesn't know are ignored, never stored.
 */
function applyStudyDefaultPreferences(ctx: ApplyEventContext, pref: PreferencesPatch): boolean {
  const { state, hlc, collector } = ctx;
  let changed = false;
  const method = pref.study_method;
  if (
    (method === 'schedule' || method === 'practice') &&
    shouldApplyLww(state, 'prefs:study_method', hlc, collector)
  ) {
    state.preferences.study_method = method;
    changed = true;
  }
  const order = pref.study_order;
  if (
    (order === 'deck' || order === 'random') &&
    shouldApplyLww(state, 'prefs:study_order', hlc, collector)
  ) {
    state.preferences.study_order = order;
    changed = true;
  }
  return changed;
}

function setTtsVoicePreference(state: CollectionState, langKey: string, voiceVal: string): void {
  const trimmed = voiceVal.trim();
  const entries = Object.entries(state.preferences.tts_voices ?? {}).filter(([k]) => k !== langKey);
  if (trimmed) {
    entries.push([langKey, trimmed]);
  }
  if (entries.length > 0) {
    state.preferences.tts_voices = Object.fromEntries(entries);
  } else {
    delete state.preferences.tts_voices;
  }
}

/** Per-language TTS voice preferences; returns true when any entry was applied. */
function applyTtsVoicePreferences(ctx: ApplyEventContext, pref: PreferencesPatch): boolean {
  const { state, hlc, collector } = ctx;
  let changed = false;
  if (pref.tts_voices !== undefined) {
    for (const [langKey, voiceVal] of Object.entries(pref.tts_voices)) {
      if (shouldApplyLww(state, `prefs:tts_voices:${langKey}`, hlc, collector)) {
        setTtsVoicePreference(state, langKey, voiceVal);
        changed = true;
      }
    }
  }
  return changed;
}

/** Per-language drawing-mode preferences; returns true when any entry was applied. */
function applyDrawingModePreferences(ctx: ApplyEventContext, pref: PreferencesPatch): boolean {
  const { state, hlc, collector } = ctx;
  let changed = false;
  if (pref.drawing_modes !== undefined) {
    for (const [langKey, modeVal] of Object.entries(pref.drawing_modes)) {
      if (
        (modeVal === 'graded' || modeVal === 'lookup' || modeVal === 'off') &&
        shouldApplyLww(state, `prefs:drawing_modes:${langKey}`, hlc, collector)
      ) {
        state.preferences.drawing_modes = {
          ...(state.preferences.drawing_modes ?? {}),
          [langKey]: modeVal,
        };
        changed = true;
      }
    }
  }
  return changed;
}

/** Per-language Settings > Languages choices; returns true when any entry was applied. */
function applyLanguageChoicePreferences(ctx: ApplyEventContext, pref: PreferencesPatch): boolean {
  const { state, hlc, collector } = ctx;
  if (typeof pref.languages !== 'object' || pref.languages === null) return false;
  let changed = false;
  // Keys are normalized (`ja-JP` -> `ja`) before the LWW check, so aliases share one register.
  // Aliases inside one event resolve deterministically: the code-unit-last raw key wins.
  const byCode = new Map<string, boolean>();
  const entries = Object.entries(pref.languages).sort(([a], [b]) => compareCodeUnits(a, b));
  for (const [rawKey, on] of entries) {
    const code = normalizeLanguage(rawKey);
    if (code && typeof on === 'boolean') byCode.set(code, on);
  }
  for (const [code, on] of byCode) {
    if (shouldApplyLww(state, `prefs:languages:${code}`, hlc, collector)) {
      state.preferences.languages = { ...state.preferences.languages, [code]: on };
      changed = true;
    }
  }
  return changed;
}

function applyPreferencesChanged(
  ctx: ApplyEventContext,
  payload: EventPayloadMap['PreferencesChanged'],
): void {
  const { collector } = ctx;
  const pref = payload.preferences;
  let changed = applyScalarPreferences(ctx, pref);
  if (applyStudyDefaultPreferences(ctx, pref)) changed = true;
  if (applyTtsVoicePreferences(ctx, pref)) changed = true;
  if (applyDrawingModePreferences(ctx, pref)) changed = true;
  if (applyLanguageChoicePreferences(ctx, pref)) changed = true;
  if (changed && collector) {
    collector.preferencesChanged = true;
  }
}

function applyCardSuspension(
  ctx: ApplyEventContext,
  event: Extract<KnownEvent, { type: 'CardSuspended' | 'CardUnsuspended' }>,
): void {
  // Grow-only HLC registers in `fieldHlcs` (see ./suspension.ts); no card rebuild needed.
  const key = applySuspensionRegister(ctx.state.fieldHlcs, event.type, event.payload, ctx.hlc);
  if (key !== undefined) ctx.collector?.fieldHlcKeys.add(key);
}

function applyNoteTagsAdded(ctx: ApplyEventContext, payload: unknown): void {
  // Grow-only add registers in `fieldHlcs` merged into the note's tags (see ./tag-adds.ts).
  const applied = applyTagAddRegisters(ctx.state, payload, ctx.hlc);
  if (!applied || applied.keys.length === 0) return;
  for (const key of applied.keys) ctx.collector?.fieldHlcKeys.add(key);
  const note = ctx.state.notes.get(applied.noteId);
  if (note && canonicalizeNoteTags(ctx.state, note)) {
    ctx.collector?.noteIds.add(note.id);
    ctx.dirtyNotes.add(note.id);
  }
}

function applyKnownEvent(
  state: CollectionState,
  event: KnownEvent,
  dirtyCards: Set<string>,
  dirtyDecks: Set<string>,
  dirtyNotes: Set<string>,
  collector?: ApplyMutationCollector,
): void {
  const ctx: ApplyEventContext = {
    state,
    hlc: event.hlc,
    dirtyCards,
    dirtyDecks,
    dirtyNotes,
    collector,
  };
  switch (event.type) {
    case 'NoteTypeChanged':
      applyNoteTypeChanged(ctx, event.payload);
      break;
    case 'LayoutChanged':
      applyLayoutChanged(ctx, event.payload);
      break;
    case 'DeckCreated':
      applyDeckCreated(ctx, event.payload);
      break;
    case 'DeckSettingsChanged':
      applyDeckSettingsChanged(ctx, event.payload);
      break;
    case 'DeckFSRSParamsChanged':
      applyDeckFsrsParamsChanged(ctx, event.payload);
      break;
    case 'NoteUpserted':
      applyNoteUpserted(ctx, event.payload);
      break;
    case 'NoteArchived':
      applyNoteArchived(ctx, event.payload);
      break;
    case 'NoteRestored':
      applyNoteRestored(ctx, event.payload);
      break;
    case 'ReviewRecorded':
      applyReviewRecorded(ctx, event.payload);
      break;
    case 'ReviewUndone':
      applyReviewUndone(ctx, event.payload);
      break;
    case 'PageUpserted':
      applyPageUpserted(ctx, event.payload);
      break;
    case 'PageRead':
      applyPageRead(ctx, event.payload);
      break;
    case 'CourseChanged':
      applyCourseChanged(ctx, event.payload);
      break;
    case 'MediaAdded':
      applyMediaAdded(ctx, event.payload);
      break;
    case 'MediaRemoved':
      applyMediaRemoved(ctx, event.payload);
      break;
    case 'SourceLinked':
      applySourceLinked(ctx, event.payload);
      break;
    case 'SourceUnlinked':
      applySourceUnlinkedAt(state, event.payload, event.hlc, collector);
      break;
    case 'PreferencesChanged':
      applyPreferencesChanged(ctx, event.payload);
      break;
    case 'CardSuspended':
    case 'CardUnsuspended':
      applyCardSuspension(ctx, event);
      break;
    case 'NoteTagsAdded':
      applyNoteTagsAdded(ctx, event.payload);
      break;
  }
}

/** True when `cardId` is currently suspended (Phase 9 `CardSuspended` / `CardUnsuspended`). */
export function isCardSuspended(state: CollectionState, cardId: string): boolean {
  return isCardSuspendedIn(state.fieldHlcs, cardId);
}

function isEventAlreadyCompacted(state: CollectionState, event: FlashEvent): boolean {
  if (state.appliedEventIds.has(event.id)) return true;
  if (event.seq > 0) {
    const wm = state.snapshotWatermarks.get(event.device);
    if (wm !== undefined && event.seq <= wm) {
      return true;
    }
  }
  return false;
}

/**
 * Applies a batch of events to `state` while tracking affected cards and optional entity mutations.
 */
export function applyEventsWithCollector(
  state: CollectionState,
  events: readonly FlashEvent[],
  collector?: ApplyMutationCollector,
): ApplyEventsResult {
  if (events.length === 0) {
    return { state, appliedCount: 0, changedCardIds: [], removedCardIds: [] };
  }

  // Sort incoming events by (hlc, id) so entity creation before updates works even if chunks arrive out of order
  const sorted = [...events].sort((a, b) => {
    const hlcCmp = compareHlc(a.hlc, b.hlc);
    if (hlcCmp !== 0) return hlcCmp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const dirtyCards = new Set<string>();
  const dirtyDecks = new Set<string>();
  const dirtyNotes = new Set<string>();
  let appliedCount = 0;
  let maxHlc: string | undefined;

  for (const event of sorted) {
    if (isEventAlreadyCompacted(state, event)) continue;
    state.appliedEventIds.add(event.id);
    collector?.appliedEventIds.push(event.id);
    appliedCount += 1;
    if (maxHlc === undefined || compareHlc(event.hlc, maxHlc) > 0) {
      maxHlc = event.hlc;
    }

    if (isKnownEventType(event.type) && isApplicableEvent(event as KnownEvent)) {
      applyKnownEvent(state, event as KnownEvent, dirtyCards, dirtyDecks, dirtyNotes, collector);
    } else {
      state.unknownEvents.push(event);
      collector?.addedUnknownEvents.push(event);
    }
  }

  const changedCards = new Set<string>();
  const removedCards = new Set<string>();
  const replayedCards = new Set<string>();

  for (const deckId of dirtyDecks) {
    rebuildCardsForDeck(state, deckId, changedCards, removedCards, replayedCards);
  }
  for (const noteId of dirtyNotes) {
    const note = state.notes.get(noteId);
    if (!note || !dirtyDecks.has(note.deck_id)) {
      rebuildCardsForNote(state, noteId, changedCards, removedCards, replayedCards);
    }
  }
  const underivedCards = new Set<string>();
  const emptyCardNotes = new Set<string>();
  for (const cardId of dirtyCards) {
    if (replayedCards.has(cardId)) continue;
    const existing = state.cards.get(cardId);
    if (existing?.empty === true) {
      // An undo may leave an empty card with no history; rebuilding its note drops it.
      emptyCardNotes.add(existing.note_id);
      continue;
    }
    const updated = replaySingleCard(state, cardId);
    if (updated) {
      changedCards.add(cardId);
      removedCards.delete(cardId);
    } else if (state.reviewsByCard.has(cardId)) {
      underivedCards.add(cardId);
    }
  }
  for (const noteId of findNotesOfRuleSkippedCards(state, underivedCards)) {
    emptyCardNotes.add(noteId);
  }
  for (const noteId of emptyCardNotes) {
    rebuildCardsForNote(state, noteId, changedCards, removedCards, replayedCards);
  }

  return {
    state,
    appliedCount,
    changedCardIds: [...changedCards],
    removedCardIds: [...removedCards],
    ...(maxHlc !== undefined ? { maxHlc } : {}),
  };
}

/**
 * Deterministically applies a batch of events to `state` and returns incremental card diffs.
 */
export function applyEventsWithDiff(
  state: CollectionState,
  events: readonly FlashEvent[],
): ApplyEventsResult {
  return applyEventsWithCollector(state, events);
}

/**
 * Deterministically applies a batch of events to `state`.
 * Handles arbitrary out-of-order delivery across devices:
 * - Events are sorted by (hlc, id) for entity LWW consistency.
 * - Reviews are always replayed sorted by (reviewed_at, hlc, review_id).
 * - Unknown future event types, newer schema versions and malformed payloads are preserved in
 *   `state.unknownEvents` without crashing (see ./validate.ts).
 */
export function applyEvents(
  state: CollectionState,
  events: readonly FlashEvent[],
): CollectionState {
  applyEventsWithDiff(state, events);
  return state;
}

/** Rebuilds an entire CollectionState from scratch from an event log. */
export function replayAllEvents(events: readonly FlashEvent[]): CollectionState {
  return applyEvents(createEmptyState(), events);
}

/** Helper to construct properly sequenced, HLC-stamped events for a device. */
export interface EventFactory {
  readonly deviceId: string;
  getSeq(): number;
  setSeq(nextSeq: number): void;
  getHlc(): HlcState;
  setHlc(nextHlc: HlcState): void;
  create<K extends KnownEventType>(
    type: K,
    payload: EventPayloadMap[K],
    nowMs?: number,
  ): KnownEvent;
}

export function createEventFactory(
  deviceId: string,
  initialSeq: number,
  initialHlc: HlcState,
): EventFactory {
  let seq = initialSeq;
  let hlcState = initialHlc;

  return {
    deviceId,
    getSeq: () => seq,
    setSeq: (nextSeq: number) => {
      if (Number.isInteger(nextSeq) && nextSeq > seq) {
        seq = nextSeq;
      }
    },
    getHlc: () => hlcState,
    // Merges, never rewinds: a value read before this factory's latest event must not let the
    // next event sort before it (D20).
    setHlc: (nextHlc: HlcState) => {
      if (compareHlc(formatHlc(nextHlc), formatHlc(hlcState)) > 0) {
        hlcState = { ...hlcState, wallMs: nextHlc.wallMs, counter: nextHlc.counter };
      }
    },
    create<K extends KnownEventType>(
      type: K,
      payload: EventPayloadMap[K],
      nowMs: number = Date.now(),
    ): KnownEvent {
      seq += 1;
      const ticked = tickHlc(hlcState, nowMs);
      hlcState = ticked.next;
      return {
        id: uuidv7(nowMs),
        device: deviceId,
        seq,
        hlc: ticked.hlc,
        type,
        v: 1,
        payload,
      } as KnownEvent;
    },
  };
}
