import type {
  Card,
  CollectionPreferences,
  Course,
  Deck,
  DeckFSRSParamsVersion,
  Layout,
  MediaEntry,
  Note,
  NoteType,
  Page,
  ReviewRecord,
} from '../model/types.ts';
import {
  getTotalAppliedEventCount,
  type CollectionState,
  type PendingDeckPatch,
  type PendingPagePatch,
} from './replay.ts';
import {
  canonicalizeAllTagAddNotes,
  canonicalizeOptionalCards,
  foldMediaRemovedFromUnknown,
  foldSourceUnlinkedFromUnknown,
  foldSuspensionEventsFromUnknown,
  foldTagAddEventsFromUnknown,
} from './snapshot-upgrade.ts';
import { compareHlc } from '../hlc.ts';
import { SERIALIZED_STATE_FORMAT_VERSION } from './snapshot-format.ts';
import type { UnknownEvent } from './types.ts';

export { SERIALIZED_STATE_FORMAT_VERSION, snapshotLacksMediaRecords } from './snapshot-format.ts';

/**
 * Gives each media entry of a version 1 snapshot an add register at the newest register HLC the
 * snapshot holds (the notes that use a file are written after it, so the true add is no newer), and any removal newer than that still wins; only a removal
 * older than the snapshot but newer than the add (an offline device catching up) keeps the file
 * here, where a full replay would drop it. Keeping is the safe side: nothing a note uses is lost.
 */
function restoreMediaAddRecords(state: CollectionState): void {
  let newest: string | undefined;
  for (const h of state.fieldHlcs.values()) {
    if (newest === undefined || compareHlc(h, newest) > 0) newest = h;
  }
  if (newest === undefined) return;
  for (const hash of state.media.keys()) {
    const key = `media:${hash}:added`;
    if (!state.fieldHlcs.has(key)) state.fieldHlcs.set(key, newest);
  }
}

/**
 * Snapshots from before per-field media registers (D20) hold `tts_key` / `tts_lang_key` with no
 * `media:<hash>:<field>` register. Each gets the entry's add register: the key came from an add no
 * newer than that, so a late older add cannot overwrite it, and a removal older than the newest
 * add keeps it, which is what a full replay does whenever the newest add carried the key.
 */
function restoreMediaFieldRecords(state: CollectionState): void {
  for (const [hash, entry] of state.media) {
    const addedAt = state.fieldHlcs.get(`media:${hash}:added`);
    if (addedAt === undefined) continue;
    for (const f of ['tts_key', 'tts_lang_key'] as const) {
      const key = `media:${hash}:${f}`;
      if (entry[f] !== undefined && !state.fieldHlcs.has(key)) state.fieldHlcs.set(key, addedAt);
    }
  }
}

/**
 * Pure JS JSON-safe and structured-cloneable snapshot of `CollectionState`.
 * Zero `fflate` dependency so cold-start local snapshot hydration stays inside
 * the initial bundle budget (§8).
 */
export interface SerializedCollectionState {
  formatVersion: number;
  totalEvents: number;
  watermarks: Record<string, number>;
  noteTypes: NoteType[];
  layouts: Layout[];
  decks: Deck[];
  notes: Note[];
  cards: Card[];
  reviewsByCard: Record<string, ReviewRecord[]>;
  undoneReviewIds: string[];
  deckFsrsParams: Record<string, DeckFSRSParamsVersion[]>;
  pages: Page[];
  courses: Course[];
  media: MediaEntry[];
  ttsMediaByKey?: Record<string, string>;
  ttsMediaByLangKey?: Record<string, string>;
  preferences: CollectionPreferences;
  unknownEvents: UnknownEvent[];
  fieldHlcs: Record<string, string>;
  noteArchivedState: Record<string, boolean>;
  pendingDeckPatches: Record<string, PendingDeckPatch>;
  pendingPagePatches: Record<string, PendingPagePatch>;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function addToMapSet(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

/**
 * Deterministically serializes `CollectionState` into a plain JSON-safe object.
 * Merges `state.snapshotWatermarks` with `watermarks` (taking max per device).
 */
export function serializeCollectionState(
  state: CollectionState,
  watermarks: Record<string, number> = {},
): SerializedCollectionState {
  const mergedWatermarks: Record<string, number> = {};
  for (const [dev, seq] of state.snapshotWatermarks.entries()) {
    if (seq > 0) mergedWatermarks[dev] = seq;
  }
  for (const [dev, seq] of Object.entries(watermarks)) {
    if (seq > 0) {
      mergedWatermarks[dev] = Math.max(mergedWatermarks[dev] ?? 0, seq);
    }
  }

  const sortedWatermarks: Record<string, number> = {};
  for (const dev of Object.keys(mergedWatermarks).sort(cmpStr)) {
    const val = mergedWatermarks[dev];
    if (val !== undefined) sortedWatermarks[dev] = val;
  }

  const noteTypes = [...state.noteTypes.values()]
    .sort((a, b) => cmpStr(a.id, b.id))
    .map((nt) => ({ ...nt, fields: nt.fields.map((f) => ({ ...f })) }));

  const layouts = [...state.layouts.values()]
    .sort((a, b) => cmpStr(a.id, b.id))
    .map((l) => ({
      ...l,
      front_fields: [...l.front_fields],
      reveal_steps: l.reveal_steps.map((s) => [...s]),
    }));

  const decks = [...state.decks.values()]
    .sort((a, b) => cmpStr(a.id, b.id))
    .map((d) => ({
      ...d,
      settings: {
        ...d.settings,
        ...(d.settings.enabled_layout_ids !== undefined
          ? { enabled_layout_ids: [...d.settings.enabled_layout_ids] }
          : {}),
      },
      ...(d.source !== undefined ? { source: { ...d.source } } : {}),
    }));

  const notes = [...state.notes.values()]
    .sort((a, b) => cmpStr(a.id, b.id))
    .map((n) => ({
      ...n,
      fields: { ...n.fields },
      tags: [...n.tags],
      provenance: { ...n.provenance },
    }));

  const cards = [...state.cards.values()]
    .sort((a, b) => cmpStr(a.id, b.id))
    .map((c) => ({
      ...c,
      schedule: { ...c.schedule },
    }));

  const reviewsByCard: Record<string, ReviewRecord[]> = {};
  for (const cardId of [...state.reviewsByCard.keys()].sort(cmpStr)) {
    const list = state.reviewsByCard.get(cardId);
    if (list && list.length > 0) {
      reviewsByCard[cardId] = list.map((r) => ({ ...r }));
    }
  }

  const undoneReviewIds = [...state.undoneReviewIds].sort(cmpStr);

  const deckFsrsParams: Record<string, DeckFSRSParamsVersion[]> = {};
  for (const deckId of [...state.deckFsrsParams.keys()].sort(cmpStr)) {
    const list = state.deckFsrsParams.get(deckId);
    if (list && list.length > 0) {
      deckFsrsParams[deckId] = list.map((v) => ({
        ...v,
        params: {
          ...v.params,
          ...(v.params.w !== undefined ? { w: [...v.params.w] } : {}),
        },
      }));
    }
  }

  const pages = [...state.pages.values()]
    .sort((a, b) => cmpStr(a.id, b.id))
    .map((p) => ({
      ...p,
      tags: [...p.tags],
      ...(p.source !== undefined ? { source: { ...p.source } } : {}),
    }));

  const courses = [...state.courses.values()]
    .sort((a, b) => cmpStr(a.id, b.id))
    .map((c) => ({
      ...c,
      items: c.items.map((item) => ({ ...item })),
    }));

  const media = [...state.media.values()]
    .sort((a, b) => cmpStr(a.hash, b.hash))
    .map((m) => ({ ...m }));

  const ttsMediaByKey: Record<string, string> = {};
  for (const k of [...state.ttsMediaByKey.keys()].sort(cmpStr)) {
    const v = state.ttsMediaByKey.get(k);
    if (v !== undefined) ttsMediaByKey[k] = v;
  }

  const ttsMediaByLangKey: Record<string, string> = {};
  for (const k of [...state.ttsMediaByLangKey.keys()].sort(cmpStr)) {
    const v = state.ttsMediaByLangKey.get(k);
    if (v !== undefined) ttsMediaByLangKey[k] = v;
  }

  const fieldHlcs: Record<string, string> = {};
  for (const k of [...state.fieldHlcs.keys()].sort(cmpStr)) {
    const v = state.fieldHlcs.get(k);
    if (v !== undefined) fieldHlcs[k] = v;
  }

  const noteArchivedState: Record<string, boolean> = {};
  for (const k of [...state.noteArchivedState.keys()].sort(cmpStr)) {
    const v = state.noteArchivedState.get(k);
    if (v !== undefined) noteArchivedState[k] = v;
  }

  const pendingDeckPatches: Record<string, PendingDeckPatch> = {};
  for (const k of [...state.pendingDeckPatches.keys()].sort(cmpStr)) {
    const v = state.pendingDeckPatches.get(k);
    if (v !== undefined) {
      pendingDeckPatches[k] = {
        ...v,
        settings: {
          ...v.settings,
          ...(v.settings.enabled_layout_ids !== undefined
            ? { enabled_layout_ids: [...v.settings.enabled_layout_ids] }
            : {}),
        },
        ...(v.source !== undefined ? { source: { ...v.source } } : {}),
      };
    }
  }

  const pendingPagePatches: Record<string, PendingPagePatch> = {};
  for (const k of [...state.pendingPagePatches.keys()].sort(cmpStr)) {
    const v = state.pendingPagePatches.get(k);
    if (v !== undefined) {
      pendingPagePatches[k] = {
        ...v,
        ...(v.source !== undefined ? { source: { ...v.source } } : {}),
      };
    }
  }

  const sortedTtsVoices = state.preferences.tts_voices
    ? Object.fromEntries(
        Object.keys(state.preferences.tts_voices)
          .sort(cmpStr)
          .map((k) => [k, state.preferences.tts_voices?.[k] ?? '']),
      )
    : undefined;

  const sortedDrawingModes = state.preferences.drawing_modes
    ? Object.fromEntries(
        Object.keys(state.preferences.drawing_modes)
          .sort(cmpStr)
          .map((k) => [k, state.preferences.drawing_modes?.[k] ?? 'off']),
      )
    : undefined;

  const sortedLanguages = state.preferences.languages
    ? Object.fromEntries(
        Object.keys(state.preferences.languages)
          .sort(cmpStr)
          .map((k) => [k, state.preferences.languages?.[k] === true]),
      )
    : undefined;

  return {
    formatVersion: SERIALIZED_STATE_FORMAT_VERSION,
    totalEvents: getTotalAppliedEventCount(state),
    watermarks: sortedWatermarks,
    noteTypes,
    layouts,
    decks,
    notes,
    cards,
    reviewsByCard,
    undoneReviewIds,
    deckFsrsParams,
    pages,
    courses,
    media,
    ...(Object.keys(ttsMediaByKey).length > 0 ? { ttsMediaByKey } : {}),
    ...(Object.keys(ttsMediaByLangKey).length > 0 ? { ttsMediaByLangKey } : {}),
    preferences: {
      ...state.preferences,
      ...(sortedTtsVoices !== undefined ? { tts_voices: sortedTtsVoices } : {}),
      ...(sortedDrawingModes !== undefined ? { drawing_modes: sortedDrawingModes } : {}),
      ...(sortedLanguages !== undefined ? { languages: sortedLanguages } : {}),
    },
    unknownEvents: state.unknownEvents.map((ev) => cloneJsonValue(ev)),
    fieldHlcs,
    noteArchivedState,
    pendingDeckPatches,
    pendingPagePatches,
  };
}

/**
 * Hydrates a `CollectionState` from a `SerializedCollectionState` in a single O(N) pass
 * with zero FSRS recalculation, rebuilding all secondary indexes deterministically.
 */
export function deserializeCollectionState(serialized: SerializedCollectionState): CollectionState {
  const noteTypes = new Map<string, NoteType>();
  for (const nt of serialized.noteTypes) {
    noteTypes.set(nt.id, { ...nt, fields: nt.fields.map((f) => ({ ...f })) });
  }

  const layouts = new Map<string, Layout>();
  for (const l of serialized.layouts) {
    layouts.set(l.id, {
      ...l,
      front_fields: [...l.front_fields],
      reveal_steps: l.reveal_steps.map((s) => [...s]),
    });
  }

  const decks = new Map<string, Deck>();
  for (const d of serialized.decks) {
    decks.set(d.id, {
      ...d,
      settings: {
        ...d.settings,
        ...(d.settings.enabled_layout_ids !== undefined
          ? { enabled_layout_ids: [...d.settings.enabled_layout_ids] }
          : {}),
      },
      ...(d.source !== undefined ? { source: { ...d.source } } : {}),
    });
  }

  const notes = new Map<string, Note>();
  const noteIdsByDeck = new Map<string, Set<string>>();
  for (const n of serialized.notes) {
    notes.set(n.id, {
      ...n,
      fields: { ...n.fields },
      tags: [...n.tags],
      provenance: { ...n.provenance },
    });
    addToMapSet(noteIdsByDeck, n.deck_id, n.id);
  }

  const cards = new Map<string, Card>();
  const cardIdsByNote = new Map<string, Set<string>>();
  const cardIdsByDeck = new Map<string, Set<string>>();
  for (const c of serialized.cards) {
    cards.set(c.id, { ...c, schedule: { ...c.schedule } });
    addToMapSet(cardIdsByNote, c.note_id, c.id);
    addToMapSet(cardIdsByDeck, c.deck_id, c.id);
  }

  const reviewsByCard = new Map<string, ReviewRecord[]>();
  const reviewIdToCardId = new Map<string, string>();
  for (const [cardId, list] of Object.entries(serialized.reviewsByCard)) {
    const cloned = list.map((r) => ({ ...r }));
    reviewsByCard.set(cardId, cloned);
    for (const r of cloned) {
      reviewIdToCardId.set(r.review_id, cardId);
    }
  }

  const undoneReviewIds = new Set<string>(serialized.undoneReviewIds);

  const deckFsrsParams = new Map<string, DeckFSRSParamsVersion[]>();
  for (const [deckId, list] of Object.entries(serialized.deckFsrsParams)) {
    deckFsrsParams.set(
      deckId,
      list.map((v) => ({
        ...v,
        params: {
          ...v.params,
          ...(v.params.w !== undefined ? { w: [...v.params.w] } : {}),
        },
      })),
    );
  }

  const pages = new Map<string, Page>();
  for (const p of serialized.pages) {
    pages.set(p.id, {
      ...p,
      tags: [...p.tags],
      ...(p.source !== undefined ? { source: { ...p.source } } : {}),
    });
  }

  const courses = new Map<string, Course>();
  for (const c of serialized.courses) {
    courses.set(c.id, {
      ...c,
      items: c.items.map((item) => ({ ...item })),
    });
  }

  const media = new Map<string, MediaEntry>();
  const ttsMediaByKey = new Map<string, string>();
  const ttsMediaByLangKey = new Map<string, string>();
  for (const m of serialized.media) {
    const normHash = m.hash.toLowerCase();
    const entry: MediaEntry = { ...m, hash: normHash };
    media.set(normHash, entry);
    if (entry.tts_key) {
      ttsMediaByKey.set(entry.tts_key, normHash);
    }
    if (entry.tts_lang_key) {
      ttsMediaByLangKey.set(entry.tts_lang_key, normHash);
    }
  }
  if (serialized.ttsMediaByKey) {
    for (const [k, v] of Object.entries(serialized.ttsMediaByKey)) {
      ttsMediaByKey.set(k, v.toLowerCase());
    }
  }
  if (serialized.ttsMediaByLangKey) {
    for (const [k, v] of Object.entries(serialized.ttsMediaByLangKey)) {
      ttsMediaByLangKey.set(k, v.toLowerCase());
    }
  }

  const fieldHlcs = new Map<string, string>(Object.entries(serialized.fieldHlcs));
  // Snapshots from builds that predate card suspension carry those events as unknown. The events
  // themselves are shared, not deep-cloned (P9): replay and the folds only read them, and the
  // serialized snapshot is a fresh parse or a stored copy that nothing else holds.
  const unknownEvents = foldSuspensionEventsFromUnknown(fieldHlcs, serialized.unknownEvents);
  const noteArchivedState = new Map<string, boolean>(Object.entries(serialized.noteArchivedState));

  const pendingDeckPatches = new Map<string, PendingDeckPatch>();
  for (const [deckId, patch] of Object.entries(serialized.pendingDeckPatches)) {
    pendingDeckPatches.set(deckId, {
      ...patch,
      settings: {
        ...patch.settings,
        ...(patch.settings.enabled_layout_ids !== undefined
          ? { enabled_layout_ids: [...patch.settings.enabled_layout_ids] }
          : {}),
      },
      ...(patch.source !== undefined ? { source: { ...patch.source } } : {}),
    });
  }

  const pendingPagePatches = new Map<string, PendingPagePatch>();
  for (const [pageId, patch] of Object.entries(serialized.pendingPagePatches)) {
    pendingPagePatches.set(pageId, {
      ...patch,
      ...(patch.source !== undefined ? { source: { ...patch.source } } : {}),
    });
  }

  const snapshotWatermarks = new Map<string, number>();
  for (const [dev, seq] of Object.entries(serialized.watermarks)) {
    if (typeof seq === 'number' && seq > 0) {
      snapshotWatermarks.set(dev, seq);
    }
  }

  const state: CollectionState = {
    noteTypes,
    layouts,
    decks,
    notes,
    cards,
    reviewsByCard,
    undoneReviewIds,
    deckFsrsParams,
    pages,
    courses,
    media,
    preferences: {
      ...serialized.preferences,
      ...(serialized.preferences.tts_voices !== undefined
        ? { tts_voices: { ...serialized.preferences.tts_voices } }
        : {}),
      ...(serialized.preferences.drawing_modes !== undefined
        ? { drawing_modes: { ...serialized.preferences.drawing_modes } }
        : {}),
      ...(serialized.preferences.languages !== undefined
        ? { languages: { ...serialized.preferences.languages } }
        : {}),
    },
    unknownEvents,
    fieldHlcs,
    noteArchivedState,
    pendingDeckPatches,
    pendingPagePatches,
    appliedEventIds: new Set(),
    cardIdsByNote,
    cardIdsByDeck,
    noteIdsByDeck,
    reviewIdToCardId,
    ttsMediaByKey,
    ttsMediaByLangKey,
    snapshotWatermarks,
    snapshotEventCount: serialized.totalEvents,
  };
  // Before folding removals: a version 1 snapshot has no add registers for its media.
  if (serialized.formatVersion < 2) restoreMediaAddRecords(state);
  restoreMediaFieldRecords(state);
  // Snapshots from builds that predate `NoteTagsAdded` carry those events as unknown.
  state.unknownEvents = foldMediaRemovedFromUnknown(
    state,
    foldSourceUnlinkedFromUnknown(state, foldTagAddEventsFromUnknown(state, unknownEvents)),
  );
  // ...and those that hydrated a newer snapshot keep the add registers but may have rewritten
  // `note.tags` without the adds: re-derive every such note so hydration equals a full replay.
  canonicalizeAllTagAddNotes(state);
  // Snapshots from builds that predate optional cards derived every card of a rule layout.
  canonicalizeOptionalCards(state);
  return state;
}
