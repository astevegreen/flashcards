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
  applyEventsWithCollector,
  createMutationCollector,
  type CollectionState,
  type PendingDeckPatch,
  type PendingPagePatch,
} from './replay.ts';
import { recordTagAddKeys } from './tag-adds.ts';
import type { FlashEvent, UnknownEvent } from './types.ts';

/**
 * Compact, structured-cloneable incremental state patch produced by a Web Worker
 * after running FSRS replay off the main thread.
 */
export interface CollectionStatePatch {
  appliedCount: number;
  appliedEventIds: string[];
  maxHlc?: string;
  noteTypes: NoteType[];
  layouts: Layout[];
  decks: Deck[];
  notes: Note[];
  changedCards: Card[];
  removedCardIds: string[];
  reviewsByCard: Record<string, ReviewRecord[]>;
  addedUndoneReviewIds: string[];
  deckFsrsParams: Record<string, DeckFSRSParamsVersion[]>;
  pages: Page[];
  courses: Course[];
  media: MediaEntry[];
  /** Hashes a `MediaRemoved` took out of `media`. */
  removedMedia?: string[];
  ttsMediaByKey?: Record<string, string>;
  ttsMediaByLangKey?: Record<string, string>;
  preferences?: CollectionPreferences;
  addedUnknownEvents: UnknownEvent[];
  fieldHlcs: Record<string, string>;
  noteArchivedState: Record<string, boolean>;
  pendingDeckPatches: Record<string, PendingDeckPatch | null>;
  pendingPagePatches: Record<string, PendingPagePatch | null>;
}

export interface MergePatchResult {
  changedCardIds: string[];
  removedCardIds: string[];
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

/**
 * Applies `events` to `state` (typically on a Web Worker thread where all `ts-fsrs`
 * scheduling runs) and returns a compact patch containing only touched entities and
 * recomputed cards so the main thread merges in O(changed) with zero FSRS math.
 */
export function computeStatePatch(
  state: CollectionState,
  events: readonly FlashEvent[],
): CollectionStatePatch {
  const collector = createMutationCollector();
  const res = applyEventsWithCollector(state, events, collector);

  const noteTypes: NoteType[] = [];
  for (const id of collector.noteTypeIds) {
    const nt = state.noteTypes.get(id);
    if (nt) noteTypes.push({ ...nt, fields: nt.fields.map((f) => ({ ...f })) });
  }

  const layouts: Layout[] = [];
  for (const id of collector.layoutIds) {
    const l = state.layouts.get(id);
    if (l) {
      layouts.push({
        ...l,
        front_fields: [...l.front_fields],
        reveal_steps: l.reveal_steps.map((s) => [...s]),
      });
    }
  }

  const decks: Deck[] = [];
  for (const id of collector.deckIds) {
    const d = state.decks.get(id);
    if (d) {
      decks.push({
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
  }

  const notes: Note[] = [];
  for (const id of collector.noteIds) {
    const n = state.notes.get(id);
    if (n) {
      notes.push({
        ...n,
        fields: { ...n.fields },
        tags: [...n.tags],
        provenance: { ...n.provenance },
      });
    }
  }

  const changedCards: Card[] = [];
  for (const cardId of res.changedCardIds) {
    const card = state.cards.get(cardId);
    if (card) changedCards.push({ ...card, schedule: { ...card.schedule } });
  }

  const reviewsByCard: Record<string, ReviewRecord[]> = {};
  for (const cardId of collector.reviewCardIds) {
    const list = state.reviewsByCard.get(cardId);
    if (list) reviewsByCard[cardId] = list.map((r) => ({ ...r }));
  }

  const deckFsrsParams: Record<string, DeckFSRSParamsVersion[]> = {};
  for (const deckId of collector.fsrsDeckIds) {
    const list = state.deckFsrsParams.get(deckId);
    if (list) {
      deckFsrsParams[deckId] = list.map((v) => ({
        ...v,
        params: {
          ...v.params,
          ...(v.params.w !== undefined ? { w: [...v.params.w] } : {}),
        },
      }));
    }
  }

  const pages: Page[] = [];
  for (const id of collector.pageIds) {
    const p = state.pages.get(id);
    if (p) {
      pages.push({
        ...p,
        tags: [...p.tags],
        ...(p.source !== undefined ? { source: { ...p.source } } : {}),
      });
    }
  }

  const courses: Course[] = [];
  for (const id of collector.courseIds) {
    const c = state.courses.get(id);
    if (c) courses.push({ ...c, items: c.items.map((item) => ({ ...item })) });
  }

  const media: MediaEntry[] = [];
  const removedMedia: string[] = [];
  for (const hash of collector.mediaHashes) {
    const m = state.media.get(hash);
    if (m) media.push({ ...m });
    else removedMedia.push(hash);
  }

  const ttsMediaByKey: Record<string, string> = {};
  for (const key of collector.ttsKeys) {
    const val = state.ttsMediaByKey.get(key);
    if (val !== undefined) ttsMediaByKey[key] = val;
  }

  const ttsMediaByLangKey: Record<string, string> = {};
  for (const key of collector.ttsLangKeys) {
    const val = state.ttsMediaByLangKey.get(key);
    if (val !== undefined) ttsMediaByLangKey[key] = val;
  }

  const fieldHlcs: Record<string, string> = {};
  for (const key of collector.fieldHlcKeys) {
    const val = state.fieldHlcs.get(key);
    if (val !== undefined) fieldHlcs[key] = val;
  }

  const noteArchivedState: Record<string, boolean> = {};
  for (const key of collector.noteArchivedKeys) {
    const val = state.noteArchivedState.get(key);
    if (val !== undefined) noteArchivedState[key] = val;
  }

  const pendingDeckPatches: Record<string, PendingDeckPatch | null> = {};
  for (const key of collector.pendingDeckPatchKeys) {
    const val = state.pendingDeckPatches.get(key);
    pendingDeckPatches[key] = val
      ? {
          ...val,
          settings: {
            ...val.settings,
            ...(val.settings.enabled_layout_ids !== undefined
              ? { enabled_layout_ids: [...val.settings.enabled_layout_ids] }
              : {}),
          },
          ...(val.source !== undefined ? { source: { ...val.source } } : {}),
        }
      : null;
  }

  const pendingPagePatches: Record<string, PendingPagePatch | null> = {};
  for (const key of collector.pendingPagePatchKeys) {
    const val = state.pendingPagePatches.get(key);
    pendingPagePatches[key] = val
      ? {
          ...val,
          ...(val.source !== undefined ? { source: { ...val.source } } : {}),
        }
      : null;
  }

  return {
    appliedCount: res.appliedCount,
    appliedEventIds: collector.appliedEventIds,
    ...(res.maxHlc !== undefined ? { maxHlc: res.maxHlc } : {}),
    noteTypes,
    layouts,
    decks,
    notes,
    changedCards,
    removedCardIds: res.removedCardIds,
    reviewsByCard,
    addedUndoneReviewIds: [...collector.addedUndoneReviewIds],
    deckFsrsParams,
    pages,
    courses,
    media,
    ...(removedMedia.length > 0 ? { removedMedia } : {}),
    ...(Object.keys(ttsMediaByKey).length > 0 ? { ttsMediaByKey } : {}),
    ...(Object.keys(ttsMediaByLangKey).length > 0 ? { ttsMediaByLangKey } : {}),
    ...(collector.preferencesChanged
      ? {
          preferences: {
            ...state.preferences,
            ...(state.preferences.tts_voices !== undefined
              ? { tts_voices: { ...state.preferences.tts_voices } }
              : {}),
            ...(state.preferences.drawing_modes !== undefined
              ? { drawing_modes: { ...state.preferences.drawing_modes } }
              : {}),
            ...(state.preferences.languages !== undefined
              ? { languages: { ...state.preferences.languages } }
              : {}),
          },
        }
      : {}),
    addedUnknownEvents: collector.addedUnknownEvents,
    fieldHlcs,
    noteArchivedState,
    pendingDeckPatches,
    pendingPagePatches,
  };
}

/**
 * Merges a Worker-computed `CollectionStatePatch` into `target` on the main thread
 * in O(changed) time with zero FSRS recalculation.
 */
export function mergeStatePatch(
  target: CollectionState,
  patch: CollectionStatePatch,
): MergePatchResult {
  for (const id of patch.appliedEventIds) {
    target.appliedEventIds.add(id);
  }

  for (const nt of patch.noteTypes) {
    target.noteTypes.set(nt.id, { ...nt, fields: nt.fields.map((f) => ({ ...f })) });
  }

  for (const l of patch.layouts) {
    target.layouts.set(l.id, {
      ...l,
      front_fields: [...l.front_fields],
      reveal_steps: l.reveal_steps.map((s) => [...s]),
    });
  }

  for (const d of patch.decks) {
    target.decks.set(d.id, {
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

  for (const n of patch.notes) {
    const prev = target.notes.get(n.id);
    if (prev && prev.deck_id !== n.deck_id) {
      removeFromMapSet(target.noteIdsByDeck, prev.deck_id, n.id);
    }
    target.notes.set(n.id, {
      ...n,
      fields: { ...n.fields },
      tags: [...n.tags],
      provenance: { ...n.provenance },
    });
    addToMapSet(target.noteIdsByDeck, n.deck_id, n.id);
  }

  for (const cardId of patch.removedCardIds) {
    const existing = target.cards.get(cardId);
    if (existing) {
      target.cards.delete(cardId);
      removeFromMapSet(target.cardIdsByDeck, existing.deck_id, cardId);
      removeFromMapSet(target.cardIdsByNote, existing.note_id, cardId);
    }
  }

  const changedCardIds: string[] = [];
  for (const c of patch.changedCards) {
    const prev = target.cards.get(c.id);
    if (prev && (prev.deck_id !== c.deck_id || prev.note_id !== c.note_id)) {
      removeFromMapSet(target.cardIdsByDeck, prev.deck_id, c.id);
      removeFromMapSet(target.cardIdsByNote, prev.note_id, c.id);
    }
    target.cards.set(c.id, { ...c, schedule: { ...c.schedule } });
    addToMapSet(target.cardIdsByDeck, c.deck_id, c.id);
    addToMapSet(target.cardIdsByNote, c.note_id, c.id);
    changedCardIds.push(c.id);
  }

  for (const [cardId, list] of Object.entries(patch.reviewsByCard)) {
    const cloned = list.map((r) => ({ ...r }));
    target.reviewsByCard.set(cardId, cloned);
    for (const r of cloned) {
      target.reviewIdToCardId.set(r.review_id, cardId);
    }
  }

  for (const revId of patch.addedUndoneReviewIds) {
    target.undoneReviewIds.add(revId);
  }

  for (const [deckId, list] of Object.entries(patch.deckFsrsParams)) {
    target.deckFsrsParams.set(
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

  for (const p of patch.pages) {
    target.pages.set(p.id, {
      ...p,
      tags: [...p.tags],
      ...(p.source !== undefined ? { source: { ...p.source } } : {}),
    });
  }

  for (const c of patch.courses) {
    target.courses.set(c.id, { ...c, items: c.items.map((item) => ({ ...item })) });
  }

  for (const hash of patch.removedMedia ?? []) {
    target.media.delete(hash.toLowerCase());
  }
  for (const m of patch.media) {
    const normHash = m.hash.toLowerCase();
    const entry: MediaEntry = { ...m, hash: normHash };
    target.media.set(normHash, entry);
  }

  if (patch.ttsMediaByKey) {
    for (const [k, v] of Object.entries(patch.ttsMediaByKey)) {
      target.ttsMediaByKey.set(k, v.toLowerCase());
    }
  }
  if (patch.ttsMediaByLangKey) {
    for (const [k, v] of Object.entries(patch.ttsMediaByLangKey)) {
      target.ttsMediaByLangKey.set(k, v.toLowerCase());
    }
  }

  if (patch.preferences) {
    target.preferences = {
      ...patch.preferences,
      ...(patch.preferences.tts_voices !== undefined
        ? { tts_voices: { ...patch.preferences.tts_voices } }
        : {}),
      ...(patch.preferences.drawing_modes !== undefined
        ? { drawing_modes: { ...patch.preferences.drawing_modes } }
        : {}),
      ...(patch.preferences.languages !== undefined
        ? { languages: { ...patch.preferences.languages } }
        : {}),
    };
  }

  for (const ev of patch.addedUnknownEvents) {
    target.unknownEvents.push(ev);
  }

  for (const [k, v] of Object.entries(patch.fieldHlcs)) {
    target.fieldHlcs.set(k, v);
  }
  recordTagAddKeys(target, Object.keys(patch.fieldHlcs));

  for (const [k, v] of Object.entries(patch.noteArchivedState)) {
    target.noteArchivedState.set(k, v);
  }

  for (const [k, v] of Object.entries(patch.pendingDeckPatches)) {
    if (v === null) {
      target.pendingDeckPatches.delete(k);
    } else {
      target.pendingDeckPatches.set(k, {
        ...v,
        settings: {
          ...v.settings,
          ...(v.settings.enabled_layout_ids !== undefined
            ? { enabled_layout_ids: [...v.settings.enabled_layout_ids] }
            : {}),
        },
        ...(v.source !== undefined ? { source: { ...v.source } } : {}),
      });
    }
  }

  for (const [k, v] of Object.entries(patch.pendingPagePatches)) {
    if (v === null) {
      target.pendingPagePatches.delete(k);
    } else {
      target.pendingPagePatches.set(k, {
        ...v,
        ...(v.source !== undefined ? { source: { ...v.source } } : {}),
      });
    }
  }

  return {
    changedCardIds,
    removedCardIds: patch.removedCardIds,
  };
}
