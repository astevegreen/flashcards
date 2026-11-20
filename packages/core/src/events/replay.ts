import {
  applyReviewToSchedule,
  createInitialSchedule,
  DEFAULT_FSRS_CONFIG,
} from '../fsrs/scheduler.ts';
import { compareHlc, tickHlc, type HlcState } from '../hlc.ts';
import { deriveCardId, uuidv7 } from '../ids.ts';
import { BUILTIN_LAYOUTS, BUILTIN_NOTE_TYPES } from '../model/presets.ts';
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
  /** Seen event IDs for idempotent event application. */
  appliedEventIds: Set<string>;
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
  };
}

function shouldApplyLww(state: CollectionState, key: string, incomingHlc: string): boolean {
  const existing = state.fieldHlcs.get(key);
  if (existing === undefined || compareHlc(incomingHlc, existing) >= 0) {
    state.fieldHlcs.set(key, incomingHlc);
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

  // Versions are kept sorted ascending by params_version
  const latest = versions[versions.length - 1];
  if (
    latest &&
    'reschedule_existing' in latest &&
    (latest as DeckFSRSParamsVersion & { reschedule_existing?: boolean }).reschedule_existing
  ) {
    return {
      ...DEFAULT_FSRS_CONFIG,
      ...latest.params,
    };
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

  state.cards.set(cardId, updated);
  return updated;
}

function rebuildCardsForDeck(state: CollectionState, deckId: string): void {
  const deck = state.decks.get(deckId);
  // Remove existing derived cards for this deck
  for (const [cardId, card] of state.cards.entries()) {
    if (card.deck_id === deckId) {
      state.cards.delete(cardId);
    }
  }

  if (!deck || deck.archived) return;

  const enabledLayouts = getEnabledLayoutsForDeck(state, deck);
  for (const note of state.notes.values()) {
    if (note.deck_id !== deckId || note.archived) continue;
    for (const layout of enabledLayouts) {
      const cardId = deriveCardId(note.id, layout.id, 0);
      state.cards.set(cardId, {
        id: cardId,
        note_id: note.id,
        deck_id: deckId,
        layout_id: layout.id,
        variant: 0,
        schedule: createInitialSchedule(0),
      });
      replaySingleCard(state, cardId);
    }
  }
}

function rebuildCardsForNote(state: CollectionState, noteId: string): void {
  const note = state.notes.get(noteId);
  for (const [cardId, card] of state.cards.entries()) {
    if (card.note_id === noteId) {
      state.cards.delete(cardId);
    }
  }
  if (!note || note.archived) return;
  const deck = state.decks.get(note.deck_id);
  if (!deck || deck.archived) return;

  const enabledLayouts = getEnabledLayoutsForDeck(state, deck);
  for (const layout of enabledLayouts) {
    const cardId = deriveCardId(note.id, layout.id, 0);
    state.cards.set(cardId, {
      id: cardId,
      note_id: note.id,
      deck_id: deck.id,
      layout_id: layout.id,
      variant: 0,
      schedule: createInitialSchedule(0),
    });
    replaySingleCard(state, cardId);
  }
}

function applyDeckSettingsPatchTarget(
  state: CollectionState,
  deckId: string,
  target: Partial<DeckSettings>,
  settings: Partial<DeckSettings>,
  hlc: string,
): boolean {
  let layoutsChanged = false;

  if (
    settings.new_cards_per_day !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:new_cards_per_day`, hlc)
  ) {
    target.new_cards_per_day = settings.new_cards_per_day;
  }
  if (
    settings.max_reviews_per_day !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:max_reviews_per_day`, hlc)
  ) {
    target.max_reviews_per_day = settings.max_reviews_per_day;
  }
  if (
    settings.target_retention !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:target_retention`, hlc)
  ) {
    target.target_retention = settings.target_retention;
  }
  if (
    settings.new_card_order !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:new_card_order`, hlc)
  ) {
    target.new_card_order = settings.new_card_order;
  }
  if (
    settings.enabled_layout_ids !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:enabled_layout_ids`, hlc)
  ) {
    target.enabled_layout_ids = [...settings.enabled_layout_ids];
    layoutsChanged = true;
  }
  if (
    settings.day_start_hour !== undefined &&
    shouldApplyLww(state, `deck:${deckId}:settings:day_start_hour`, hlc)
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
): void {
  const { hlc } = event;
  switch (event.type) {
    case 'NoteTypeChanged': {
      const nt = event.payload.note_type;
      if (shouldApplyLww(state, `noteType:${nt.id}`, hlc)) {
        state.noteTypes.set(nt.id, {
          ...nt,
          fields: nt.fields.map((f) => ({ ...f })),
        });
      }
      break;
    }
    case 'LayoutChanged': {
      const layout = event.payload.layout;
      if (shouldApplyLww(state, `layout:${layout.id}`, hlc)) {
        state.layouts.set(layout.id, {
          ...layout,
          front_fields: [...layout.front_fields],
          reveal_steps: layout.reveal_steps.map((s) => [...s]),
        });
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
        state.pendingDeckPatches.delete(p.deck_id);

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
        if (shouldApplyLww(state, `deck:${p.deck_id}:name`, hlc)) deck.name = p.name;
        if (shouldApplyLww(state, `deck:${p.deck_id}:note_type_id`, hlc)) {
          deck.note_type_id = p.note_type_id;
        }
        if (shouldApplyLww(state, `deck:${p.deck_id}:language`, hlc)) deck.language = p.language;
        if (shouldApplyLww(state, `deck:${p.deck_id}:archived`, hlc)) deck.archived = false;
        if (shouldApplyLww(state, `deck:${p.deck_id}:initial_retention`, hlc)) {
          deck.initial_retention = initialRet;
        }
        if (p.source !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:source`, hlc)) {
          deck.source = { ...p.source };
        }
      } else {
        if (shouldApplyLww(state, `deck:${p.deck_id}:name`, hlc)) deck.name = p.name;
        if (shouldApplyLww(state, `deck:${p.deck_id}:note_type_id`, hlc)) {
          deck.note_type_id = p.note_type_id;
        }
        if (shouldApplyLww(state, `deck:${p.deck_id}:language`, hlc)) deck.language = p.language;
        if (shouldApplyLww(state, `deck:${p.deck_id}:initial_retention`, hlc)) {
          deck.initial_retention = initialRet;
        }
        if (p.source !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:source`, hlc)) {
          deck.source = { ...p.source };
        }
      }
      if (p.settings) {
        applyDeckSettingsPatchTarget(state, p.deck_id, deck.settings, p.settings, hlc);
      }
      dirtyDecks.add(p.deck_id);
      break;
    }
    case 'DeckSettingsChanged': {
      const p = event.payload;
      const deck = state.decks.get(p.deck_id);
      if (!deck) {
        // Buffer out-of-order patch until DeckCreated arrives
        const pending = getOrCreatePendingDeckPatch(state, p.deck_id);
        if (p.name !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:name`, hlc)) {
          pending.name = p.name;
        }
        if (p.language !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:language`, hlc)) {
          pending.language = p.language;
        }
        if (p.archived !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:archived`, hlc)) {
          pending.archived = p.archived;
        }
        if (p.settings) {
          applyDeckSettingsPatchTarget(state, p.deck_id, pending.settings, p.settings, hlc);
        }
        break;
      }
      let mustRebuildDeck = false;
      if (p.name !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:name`, hlc)) {
        deck.name = p.name;
      }
      if (p.language !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:language`, hlc)) {
        deck.language = p.language;
      }
      if (p.archived !== undefined && shouldApplyLww(state, `deck:${p.deck_id}:archived`, hlc)) {
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
        );
        if (layoutsChanged) mustRebuildDeck = true;
      }
      if (mustRebuildDeck) {
        dirtyDecks.add(p.deck_id);
      } else if (p.settings?.target_retention !== undefined) {
        // Re-evaluate cards only if no versioned FSRS params exist for this deck
        for (const card of state.cards.values()) {
          if (card.deck_id === p.deck_id) dirtyCards.add(card.id);
        }
      }
      break;
    }
    case 'DeckFSRSParamsChanged': {
      const p = event.payload;
      if (!shouldApplyLww(state, `deck:${p.deck_id}:fsrs:${p.params_version}`, hlc)) {
        break;
      }
      const existing = state.deckFsrsParams.get(p.deck_id) ?? [];
      const filtered = existing.filter((v) => v.params_version !== p.params_version);
      const entry: DeckFSRSParamsVersion & { reschedule_existing?: boolean } = {
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
      for (const card of state.cards.values()) {
        if (card.deck_id === p.deck_id) {
          dirtyCards.add(card.id);
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
        shouldApplyLww(state, `note:${p.note_id}:deck_id`, hlc);
        shouldApplyLww(state, `note:${p.note_id}:source_key`, hlc);
        if (p.provenance) shouldApplyLww(state, `note:${p.note_id}:provenance`, hlc);
        if (p.created_order !== undefined) {
          shouldApplyLww(state, `note:${p.note_id}:created_order`, hlc);
        }
      } else {
        if (shouldApplyLww(state, `note:${p.note_id}:deck_id`, hlc)) {
          if (note.deck_id !== p.deck_id) {
            dirtyDecks.add(note.deck_id);
          }
          note.deck_id = p.deck_id;
        }
        if (shouldApplyLww(state, `note:${p.note_id}:source_key`, hlc)) {
          note.source_key = p.source_key;
        }
        if (p.provenance && shouldApplyLww(state, `note:${p.note_id}:provenance`, hlc)) {
          note.provenance = { ...p.provenance };
        }
        if (
          p.created_order !== undefined &&
          shouldApplyLww(state, `note:${p.note_id}:created_order`, hlc)
        ) {
          note.created_order = p.created_order;
        }
      }

      // Per-field LWW for note fields
      for (const [fieldKey, fieldValue] of Object.entries(p.fields)) {
        if (shouldApplyLww(state, `note:${p.note_id}:field:${fieldKey}`, hlc)) {
          note.fields[fieldKey] = fieldValue;
        }
      }

      if (p.tags !== undefined && shouldApplyLww(state, `note:${p.note_id}:tags`, hlc)) {
        note.tags = [...p.tags];
      }

      dirtyNotes.add(p.note_id);
      break;
    }
    case 'NoteArchived': {
      const p = event.payload;
      if (shouldApplyLww(state, `note:${p.note_id}:archived`, hlc)) {
        state.noteArchivedState.set(p.note_id, true);
        const note = state.notes.get(p.note_id);
        if (note) {
          note.archived = true;
          dirtyNotes.add(p.note_id);
        }
      }
      break;
    }
    case 'NoteRestored': {
      const p = event.payload;
      if (shouldApplyLww(state, `note:${p.note_id}:archived`, hlc)) {
        state.noteArchivedState.set(p.note_id, false);
        const note = state.notes.get(p.note_id);
        if (note) {
          note.archived = false;
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
      }
      dirtyCards.add(p.card_id);
      break;
    }
    case 'ReviewUndone': {
      const p = event.payload;
      state.undoneReviewIds.add(p.review_id);
      // Mark whichever card owns this review_id dirty
      for (const [cardId, list] of state.reviewsByCard.entries()) {
        if (list.some((r) => r.review_id === p.review_id)) {
          dirtyCards.add(cardId);
          break;
        }
      }
      break;
    }
    case 'PageUpserted': {
      const p = event.payload;
      const pending = state.pendingPagePatches.get(p.page_id);
      state.pendingPagePatches.delete(p.page_id);
      const existing = state.pages.get(p.page_id);

      if (shouldApplyLww(state, `page:${p.page_id}`, hlc)) {
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
        if (p.source !== undefined && shouldApplyLww(state, `page:${p.page_id}:source`, hlc)) {
          page.source = { ...p.source };
        }
        const resolvedReadAt = existing?.read_at ?? pending?.read_at;
        if (resolvedReadAt !== undefined) page.read_at = resolvedReadAt;
        state.pages.set(p.page_id, page);
      } else if (existing && p.source !== undefined) {
        if (shouldApplyLww(state, `page:${p.page_id}:source`, hlc)) {
          existing.source = { ...p.source };
        }
      }
      break;
    }
    case 'PageRead': {
      const p = event.payload;
      if (shouldApplyLww(state, `page:${p.page_id}:read_at`, hlc)) {
        const page = state.pages.get(p.page_id);
        if (page) {
          page.read_at = p.read_at;
        } else {
          const pending = getOrCreatePendingPagePatch(state, p.page_id);
          pending.read_at = p.read_at;
        }
      }
      break;
    }
    case 'CourseChanged': {
      const c = event.payload.course;
      if (shouldApplyLww(state, `course:${c.id}`, hlc)) {
        state.courses.set(c.id, {
          ...c,
          items: c.items.map((item) => ({ ...item })),
        });
      }
      break;
    }
    case 'MediaAdded': {
      const m = event.payload.media;
      state.media.set(m.hash, { ...m });
      break;
    }
    case 'SourceLinked': {
      const p = event.payload;
      if (p.target_kind === 'deck') {
        if (shouldApplyLww(state, `deck:${p.target_id}:source`, hlc)) {
          const deck = state.decks.get(p.target_id);
          if (deck) {
            deck.source = { ...p.source };
          } else {
            const pending = getOrCreatePendingDeckPatch(state, p.target_id);
            pending.source = { ...p.source };
          }
        }
      } else {
        if (shouldApplyLww(state, `page:${p.target_id}:source`, hlc)) {
          const page = state.pages.get(p.target_id);
          if (page) {
            page.source = { ...p.source };
          } else {
            const pending = getOrCreatePendingPagePatch(state, p.target_id);
            pending.source = { ...p.source };
          }
        }
      }
      break;
    }
    case 'PreferencesChanged': {
      const pref = event.payload.preferences;
      if (
        pref.rating_button_mode !== undefined &&
        shouldApplyLww(state, 'prefs:rating_button_mode', hlc)
      ) {
        state.preferences.rating_button_mode = pref.rating_button_mode;
      }
      if (pref.day_start_hour !== undefined && shouldApplyLww(state, 'prefs:day_start_hour', hlc)) {
        state.preferences.day_start_hour = pref.day_start_hour;
      }
      if (
        pref.pinyin_tone_colors !== undefined &&
        shouldApplyLww(state, 'prefs:pinyin_tone_colors', hlc)
      ) {
        state.preferences.pinyin_tone_colors = pref.pinyin_tone_colors;
      }
      break;
    }
  }
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
  if (events.length === 0) return state;

  // Sort incoming events by (hlc, id) so entity creation before updates works even if chunks arrive out of order
  const sorted = [...events].sort((a, b) => {
    const hlcCmp = compareHlc(a.hlc, b.hlc);
    if (hlcCmp !== 0) return hlcCmp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const dirtyCards = new Set<string>();
  const dirtyDecks = new Set<string>();
  const dirtyNotes = new Set<string>();

  for (const event of sorted) {
    if (state.appliedEventIds.has(event.id)) continue;
    state.appliedEventIds.add(event.id);

    if (isKnownEventType(event.type)) {
      applyKnownEvent(state, event as KnownEvent, dirtyCards, dirtyDecks, dirtyNotes);
    } else {
      state.unknownEvents.push(event);
    }
  }

  for (const deckId of dirtyDecks) {
    rebuildCardsForDeck(state, deckId);
  }
  for (const noteId of dirtyNotes) {
    const note = state.notes.get(noteId);
    if (!note || !dirtyDecks.has(note.deck_id)) {
      rebuildCardsForNote(state, noteId);
    }
  }
  for (const cardId of dirtyCards) {
    replaySingleCard(state, cardId);
  }

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
  getHlc(): HlcState;
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
    getHlc: () => hlcState,
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
