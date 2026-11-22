import {
  applyReviewToSchedule,
  createInitialSchedule,
  DEFAULT_FSRS_CONFIG,
} from '../fsrs/scheduler.ts';
import { compareHlc, tickHlc, type HlcState } from '../hlc.ts';
import { deriveCardId, uuidv7 } from '../ids.ts';
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
import {
  isKnownEventType,
  type EventPayloadMap,
  type FlashEvent,
  type KnownEvent,
  type KnownEventType,
  type UnknownEvent,
} from './types.ts';

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

function addToMapSet(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function removeFromMapSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) {
    map.delete(key);
  }
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

/** Returns the active FSRS params version number for a deck at `nowMs`. */
export function getActiveFsrsParamsVersion(state: CollectionState, deckId: string): number {
  const versions = state.deckFsrsParams.get(deckId);
  const latest = versions?.[versions.length - 1];
  return latest ? latest.params_version : 0;
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

/**
 * Replays a single card's schedule deterministically from its active reviews.
 * Runs in < 1 ms for incremental UI updates on rate / undo.
 */
export function replaySingleCard(state: CollectionState, cardId: string): Card | undefined {
  const card = state.cards.get(cardId);
  if (!card) return undefined;

  const allReviews = state.reviewsByCard.get(cardId) ?? [];
  const active = allReviews
    .filter((r) => !state.undoneReviewIds.has(r.review_id))
    .sort(compareReviewRecords);

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
    const val = note.fields[fieldKey];
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
        for (const layout of enabledLayouts) {
          const variants = getVariantsForNoteLayout(note, layout);
          for (const variant of variants) {
            const cardId = deriveCardId(note.id, layout.id, variant);
            setCardInState(state, {
              id: cardId,
              note_id: note.id,
              deck_id: deckId,
              layout_id: layout.id,
              variant,
              schedule: createInitialSchedule(0),
            });
            replaySingleCard(state, cardId);
            rebuiltIds.add(cardId);
            replayedCards.add(cardId);
            changedCards.add(cardId);
            removedCards.delete(cardId);
          }
        }
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

function rebuildCardsForNote(
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
      for (const layout of enabledLayouts) {
        const variants = getVariantsForNoteLayout(note, layout);
        for (const variant of variants) {
          const cardId = deriveCardId(note.id, layout.id, variant);
          setCardInState(state, {
            id: cardId,
            note_id: note.id,
            deck_id: deck.id,
            layout_id: layout.id,
            variant,
            schedule: createInitialSchedule(0),
          });
          replaySingleCard(state, cardId);
          rebuiltIds.add(cardId);
          replayedCards.add(cardId);
          changedCards.add(cardId);
          removedCards.delete(cardId);
        }
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

function applyKnownEvent(
  state: CollectionState,
  event: KnownEvent,
  dirtyCards: Set<string>,
  dirtyDecks: Set<string>,
  dirtyNotes: Set<string>,
  collector?: ApplyMutationCollector,
): void {
  const { hlc } = event;
  switch (event.type) {
    case 'NoteTypeChanged': {
      const nt = event.payload.note_type;
      if (shouldApplyLww(state, `noteType:${nt.id}`, hlc, collector)) {
        state.noteTypes.set(nt.id, {
          ...nt,
          fields: nt.fields.map((f) => ({ ...f })),
        });
        collector?.noteTypeIds.add(nt.id);
      }
      break;
    }
    case 'LayoutChanged': {
      const layout = event.payload.layout;
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
      break;
    }
    case 'DeckCreated': {
      const p = event.payload;
      let deck = state.decks.get(p.deck_id);
      const initialRet = p.settings?.target_retention ?? DEFAULT_FSRS_CONFIG.request_retention;
      if (!deck) {
        const pending = state.pendingDeckPatches.get(p.deck_id);
        if (pending) {
          state.pendingDeckPatches.delete(p.deck_id);
          collector?.pendingDeckPatchKeys.add(p.deck_id);
        }

        const mergedSettings: DeckSettings = { ...DEFAULT_DECK_SETTINGS };
        if (pending?.settings) {
          if (pending.settings.new_cards_per_day !== undefined) {
            mergedSettings.new_cards_per_day = pending.settings.new_cards_per_day;
          }
          if (pending.settings.max_reviews_per_day !== undefined) {
            mergedSettings.max_reviews_per_day = pending.settings.max_reviews_per_day;
          }
          if (pending.settings.target_retention !== undefined) {
            mergedSettings.target_retention = pending.settings.target_retention;
          }
          if (pending.settings.new_card_order !== undefined) {
            mergedSettings.new_card_order = pending.settings.new_card_order;
          }
          if (pending.settings.enabled_layout_ids !== undefined) {
            mergedSettings.enabled_layout_ids = [...pending.settings.enabled_layout_ids];
          }
          if (pending.settings.day_start_hour !== undefined) {
            mergedSettings.day_start_hour = pending.settings.day_start_hour;
          }
        }

        deck = {
          id: p.deck_id,
          name: pending?.name ?? p.name,
          note_type_id: p.note_type_id,
          language: pending?.language ?? p.language,
          settings: mergedSettings,
          initial_retention: initialRet,
          archived: pending?.archived ?? false,
          created_at: p.created_at ?? 0,
        };
        if (pending?.source !== undefined) {
          deck.source = { ...pending.source };
        }
        state.decks.set(p.deck_id, deck);

        // Apply DeckCreated's own fields strictly via LWW so newer out-of-order patches win
        if (shouldApplyLww(state, `deck:${p.deck_id}:name`, hlc, collector)) deck.name = p.name;
        if (shouldApplyLww(state, `deck:${p.deck_id}:note_type_id`, hlc, collector)) {
          deck.note_type_id = p.note_type_id;
        }
        if (shouldApplyLww(state, `deck:${p.deck_id}:language`, hlc, collector)) {
          deck.language = p.language;
        }
        if (shouldApplyLww(state, `deck:${p.deck_id}:archived`, hlc, collector)) {
          deck.archived = false;
        }
        if (shouldApplyLww(state, `deck:${p.deck_id}:initial_retention`, hlc, collector)) {
          deck.initial_retention = initialRet;
        }
        if (
          p.source !== undefined &&
          shouldApplyLww(state, `deck:${p.deck_id}:source`, hlc, collector)
        ) {
          deck.source = { ...p.source };
        }
      } else {
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
        if (
          p.source !== undefined &&
          shouldApplyLww(state, `deck:${p.deck_id}:source`, hlc, collector)
        ) {
          deck.source = { ...p.source };
        }
      }
      if (p.settings) {
        applyDeckSettingsPatchTarget(state, p.deck_id, deck.settings, p.settings, hlc, collector);
      }
      collector?.deckIds.add(p.deck_id);
      dirtyDecks.add(p.deck_id);
      break;
    }
    case 'DeckSettingsChanged': {
      const p = event.payload;
      const deck = state.decks.get(p.deck_id);
      if (!deck) {
        // Buffer out-of-order patch until DeckCreated arrives
        const pending = getOrCreatePendingDeckPatch(state, p.deck_id);
        if (
          p.name !== undefined &&
          shouldApplyLww(state, `deck:${p.deck_id}:name`, hlc, collector)
        ) {
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
          applyDeckSettingsPatchTarget(
            state,
            p.deck_id,
            pending.settings,
            p.settings,
            hlc,
            collector,
          );
        }
        collector?.pendingDeckPatchKeys.add(p.deck_id);
        break;
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
        const deckCards = state.cardIdsByDeck.get(p.deck_id);
        if (deckCards) {
          for (const cardId of deckCards) {
            dirtyCards.add(cardId);
          }
        }
      }
      break;
    }
    case 'DeckFSRSParamsChanged': {
      const p = event.payload;
      if (!shouldApplyLww(state, `deck:${p.deck_id}:fsrs:${p.params_version}`, hlc, collector)) {
        break;
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
      const deckCards = state.cardIdsByDeck.get(p.deck_id);
      if (deckCards) {
        for (const cardId of deckCards) {
          dirtyCards.add(cardId);
        }
      }
      break;
    }
    case 'NoteUpserted': {
      const p = event.payload;
      let note = state.notes.get(p.note_id);
      if (!note) {
        note = {
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
        shouldApplyLww(state, `note:${p.note_id}:deck_id`, hlc, collector);
        shouldApplyLww(state, `note:${p.note_id}:source_key`, hlc, collector);
        if (p.provenance) shouldApplyLww(state, `note:${p.note_id}:provenance`, hlc, collector);
        if (p.created_order !== undefined) {
          shouldApplyLww(state, `note:${p.note_id}:created_order`, hlc, collector);
        }
      } else {
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

      // Per-field LWW for note fields
      for (const [fieldKey, fieldValue] of Object.entries(p.fields)) {
        if (shouldApplyLww(state, `note:${p.note_id}:field:${fieldKey}`, hlc, collector)) {
          note.fields[fieldKey] = fieldValue;
        }
      }

      if (p.tags !== undefined && shouldApplyLww(state, `note:${p.note_id}:tags`, hlc, collector)) {
        note.tags = [...p.tags];
      }

      collector?.noteIds.add(p.note_id);
      dirtyNotes.add(p.note_id);
      break;
    }
    case 'NoteArchived': {
      const p = event.payload;
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
      break;
    }
    case 'NoteRestored': {
      const p = event.payload;
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
      break;
    }
    case 'ReviewRecorded': {
      const p = event.payload;
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
      break;
    }
    case 'ReviewUndone': {
      const p = event.payload;
      if (!state.undoneReviewIds.has(p.review_id)) {
        state.undoneReviewIds.add(p.review_id);
        collector?.addedUndoneReviewIds.add(p.review_id);
      }
      const cardId = state.reviewIdToCardId.get(p.review_id);
      if (cardId !== undefined) {
        dirtyCards.add(cardId);
      }
      break;
    }
    case 'PageUpserted': {
      const p = event.payload;
      const pending = state.pendingPagePatches.get(p.page_id);
      if (pending) {
        state.pendingPagePatches.delete(p.page_id);
        collector?.pendingPagePatchKeys.add(p.page_id);
      }
      const existing = state.pages.get(p.page_id);

      if (shouldApplyLww(state, `page:${p.page_id}`, hlc, collector)) {
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
        if (
          p.source !== undefined &&
          shouldApplyLww(state, `page:${p.page_id}:source`, hlc, collector)
        ) {
          page.source = { ...p.source };
        }
        const resolvedReadAt = existing?.read_at ?? pending?.read_at;
        if (resolvedReadAt !== undefined) page.read_at = resolvedReadAt;
        state.pages.set(p.page_id, page);
        collector?.pageIds.add(p.page_id);
      } else if (existing && p.source !== undefined) {
        if (shouldApplyLww(state, `page:${p.page_id}:source`, hlc, collector)) {
          existing.source = { ...p.source };
          collector?.pageIds.add(p.page_id);
        }
      }
      break;
    }
    case 'PageRead': {
      const p = event.payload;
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
      break;
    }
    case 'CourseChanged': {
      const c = event.payload.course;
      if (shouldApplyLww(state, `course:${c.id}`, hlc, collector)) {
        state.courses.set(c.id, {
          ...c,
          items: c.items.map((item) => ({ ...item })),
        });
        collector?.courseIds.add(c.id);
      }
      break;
    }
    case 'MediaAdded': {
      const m = event.payload.media;
      const normHash = m.hash.toLowerCase();
      const prev = state.media.get(normHash);
      const nextEntry: MediaEntry = {
        hash: normHash,
        ext: m.ext.toLowerCase(),
        mime: m.mime,
        size: m.size,
        ...(prev?.tts_key !== undefined ? { tts_key: prev.tts_key } : {}),
        ...(prev?.tts_lang_key !== undefined ? { tts_lang_key: prev.tts_lang_key } : {}),
        ...(m.tts_key !== undefined ? { tts_key: m.tts_key } : {}),
        ...(m.tts_lang_key !== undefined ? { tts_lang_key: m.tts_lang_key } : {}),
      };
      state.media.set(normHash, nextEntry);
      if (
        nextEntry.tts_key &&
        shouldApplyLww(state, `tts:key:${nextEntry.tts_key}`, hlc, collector)
      ) {
        state.ttsMediaByKey.set(nextEntry.tts_key, normHash);
        collector?.ttsKeys.add(nextEntry.tts_key);
      }
      if (
        nextEntry.tts_lang_key &&
        shouldApplyLww(state, `tts:lang:${nextEntry.tts_lang_key}`, hlc, collector)
      ) {
        state.ttsMediaByLangKey.set(nextEntry.tts_lang_key, normHash);
        collector?.ttsLangKeys.add(nextEntry.tts_lang_key);
      }
      collector?.mediaHashes.add(normHash);
      break;
    }
    case 'SourceLinked': {
      const p = event.payload;
      if (p.target_kind === 'deck') {
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
      } else {
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
      break;
    }
    case 'PreferencesChanged': {
      const pref = event.payload.preferences;
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
      if (pref.tts_voices !== undefined) {
        for (const [langKey, voiceVal] of Object.entries(pref.tts_voices)) {
          if (shouldApplyLww(state, `prefs:tts_voices:${langKey}`, hlc, collector)) {
            const trimmed = voiceVal.trim();
            const entries = Object.entries(state.preferences.tts_voices ?? {}).filter(
              ([k]) => k !== langKey,
            );
            if (trimmed) {
              entries.push([langKey, trimmed]);
            }
            if (entries.length > 0) {
              state.preferences.tts_voices = Object.fromEntries(entries);
            } else {
              delete state.preferences.tts_voices;
            }
            changed = true;
          }
        }
      }
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
      if (changed && collector) {
        collector.preferencesChanged = true;
      }
      break;
    }
    case 'CardSuspended':
    case 'CardUnsuspended': {
      // Grow-only HLC registers in `fieldHlcs` (see ./suspension.ts); no card rebuild needed.
      const key = applySuspensionRegister(state.fieldHlcs, event.type, event.payload, hlc);
      if (key !== undefined) collector?.fieldHlcKeys.add(key);
      break;
    }
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

    if (isKnownEventType(event.type)) {
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
  for (const cardId of dirtyCards) {
    if (replayedCards.has(cardId)) continue;
    const updated = replaySingleCard(state, cardId);
    if (updated) {
      changedCards.add(cardId);
      removedCards.delete(cardId);
    }
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
 * - Unknown future event types are preserved in `state.unknownEvents` without crashing.
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
    setHlc: (nextHlc: HlcState) => {
      hlcState = nextHlc;
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
