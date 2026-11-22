import type { CollectionState, EventFactory } from '../../events/replay.ts';
import { suspendRegisterKey, unsuspendRegisterKey } from '../../events/suspension.ts';
import type { EventPayloadMap, KnownEvent, KnownEventType } from '../../events/types.ts';
import { deriveCardId, deriveNoteId, FLASH_NAMESPACE_UUID, uuidv5 } from '../../ids.ts';
import type { Layout, NoteType, ReviewRating } from '../../model/types.ts';
import { computeNoteContentHash, sha256Hex } from '../../sources/hash.ts';
import { compareCodeUnits } from '../../study/queue.ts';
import { normalizeTagList } from '../../tags/index.ts';
import { safeMediaMimeForExt } from '../media-types.ts';
import { normalizeAnkiPackage } from './collection.ts';
import {
  collectionUsesKana,
  MAX_MEDIA_PER_FIELD,
  planAnkiModel,
  type ConvertedNote,
  type FieldPlan,
  type ModelPlan,
} from './model-plan.ts';
import {
  ANKI_IMPORT_LIMITS,
  type AnkiCard,
  type AnkiCollection,
  type AnkiImportLimits,
  type AnkiMediaFile,
  type AnkiNote,
  type AnkiRawPackage,
  type AnkiRevlogEntry,
} from './types.ts';

/**
 * Converts a normalized Anki collection into events (§4.1: every mutation is an event).
 * Identity is deterministic, so importing the same package again only emits what changed:
 * - deck: `uuidv5(ns, "anki:deck:<anki deck id>:<model id>")` (one deck per Anki deck and note
 *   type, since a deck here has a single note type);
 * - note: `uuidv5(deck, "anki:<guid>")`; note type `anki:nt:<model id>`; layout
 *   `anki:layout:<model id>:<template ord>`;
 * - review (optional history): `uuidv5(ns, "anki:revlog:<revlog id>:<card id>")`.
 *
 * Cards suspended in Anki (`queue = -1`) get a `CardSuspended` unless this collection already
 * has a suspend or unsuspend for that card, so a re-import never undoes an unsuspend made here.
 * Buried cards import as normal cards.
 */

export interface AnkiImportOptions {
  nowMs?: number;
  /** Convert the Anki review log into `ReviewRecorded` events (default off). */
  includeReviewHistory?: boolean;
  /** Offset (minutes east of UTC) stamped on imported reviews; Anki does not store one. */
  tzOffsetMinutes?: number;
  limits?: Partial<AnkiImportLimits>;
}

export interface ExtractedAnkiMedia {
  hash: string;
  ext: string;
  mime: string;
  bytes: Uint8Array;
}

export interface AnkiSkippedReviews {
  /** Manual reschedules / "set due date" / "forget" entries (revlog type 4 and 5, or ease 0). */
  manual: number;
  /** Reviews done in filtered decks (revlog type 3: cram / preview), never scheduled here. */
  filtered: number;
  /** Entries for cards that are not in the package. */
  unknownCard: number;
  /** Entries with an ease outside 1–4. */
  invalid: number;
  /** Already imported earlier (same review id). */
  duplicate: number;
}

export interface AnkiImportSummary {
  decks: number;
  newDecks: number;
  notes: number;
  changedNotes: number;
  noteTypes: number;
  media: number;
  /** Cards newly suspended because they were suspended in Anki. */
  suspended: number;
  reviews: number;
  skippedReviews: AnkiSkippedReviews;
}

/** One text field of an imported note type, with the language detection picked for it. */
export interface AnkiImportedField {
  key: string;
  /** The Anki field name. */
  name: string;
  /** Detected language (or the one the template's TTS tag names). */
  lang: string;
  /** Companion image / audio fields that share the field's language. */
  mediaKeys: string[];
}

/** An imported note type and its decks, for the import summary's field-language editor. */
export interface AnkiImportedNoteType {
  noteTypeId: string;
  name: string;
  deckIds: string[];
  /** The field a new deck's language came from (the first enabled layout's front). */
  languageFieldKey: string;
  fields: AnkiImportedField[];
}

export interface AnkiImportResult {
  events: KnownEvent[];
  extractedMedia: ExtractedAnkiMedia[];
  deckIds: string[];
  noteTypes: AnkiImportedNoteType[];
  summary: AnkiImportSummary;
  warnings: string[];
}

interface ResolvedMedia {
  hash: string;
  ext: string;
  mime: string;
  bytes: Uint8Array;
}

/** Looks up media by the names notes use; hashes each file once. */
class MediaIndex {
  private readonly files = new Map<string, AnkiMediaFile>();
  private readonly resolved = new Map<string, ResolvedMedia | null>();
  readonly used = new Map<string, ResolvedMedia>();
  missing = 0;
  unsupported = new Set<string>();

  constructor(media: readonly AnkiMediaFile[]) {
    for (const file of media) this.files.set(file.name.normalize('NFC'), file);
  }

  private find(name: string): AnkiMediaFile | undefined {
    const direct = this.files.get(name.normalize('NFC'));
    if (direct) return direct;
    try {
      return this.files.get(decodeURIComponent(name).normalize('NFC'));
    } catch {
      return undefined;
    }
  }

  private lookup(name: string): ResolvedMedia | null {
    let entry = this.resolved.get(name);
    if (entry === undefined) {
      entry = this.resolve(name);
      this.resolved.set(name, entry);
    }
    return entry;
  }

  /** True when `name` is in the package with a supported type (nothing is marked as used). */
  usable(name: string): boolean {
    return this.lookup(name) !== null;
  }

  /** `media:<sha256>` for a referenced file, or `undefined` (missing / unsupported type). */
  ref(name: string): string | undefined {
    const entry = this.lookup(name);
    if (!entry) return undefined;
    this.used.set(entry.hash, entry);
    return `media:${entry.hash}`;
  }

  private resolve(name: string): ResolvedMedia | null {
    const file = this.find(name);
    if (!file) {
      this.missing += 1;
      return null;
    }
    const dot = name.lastIndexOf('.');
    const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
    const mime = safeMediaMimeForExt(ext);
    if (!mime) {
      this.unsupported.add(ext || '(none)');
      return null;
    }
    return {
      hash: sha256Hex(file.bytes),
      ext: ext === 'jpeg' ? 'jpg' : ext,
      mime,
      bytes: file.bytes,
    };
  }
}

function numericId(id: string): number {
  const n = Number(id);
  return Number.isFinite(n) ? n : 0;
}

function byNumericId<T extends { id: string }>(a: T, b: T): number {
  return numericId(a.id) - numericId(b.id);
}

interface DeckGroup {
  key: string;
  deckId: string;
  ankiDeckId: string;
  plan: ModelPlan;
  notes: ConvertedNote[];
}

/** Home deck of a note: the deck of its first card (filtered decks resolve to the original). */
function homeDeckOf(cards: readonly AnkiCard[] | undefined): string {
  const first = [...(cards ?? [])].sort((a, b) => a.ord - b.ord)[0];
  if (!first) return '1';
  return first.originalDeckId !== '0' && first.originalDeckId !== ''
    ? first.originalDeckId
    : first.deckId;
}

export function ankiDeckId(ankiDeck: string, modelId: string): string {
  return uuidv5(FLASH_NAMESPACE_UUID, `anki:deck:${ankiDeck}:${modelId}`);
}

export function ankiReviewId(revlogId: number, cardId: string): string {
  return uuidv5(FLASH_NAMESPACE_UUID, `anki:revlog:${revlogId}:${cardId}`);
}

function groupDecks(
  plans: readonly ModelPlan[],
  cardsByNote: ReadonlyMap<string, AnkiCard[]>,
): DeckGroup[] {
  const groups = new Map<string, DeckGroup>();
  for (const plan of plans) {
    for (const converted of plan.notes) {
      const ankiDeck = homeDeckOf(cardsByNote.get(converted.note.id));
      const key = `${ankiDeck}:${plan.model.id}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          deckId: ankiDeckId(ankiDeck, plan.model.id),
          ankiDeckId: ankiDeck,
          plan,
          notes: [],
        };
        groups.set(key, group);
      }
      group.notes.push(converted);
    }
  }
  return [...groups.values()];
}

function deckName(
  group: DeckGroup,
  collection: AnkiCollection,
  groups: readonly DeckGroup[],
): string {
  const base = collection.decks.get(group.ankiDeckId)?.name ?? 'Default';
  const shared = groups.filter((g) => g.ankiDeckId === group.ankiDeckId).length > 1;
  return shared ? `${base} (${group.plan.model.name})` : base;
}

/**
 * Puts every usable reference of `names` into `keys`, in order (missing or unsupported files are
 * skipped, and the same file twice fills one field).
 */
function assignMedia(
  fields: Record<string, string>,
  keys: readonly string[],
  names: readonly string[],
  media: MediaIndex,
): void {
  const refs = new Set<string>();
  for (const name of names) {
    const ref = media.ref(name);
    if (ref) refs.add(ref);
  }
  [...refs].forEach((ref, i) => {
    const key = keys[i];
    if (key) fields[key] = ref;
  });
}

function noteFields(
  plan: ModelPlan,
  converted: ConvertedNote,
  media: MediaIndex,
): Record<string, string> {
  const fields: Record<string, string> = {};
  plan.fields.forEach((field, i) => {
    const text = converted.texts[i];
    if (!text) return;
    if (text.text) fields[field.key] = text.text;
    assignMedia(fields, field.imageKeys, text.images, media);
    assignMedia(fields, field.audioKeys, text.sounds, media);
  });
  return fields;
}

/** Merges new fields into an existing note type (keeps the user's own edits and order). */
function mergedNoteType(existing: NoteType | undefined, next: NoteType): NoteType | undefined {
  if (!existing) return next;
  const known = new Set(existing.fields.map((f) => f.key));
  const added = next.fields.filter((f) => !known.has(f.key));
  if (added.length === 0) return undefined;
  return { ...existing, fields: [...existing.fields, ...added] };
}

interface Emitter {
  readonly factory: EventFactory;
  readonly nowMs: number;
  readonly events: KnownEvent[];
}

function emit<K extends KnownEventType>(e: Emitter, type: K, payload: EventPayloadMap[K]): void {
  e.events.push(e.factory.create(type, payload, e.nowMs));
}

function emitModel(e: Emitter, state: CollectionState, plan: ModelPlan): boolean {
  const noteType = mergedNoteType(state.noteTypes.get(plan.noteTypeId), plan.noteType);
  if (noteType) emit(e, 'NoteTypeChanged', { note_type: noteType });
  for (const { layout } of plan.layouts) {
    // Existing layouts keep the user's own changes (enabled, answer mode, …).
    if (!state.layouts.has(layout.id)) emit(e, 'LayoutChanged', { layout });
  }
  return noteType !== undefined;
}

/** The field a deck's language follows: the first enabled layout's first front field. */
function languageField(plan: ModelPlan): FieldPlan | undefined {
  const firstLayout: Layout | undefined = plan.layouts.find((l) => l.layout.enabled)?.layout;
  const frontKey = firstLayout?.front_fields[0];
  return plan.fields.find((f) => f.key === frontKey) ?? plan.fields[0];
}

function deckLanguage(plan: ModelPlan): string {
  return languageField(plan)?.lang ?? 'en';
}

function emitDeck(e: Emitter, state: CollectionState, group: DeckGroup, name: string): boolean {
  const existing = state.decks.get(group.deckId);
  if (existing) {
    if (existing.archived)
      emit(e, 'DeckSettingsChanged', { deck_id: group.deckId, archived: false });
    return false;
  }
  emit(e, 'DeckCreated', {
    deck_id: group.deckId,
    name,
    note_type_id: group.plan.noteTypeId,
    language: deckLanguage(group.plan),
    created_at: e.nowMs,
  });
  return true;
}

/** Emits the deck's notes; returns how many were new or changed. */
function emitNotes(
  e: Emitter,
  state: CollectionState,
  group: DeckGroup,
  media: MediaIndex,
): number {
  let changed = 0;
  const notes = [...group.notes].sort((a, b) => byNumericId(a.note, b.note));
  notes.forEach((converted, order) => {
    const sourceKey = `anki:${converted.note.guid || converted.note.id}`;
    const noteId = deriveNoteId(group.deckId, sourceKey);
    const fields = noteFields(group.plan, converted, media);
    const tags = normalizeTagList(converted.note.tags);
    const existing = state.notes.get(noteId);
    if (existing?.archived) emit(e, 'NoteRestored', { note_id: noteId });
    const unchanged =
      existing !== undefined &&
      computeNoteContentHash(existing.fields, existing.tags) ===
        computeNoteContentHash(fields, tags);
    if (unchanged) return;
    changed += 1;
    emit(e, 'NoteUpserted', {
      note_id: noteId,
      deck_id: group.deckId,
      source_key: sourceKey,
      fields,
      tags,
      provenance: { source: 'import', reviewed: true },
      created_order: order,
    });
  });
  return changed;
}

/** Anki ease -> rating. The v1 scheduler showed three buttons while learning (Again/Good/Easy). */
export function ankiEaseToRating(
  ease: number,
  type: number,
  schedVer: number,
): ReviewRating | undefined {
  if (!Number.isInteger(ease) || ease < 1 || ease > 4) return undefined;
  const learning = type === 0 || type === 2;
  if (schedVer === 1 && learning) {
    if (ease === 4) return undefined;
    return ease === 1 ? 1 : ((ease + 1) as ReviewRating);
  }
  return ease as ReviewRating;
}

/** Anki revlog `ivl`: days when positive, seconds when negative. */
function resultingDueAt(entry: AnkiRevlogEntry): number {
  if (entry.ivl > 0) return entry.id + entry.ivl * 86_400_000;
  if (entry.ivl < 0) return entry.id - entry.ivl * 1000;
  return entry.id;
}

interface CardTarget {
  cardId: string;
  answerMode: Layout['answer_mode'];
}

function cardTargets(
  groups: readonly DeckGroup[],
  cards: readonly AnkiCard[],
): Map<string, CardTarget> {
  const noteIndex = new Map<string, { group: DeckGroup; noteId: string }>();
  for (const group of groups) {
    for (const { note } of group.notes) {
      noteIndex.set(note.id, {
        group,
        noteId: deriveNoteId(group.deckId, `anki:${note.guid || note.id}`),
      });
    }
  }
  const out = new Map<string, CardTarget>();
  for (const card of cards) {
    const owner = noteIndex.get(card.noteId);
    const layoutId = owner?.group.plan.layoutIdForOrd(card.ord);
    if (!owner || !layoutId) continue;
    const layout = owner.group.plan.layouts.find((l) => l.layout.id === layoutId)?.layout;
    const variant = owner.group.plan.model.kind === 'cloze' ? card.ord + 1 : 0;
    out.set(card.id, {
      cardId: deriveCardId(owner.noteId, layoutId, variant),
      answerMode: layout?.answer_mode ?? 'flip',
    });
  }
  return out;
}

function hasSuspensionHistory(state: CollectionState, cardId: string): boolean {
  return (
    state.fieldHlcs.has(suspendRegisterKey(cardId)) ||
    state.fieldHlcs.has(unsuspendRegisterKey(cardId))
  );
}

/** `CardSuspended` for cards suspended in Anki; returns how many were emitted. */
function emitSuspensions(
  e: Emitter,
  state: CollectionState,
  cards: readonly AnkiCard[],
  targets: ReadonlyMap<string, CardTarget>,
): number {
  const done = new Set<string>();
  let count = 0;
  for (const card of [...cards].sort(byNumericId)) {
    const target = card.suspended ? targets.get(card.id) : undefined;
    if (!target || done.has(target.cardId)) continue;
    done.add(target.cardId);
    if (hasSuspensionHistory(state, target.cardId)) continue;
    emit(e, 'CardSuspended', { card_id: target.cardId, reason: 'manual' });
    count += 1;
  }
  return count;
}

type ReviewVerdict = keyof AnkiSkippedReviews | 'import';

function classifyReview(
  entry: AnkiRevlogEntry,
  target: CardTarget | undefined,
  rating: ReviewRating | undefined,
): ReviewVerdict {
  if (entry.type === 4 || entry.type === 5 || entry.ease === 0) return 'manual';
  if (entry.type === 3) return 'filtered';
  if (!target) return 'unknownCard';
  if (rating === undefined) return 'invalid';
  return 'import';
}

function emitReviews(
  e: Emitter,
  state: CollectionState,
  collection: AnkiCollection,
  targets: ReadonlyMap<string, CardTarget>,
  tzOffset: number,
): { imported: number; skipped: AnkiSkippedReviews } {
  const skipped: AnkiSkippedReviews = {
    manual: 0,
    filtered: 0,
    unknownCard: 0,
    invalid: 0,
    duplicate: 0,
  };
  let imported = 0;
  const entries = [...collection.revlog].sort(
    (a, b) => a.id - b.id || numericId(a.cardId) - numericId(b.cardId),
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    const target = targets.get(entry.cardId);
    const rating = ankiEaseToRating(entry.ease, entry.type, collection.schedVer);
    const verdict = classifyReview(entry, target, rating);
    if (verdict !== 'import' || !target || rating === undefined) {
      if (verdict !== 'import') skipped[verdict] += 1;
      continue;
    }
    const reviewId = ankiReviewId(entry.id, entry.cardId);
    if (seen.has(reviewId) || state.reviewIdToCardId.has(reviewId)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(reviewId);
    imported += 1;
    emit(e, 'ReviewRecorded', {
      review_id: reviewId,
      card_id: target.cardId,
      rating,
      reviewed_at: entry.id,
      tz_offset: tzOffset,
      duration_ms: Math.max(0, Math.round(entry.time)),
      answer_mode: target.answerMode,
      fsrs_params_version: 0,
      resulting_due_at: resultingDueAt(entry),
    });
  }
  return { imported, skipped };
}

/** Notes of `plan` with no Anki card for template `ord`. */
function notesMissingOrd(
  plan: ModelPlan,
  ord: number,
  cardsByNote: ReadonlyMap<string, AnkiCard[]>,
): number {
  let missing = 0;
  for (const { note } of plan.notes) {
    const cards = cardsByNote.get(note.id) ?? [];
    if (!cards.some((c) => c.ord === ord)) missing += 1;
  }
  return missing;
}

/**
 * Anki only makes a card when its template renders something (e.g. "Basic (optional reversed
 * card)"); here a layout is on for every note of the type, so say when that adds cards.
 */
function conditionalTemplateWarnings(
  plans: readonly ModelPlan[],
  cardsByNote: ReadonlyMap<string, AnkiCard[]>,
): string[] {
  const warnings: string[] = [];
  for (const plan of plans) {
    if (plan.model.kind === 'cloze') continue;
    for (const { layout, templateOrd } of plan.layouts) {
      if (!layout.enabled) continue;
      const missing = notesMissingOrd(plan, templateOrd, cardsByNote);
      if (missing === 0) continue;
      warnings.push(
        `${missing} note(s) of "${plan.model.name}" had no "${layout.name}" card in Anki; every imported note gets one here.`,
      );
    }
  }
  return warnings;
}

function collectWarnings(
  plans: readonly ModelPlan[],
  media: MediaIndex,
  skippedNotes: number,
): string[] {
  const warnings: string[] = [];
  if (skippedNotes > 0)
    warnings.push(
      `${skippedNotes} note(s) use a note type missing from the package and were skipped.`,
    );
  const extra = plans.reduce((n, p) => n + p.extraMediaRefs, 0);
  if (extra > 0)
    warnings.push(
      `${extra} image or sound reference(s) were dropped: a field keeps at most ${MAX_MEDIA_PER_FIELD} of each.`,
    );
  const dropped = plans.reduce((n, p) => n + p.droppedActiveContent, 0);
  if (dropped > 0)
    warnings.push(`Removed scripts, styles or embedded frames from ${dropped} field(s).`);
  if (media.missing > 0)
    warnings.push(`${media.missing} media file(s) referenced by notes are not in the package.`);
  if (media.unsupported.size > 0) {
    const types = [...media.unsupported].sort(compareCodeUnits).join(', ');
    warnings.push(`Skipped media of unsupported types: ${types}.`);
  }
  return warnings;
}

function templateOrdsWithCards(collection: AnkiCollection): Map<string, Set<number>> {
  const modelOfNote = new Map(collection.notes.map((n) => [n.id, n.modelId]));
  const out = new Map<string, Set<number>>();
  for (const card of collection.cards) {
    const mid = modelOfNote.get(card.noteId);
    if (mid === undefined) continue;
    const set = out.get(mid) ?? new Set<number>();
    set.add(card.ord);
    out.set(mid, set);
  }
  return out;
}

function groupNotesByModel(notes: readonly AnkiNote[]): Map<string, AnkiNote[]> {
  const out = new Map<string, AnkiNote[]>();
  for (const note of [...notes].sort(byNumericId)) {
    const list = out.get(note.modelId) ?? [];
    list.push(note);
    out.set(note.modelId, list);
  }
  return out;
}

/** One import plan per note type that has fields and at least one note. */
function buildModelPlans(collection: AnkiCollection, media: MediaIndex): ModelPlan[] {
  const notesByModel = groupNotesByModel(collection.notes);
  const ordsByModel = templateOrdsWithCards(collection);
  const usesKana = collectionUsesKana(collection.notes);
  const plans: ModelPlan[] = [];
  for (const model of [...collection.models].sort(byNumericId)) {
    const notes = notesByModel.get(model.id);
    if (model.fields.length === 0 || !notes || notes.length === 0) continue;
    plans.push(
      planAnkiModel(model, notes, {
        templateOrdsWithCards: ordsByModel.get(model.id) ?? new Set(),
        collectionUsesKana: usesKana,
        isUsableMedia: (name) => media.usable(name),
      }),
    );
  }
  return plans;
}

function groupCardsByNote(cards: readonly AnkiCard[]): Map<string, AnkiCard[]> {
  const out = new Map<string, AnkiCard[]>();
  for (const card of cards) {
    const list = out.get(card.noteId) ?? [];
    list.push(card);
    out.set(card.noteId, list);
  }
  return out;
}

/** Emits note types, decks and notes; returns how many of each were new or changed. */
function emitContent(
  e: Emitter,
  state: CollectionState,
  collection: AnkiCollection,
  plans: readonly ModelPlan[],
  groups: readonly DeckGroup[],
  media: MediaIndex,
): { noteTypes: number; newDecks: number; changedNotes: number } {
  let noteTypes = 0;
  for (const plan of plans) if (emitModel(e, state, plan)) noteTypes += 1;
  let newDecks = 0;
  let changedNotes = 0;
  for (const group of groups) {
    if (emitDeck(e, state, group, deckName(group, collection, groups))) newDecks += 1;
    changedNotes += emitNotes(e, state, group, media);
  }
  return { noteTypes, newDecks, changedNotes };
}

/** Emits `MediaAdded` for every referenced file not already stored; returns them sorted. */
function emitMedia(e: Emitter, state: CollectionState, media: MediaIndex): ResolvedMedia[] {
  const used = [...media.used.values()].sort((a, b) => compareCodeUnits(a.hash, b.hash));
  for (const m of used) {
    if (state.media.has(m.hash)) continue;
    emit(e, 'MediaAdded', {
      media: { hash: m.hash, ext: m.ext, mime: m.mime, size: m.bytes.byteLength },
    });
  }
  return used;
}

function importedNoteTypes(groups: readonly DeckGroup[]): AnkiImportedNoteType[] {
  const byType = new Map<string, AnkiImportedNoteType>();
  for (const group of groups) {
    const existing = byType.get(group.plan.noteTypeId);
    if (existing) {
      existing.deckIds.push(group.deckId);
      continue;
    }
    const plan = group.plan;
    byType.set(plan.noteTypeId, {
      noteTypeId: plan.noteTypeId,
      name: plan.model.name,
      deckIds: [group.deckId],
      languageFieldKey: languageField(plan)?.key ?? '',
      fields: plan.fields.map((f) => ({
        key: f.key,
        name: f.name,
        lang: f.lang,
        mediaKeys: [...f.imageKeys, ...f.audioKeys],
      })),
    });
  }
  return [...byType.values()];
}

function noReviewHistory(): { imported: number; skipped: AnkiSkippedReviews } {
  return {
    imported: 0,
    skipped: { manual: 0, filtered: 0, unknownCard: 0, invalid: 0, duplicate: 0 },
  };
}

/** Converts a normalized collection plus its media into import events. */
export function convertAnkiCollection(
  collection: AnkiCollection,
  mediaFiles: readonly AnkiMediaFile[],
  state: CollectionState,
  factory: EventFactory,
  options: AnkiImportOptions = {},
): AnkiImportResult {
  const e: Emitter = { factory, nowMs: options.nowMs ?? Date.now(), events: [] };
  const media = new MediaIndex(mediaFiles);
  const plans = buildModelPlans(collection, media);
  const knownModels = new Set(plans.map((p) => p.model.id));
  const skippedNotes = collection.notes.filter((n) => !knownModels.has(n.modelId)).length;
  const cardsByNote = groupCardsByNote(collection.cards);
  const groups = groupDecks(plans, cardsByNote);

  const counts = emitContent(e, state, collection, plans, groups, media);
  const mediaEvents = emitMedia(e, state, media);
  const targets = cardTargets(groups, collection.cards);
  const suspended = emitSuspensions(e, state, collection.cards, targets);
  const history = options.includeReviewHistory
    ? emitReviews(e, state, collection, targets, options.tzOffsetMinutes ?? 0)
    : noReviewHistory();

  return {
    events: e.events,
    extractedMedia: mediaEvents,
    deckIds: groups.map((g) => g.deckId),
    noteTypes: importedNoteTypes(groups),
    summary: {
      decks: groups.length,
      ...counts,
      notes: groups.reduce((n, g) => n + g.notes.length, 0),
      media: mediaEvents.length,
      suspended,
      reviews: history.imported,
      skippedReviews: history.skipped,
    },
    warnings: [
      ...conditionalTemplateWarnings(plans, cardsByNote),
      ...collectWarnings(plans, media, skippedNotes),
    ],
  };
}

/** Normalizes raw reader output and converts it (the one call the UI makes). */
export function importAnkiPackage(
  raw: AnkiRawPackage,
  state: CollectionState,
  factory: EventFactory,
  options: AnkiImportOptions = {},
): AnkiImportResult {
  const collection = normalizeAnkiPackage(raw, { ...ANKI_IMPORT_LIMITS, ...options.limits });
  const result = convertAnkiCollection(collection, raw.media, state, factory, options);
  return { ...result, warnings: [...raw.warnings, ...result.warnings] };
}
