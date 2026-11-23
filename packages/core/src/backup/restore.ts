import type { CollectionState, EventFactory } from '../events/replay.ts';
import { isCardSuspended } from '../events/replay.ts';
import type { EventPayloadMap, KnownEvent, KnownEventType } from '../events/types.ts';
import type { DeckFSRSParamsVersion, Note, ReviewRecord } from '../model/types.ts';

/**
 * Restoring a backup appends NEW events (authored by this device, at the current time) that move
 * the collection from what it is now to what the backup holds. Nothing in the log is rewritten,
 * so the restore syncs to every device like any other edit, can itself be undone by restoring
 * the `pre-restore` snapshot taken just before, and converges under the usual LWW rules:
 *
 * - decks, notes, layouts, note types, pages, courses and preferences get the backup's values;
 * - decks and notes the backup does not have are archived (nothing is ever deleted);
 * - reviews the backup has and the collection lost are recorded again with their original
 *   `review_id` (replay dedupes by id, so devices that still have them are unaffected);
 * - reviews made after the backup are kept unless `undoNewerReviews` is set.
 *
 * Not restorable this way: a review that was undone after the backup (an undo is final), pages
 * the backup lacks (pages have no archive), Study Sets and practice sessions (log-retained
 * events), and deck fields added after this module (they are carried by their own events).
 */

export type RestoreStep = {
  [K in KnownEventType]: { type: K; payload: EventPayloadMap[K] };
}[KnownEventType];

export interface RestoreSummary {
  decksAdded: number;
  decksChanged: number;
  decksArchived: number;
  notesAdded: number;
  notesChanged: number;
  notesArchived: number;
  notesRestored: number;
  reviewsAdded: number;
  reviewsUndone: number;
  /** Reviews made after the backup that stay (`undoNewerReviews` off). */
  reviewsKept: number;
  /** Backup reviews that were undone since; an undo cannot be reverted. */
  reviewsNotRestorable: number;
  noteTypesChanged: number;
  layoutsChanged: number;
  fsrsParamsChanged: number;
  suspensionsChanged: number;
  pagesChanged: number;
  coursesChanged: number;
  mediaAdded: number;
  preferencesChanged: boolean;
}

export interface RestorePlan {
  steps: RestoreStep[];
  summary: RestoreSummary;
}

export interface RestorePlanOptions {
  /** Undo the reviews recorded after the backup was taken (default: keep them). */
  undoNewerReviews?: boolean;
  /** Clock for new FSRS parameter versions (default `Date.now()`). */
  nowMs?: number;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function same(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function emptySummary(): RestoreSummary {
  return {
    decksAdded: 0,
    decksChanged: 0,
    decksArchived: 0,
    notesAdded: 0,
    notesChanged: 0,
    notesArchived: 0,
    notesRestored: 0,
    reviewsAdded: 0,
    reviewsUndone: 0,
    reviewsKept: 0,
    reviewsNotRestorable: 0,
    noteTypesChanged: 0,
    layoutsChanged: 0,
    fsrsParamsChanged: 0,
    suspensionsChanged: 0,
    pagesChanged: 0,
    coursesChanged: 0,
    mediaAdded: 0,
    preferencesChanged: false,
  };
}

interface PlanContext {
  current: CollectionState;
  backup: CollectionState;
  steps: RestoreStep[];
  summary: RestoreSummary;
  nowMs: number;
}

function planModel(ctx: PlanContext): void {
  const { current, backup, steps, summary } = ctx;
  for (const nt of backup.noteTypes.values()) {
    if (!same(nt, current.noteTypes.get(nt.id))) {
      steps.push({ type: 'NoteTypeChanged', payload: { note_type: nt } });
      summary.noteTypesChanged += 1;
    }
  }
  for (const layout of backup.layouts.values()) {
    if (!same(layout, current.layouts.get(layout.id))) {
      steps.push({ type: 'LayoutChanged', payload: { layout } });
      summary.layoutsChanged += 1;
    }
  }
}

function planDecks(ctx: PlanContext): void {
  const { current, backup, steps, summary } = ctx;
  for (const deck of backup.decks.values()) {
    const now = current.decks.get(deck.id);
    if (!now) {
      steps.push({
        type: 'DeckCreated',
        payload: {
          deck_id: deck.id,
          name: deck.name,
          note_type_id: deck.note_type_id,
          language: deck.language,
          settings: deck.settings,
          ...(deck.source !== undefined ? { source: deck.source } : {}),
          created_at: deck.created_at,
        },
      });
      if (deck.archived) {
        steps.push({ type: 'DeckSettingsChanged', payload: { deck_id: deck.id, archived: true } });
      }
      summary.decksAdded += 1;
      continue;
    }
    const patch: EventPayloadMap['DeckSettingsChanged'] = { deck_id: deck.id };
    if (now.name !== deck.name) patch.name = deck.name;
    if (now.language !== deck.language) patch.language = deck.language;
    if (now.archived !== deck.archived) patch.archived = deck.archived;
    if (!same(now.settings, deck.settings)) patch.settings = deck.settings;
    if (Object.keys(patch).length > 1) {
      steps.push({ type: 'DeckSettingsChanged', payload: patch });
      summary.decksChanged += 1;
    }
    if (deck.source !== undefined && !same(deck.source, now.source)) {
      steps.push({
        type: 'SourceLinked',
        payload: { target_kind: 'deck', target_id: deck.id, source: deck.source },
      });
    } else if (deck.source === undefined && now.source !== undefined) {
      steps.push({ type: 'SourceUnlinked', payload: { target_kind: 'deck', target_id: deck.id } });
    }
  }
  for (const deck of current.decks.values()) {
    if (!backup.decks.has(deck.id) && !deck.archived) {
      steps.push({ type: 'DeckSettingsChanged', payload: { deck_id: deck.id, archived: true } });
      summary.decksArchived += 1;
    }
  }
}

function versionPayload(
  deckId: string,
  v: DeckFSRSParamsVersion,
): EventPayloadMap['DeckFSRSParamsChanged'] {
  return {
    deck_id: deckId,
    params_version: v.params_version,
    effective_from: v.effective_from,
    params: v.params,
    ...(v.reschedule_existing !== undefined ? { reschedule_existing: v.reschedule_existing } : {}),
  };
}

function planFsrsParams(ctx: PlanContext): void {
  const { current, backup, steps, summary, nowMs } = ctx;
  for (const [deckId, versions] of backup.deckFsrsParams) {
    const now = current.deckFsrsParams.get(deckId) ?? [];
    let changed = false;
    for (const v of versions) {
      if (
        !same(
          v,
          now.find((n) => n.params_version === v.params_version),
        )
      ) {
        steps.push({ type: 'DeckFSRSParamsChanged', payload: versionPayload(deckId, v) });
        changed = true;
      }
    }
    const backupActive = versions[versions.length - 1];
    const currentMax = now.reduce((m, v) => Math.max(m, v.params_version), 0);
    const currentActive = now.find((v) => v.params_version === currentMax);
    if (
      backupActive &&
      currentActive &&
      currentMax > backupActive.params_version &&
      !same(currentActive.params, backupActive.params)
    ) {
      // A newer version on this side would win; a new one brings the backup's parameters back.
      steps.push({
        type: 'DeckFSRSParamsChanged',
        payload: {
          deck_id: deckId,
          params_version: currentMax + 1,
          effective_from: nowMs,
          params: backupActive.params,
          reschedule_existing: false,
        },
      });
      changed = true;
    }
    if (changed) summary.fsrsParamsChanged += 1;
  }
}

/** Field registers can't be removed, only emptied: a missing field and `''` are the same. */
function sameFields(a: Record<string, string>, b: Record<string, string>): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[key] ?? '') !== (b[key] ?? '')) return false;
  }
  return true;
}

function noteContentDiffers(now: Note, note: Note): boolean {
  return (
    now.deck_id !== note.deck_id ||
    now.source_key !== note.source_key ||
    now.created_order !== note.created_order ||
    !sameFields(now.fields, note.fields) ||
    !same(now.tags, note.tags) ||
    !same(now.provenance, note.provenance)
  );
}

function noteUpsertPayload(note: Note, now: Note | undefined): EventPayloadMap['NoteUpserted'] {
  const fields: Record<string, string> = { ...note.fields };
  // Fields are per-field registers: a field the backup lacks is cleared, not left behind.
  for (const key of Object.keys(now?.fields ?? {})) {
    if (!(key in fields)) fields[key] = '';
  }
  return {
    note_id: note.id,
    deck_id: note.deck_id,
    source_key: note.source_key,
    fields,
    tags: [...note.tags],
    provenance: note.provenance,
    created_order: note.created_order,
  };
}

function planNotes(ctx: PlanContext): void {
  const { current, backup, steps, summary } = ctx;
  for (const note of backup.notes.values()) {
    const now = current.notes.get(note.id);
    if (!now || noteContentDiffers(now, note)) {
      steps.push({ type: 'NoteUpserted', payload: noteUpsertPayload(note, now) });
      if (now) summary.notesChanged += 1;
      else summary.notesAdded += 1;
    }
    const archivedNow = now?.archived ?? current.noteArchivedState.get(note.id) ?? false;
    if (note.archived && !archivedNow) {
      steps.push({ type: 'NoteArchived', payload: { note_id: note.id } });
      if (now) summary.notesArchived += 1;
    } else if (!note.archived && archivedNow) {
      steps.push({ type: 'NoteRestored', payload: { note_id: note.id } });
      if (now) summary.notesRestored += 1;
    }
  }
  for (const note of current.notes.values()) {
    if (!backup.notes.has(note.id) && !note.archived) {
      steps.push({ type: 'NoteArchived', payload: { note_id: note.id } });
      summary.notesArchived += 1;
    }
  }
}

function planSuspensions(ctx: PlanContext): void {
  const { current, backup, steps, summary } = ctx;
  for (const cardId of backup.cards.keys()) {
    const wanted = isCardSuspended(backup, cardId);
    if (wanted === isCardSuspended(current, cardId)) continue;
    steps.push(
      wanted
        ? { type: 'CardSuspended', payload: { card_id: cardId, reason: 'manual' } }
        : { type: 'CardUnsuspended', payload: { card_id: cardId } },
    );
    summary.suspensionsChanged += 1;
  }
}

function reviewPayload(r: ReviewRecord): EventPayloadMap['ReviewRecorded'] {
  return {
    review_id: r.review_id,
    card_id: r.card_id,
    rating: r.rating,
    reviewed_at: r.reviewed_at,
    tz_offset: r.tz_offset,
    duration_ms: r.duration_ms,
    answer_mode: r.answer_mode,
    ...(r.typed_answer !== undefined ? { typed_answer: r.typed_answer } : {}),
    fsrs_params_version: r.fsrs_params_version,
    resulting_due_at: r.resulting_due_at,
  };
}

function allReviews(state: CollectionState): ReviewRecord[] {
  const out: ReviewRecord[] = [];
  for (const list of state.reviewsByCard.values()) out.push(...list);
  out.sort(
    (a, b) =>
      a.reviewed_at - b.reviewed_at ||
      (a.review_id < b.review_id ? -1 : a.review_id > b.review_id ? 1 : 0),
  );
  return out;
}

function planReviews(ctx: PlanContext, undoNewer: boolean): void {
  const { current, backup, steps, summary } = ctx;
  const currentIds = new Set(current.reviewIdToCardId.keys());
  for (const list of current.reviewsByCard.values())
    for (const r of list) currentIds.add(r.review_id);
  const backupReviews = allReviews(backup);
  const backupIds = new Set(backupReviews.map((r) => r.review_id));
  for (const r of backupReviews) {
    const undoneInBackup = backup.undoneReviewIds.has(r.review_id);
    const undoneNow = current.undoneReviewIds.has(r.review_id);
    if (undoneInBackup) {
      if (currentIds.has(r.review_id) && !undoneNow) {
        steps.push({ type: 'ReviewUndone', payload: { review_id: r.review_id } });
        summary.reviewsUndone += 1;
      }
    } else if (undoneNow) {
      summary.reviewsNotRestorable += 1;
    } else if (!currentIds.has(r.review_id)) {
      steps.push({ type: 'ReviewRecorded', payload: reviewPayload(r) });
      summary.reviewsAdded += 1;
    }
  }
  for (const r of allReviews(current)) {
    if (backupIds.has(r.review_id) || current.undoneReviewIds.has(r.review_id)) continue;
    if (undoNewer) {
      steps.push({ type: 'ReviewUndone', payload: { review_id: r.review_id } });
      summary.reviewsUndone += 1;
    } else {
      summary.reviewsKept += 1;
    }
  }
}

function planPagesCoursesMedia(ctx: PlanContext): void {
  const { current, backup, steps, summary } = ctx;
  for (const page of backup.pages.values()) {
    const now = current.pages.get(page.id);
    const { read_at: _readAt, ...content } = page;
    const nowContent = now ? (({ read_at: _r, ...rest }) => rest)(now) : undefined;
    if (!same(content, nowContent)) {
      steps.push({
        type: 'PageUpserted',
        payload: {
          page_id: page.id,
          slug: page.slug,
          title: page.title,
          markdown: page.markdown,
          ...(page.lang !== undefined ? { lang: page.lang } : {}),
          tags: [...page.tags],
          ...(page.source !== undefined ? { source: page.source } : {}),
        },
      });
      summary.pagesChanged += 1;
    }
    if (page.read_at !== undefined && now?.read_at === undefined) {
      steps.push({ type: 'PageRead', payload: { page_id: page.id, read_at: page.read_at } });
    }
  }
  for (const course of backup.courses.values()) {
    if (!same(course, current.courses.get(course.id))) {
      steps.push({ type: 'CourseChanged', payload: { course } });
      summary.coursesChanged += 1;
    }
  }
  for (const course of current.courses.values()) {
    if (!backup.courses.has(course.id) && !course.archived) {
      steps.push({ type: 'CourseChanged', payload: { course: { ...course, archived: true } } });
      summary.coursesChanged += 1;
    }
  }
  for (const [hash, entry] of backup.media) {
    if (!current.media.has(hash)) {
      steps.push({ type: 'MediaAdded', payload: { media: entry } });
      summary.mediaAdded += 1;
    }
  }
  if (!same(backup.preferences, current.preferences)) {
    steps.push({ type: 'PreferencesChanged', payload: { preferences: backup.preferences } });
    summary.preferencesChanged = true;
  }
}

/** Plans the events that bring `current` to the content of `backup` (see the module comment). */
export function planBackupRestore(
  current: CollectionState,
  backup: CollectionState,
  options: RestorePlanOptions = {},
): RestorePlan {
  const ctx: PlanContext = {
    current,
    backup,
    steps: [],
    summary: emptySummary(),
    nowMs: options.nowMs ?? Date.now(),
  };
  // Order: model before decks, decks before notes, notes before cards and reviews.
  planModel(ctx);
  planDecks(ctx);
  planFsrsParams(ctx);
  planPagesCoursesMedia(ctx);
  planNotes(ctx);
  planSuspensions(ctx);
  planReviews(ctx, options.undoNewerReviews === true);
  return { steps: ctx.steps, summary: ctx.summary };
}

/** Turns planned steps into events from this device's factory. */
export function restoreStepsToEvents(
  steps: readonly RestoreStep[],
  factory: EventFactory,
  nowMs: number = Date.now(),
): KnownEvent[] {
  return steps.map((step) =>
    factory.create(step.type, step.payload as EventPayloadMap[typeof step.type], nowMs),
  );
}
