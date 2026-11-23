import type {
  AnswerMode,
  CollectionPreferences,
  Course,
  DeckSettings,
  FSRSParamsConfig,
  Layout,
  MediaEntry,
  NoteType,
  Provenance,
  ReviewRating,
  SourceRef,
} from '../model/types.ts';

export interface ReviewRecordedPayload {
  review_id: string;
  card_id: string;
  rating: ReviewRating;
  reviewed_at: number; // Unix ms
  tz_offset: number; // minutes offset from UTC (e.g. +540 for KST, -300 for EST)
  duration_ms: number;
  answer_mode: AnswerMode;
  typed_answer?: string;
  fsrs_params_version: number;
  resulting_due_at: number; // Unix ms
}

export interface ReviewUndonePayload {
  review_id: string;
}

export interface DeckCreatedPayload {
  deck_id: string;
  name: string;
  note_type_id: string;
  language: string;
  settings?: Partial<DeckSettings>;
  source?: SourceRef;
  created_at?: number;
}

export interface DeckSettingsChangedPayload {
  deck_id: string;
  name?: string;
  language?: string;
  archived?: boolean;
  settings?: Partial<DeckSettings>;
}

export interface DeckFSRSParamsChangedPayload {
  deck_id: string;
  params_version: number;
  effective_from: number; // Unix ms
  params: FSRSParamsConfig;
  reschedule_existing?: boolean;
}

export interface NoteUpsertedPayload {
  note_id: string;
  deck_id: string;
  source_key: string;
  fields: Record<string, string>;
  tags?: string[];
  provenance?: Provenance;
  created_order?: number;
}

export interface NoteArchivedPayload {
  note_id: string;
}

export interface NoteRestoredPayload {
  note_id: string;
}

export interface NoteTypeChangedPayload {
  note_type: NoteType;
}

export interface LayoutChangedPayload {
  layout: Layout;
}

export interface PageUpsertedPayload {
  page_id: string;
  slug: string;
  title: string;
  markdown: string;
  lang?: string;
  tags?: string[];
  source?: SourceRef;
}

export interface PageReadPayload {
  page_id: string;
  read_at: number;
}

export interface CourseChangedPayload {
  course: Course;
}

export interface MediaAddedPayload {
  media: MediaEntry;
}

export interface SourceLinkedPayload {
  target_kind: 'deck' | 'page';
  target_id: string;
  source: SourceRef;
}

/**
 * Unlinks a deck's or page's source on every device: the target keeps its notes, cards and review
 * history but loses `source`, so no device lists or refreshes it as a linked source any more. It
 * shares the `deck:<id>:source` / `page:<id>:source` LWW register with `SourceLinked`, so the
 * newer of an unlink and a (re)link wins under any delivery order. Older builds that do not know
 * it keep it untouched in `unknownEvents` (§4.2); hydrating their snapshots folds it back in.
 */
export interface SourceUnlinkedPayload {
  target_kind: 'deck' | 'page';
  target_id: string;
}

export interface PreferencesChangedPayload {
  preferences: Partial<CollectionPreferences>;
}

/**
 * Phase 9 card control. Suspension is tracked as two grow-only HLC registers per card
 * (`card:<id>:suspend` / `card:<id>:unsuspend` in `fieldHlcs`): the card is suspended when its
 * newest `CardSuspended` HLC is greater than its newest `CardUnsuspended` HLC. Max-merge is
 * commutative and idempotent, so replay converges under any delivery order, and older builds
 * that do not know these types keep them untouched in `unknownEvents` (§4.2).
 */
export interface CardSuspendedPayload {
  card_id: string;
  /** Why the card was suspended. `leech` = optional leech auto-suspend at review time. */
  reason?: 'manual' | 'leech';
  /** The review that made the card a leech (leech auto-suspend only; Undo unsuspends it). */
  review_id?: string;
}

export interface CardUnsuspendedPayload {
  card_id: string;
}

/**
 * Set-union tag add (automatic `leech` tagging and the leech backfill). Unlike `NoteUpserted`,
 * which rewrites the whole tag list, this only adds tags, so concurrent adds on several devices
 * converge without duplicates and never undo a concurrent tag edit. Replay rules:
 * `events/tag-adds.ts`. Older builds keep it untouched in `unknownEvents` (§4.2).
 */
export interface NoteTagsAddedPayload {
  note_id: string;
  /** Tags to add (stored NFC, trimmed, lowercase). */
  tags: string[];
  /** Why: `leech` = a review reached the leech threshold; `leech-backfill` = see `planLeechBackfill`. */
  reason?: 'leech' | 'leech-backfill';
}

/**
 * Phase 9 study-side events (Study Sets, custom study). They are **log-retained**: replay keeps
 * them verbatim in `CollectionState.unknownEvents` (they are deliberately not listed in
 * {@link isKnownEventType}), exactly like an older build that does not know them. The study
 * views in `study/custom-study.ts` and the new-card limit in `study/queue.ts` fold them on
 * demand with order-independent rules, so the snapshot and sync formats stay byte-compatible
 * (no `format_version` bump) and every build preserves them untouched (§4.2).
 */
export type StudySetMode = 'schedule' | 'practice';

/**
 * Creates or edits a named Study Set. Each present field is a per-field LWW register decided by
 * the event HLC (a rename on one device and a filter edit on another both survive).
 */
export interface StudySetSavedPayload {
  set_id: string;
  name?: string;
  /** Normalized `CardFilter` (see `normalizeCardFilter`). */
  filter?: unknown;
  mode?: StudySetMode;
  /**
   * Set on the filter-only saves a category rename / merge / delete writes in the background
   * (`planStudySetTagRewrites`). Such a save updates its field registers but never creates a set
   * or brings back one that another device deleted: only a user's own save does that.
   */
  tag_rewrite?: true;
}

/** Deletes a Study Set: it stays deleted unless a later (higher-HLC) `StudySetSaved` edits it. */
export interface StudySetDeletedPayload {
  set_id: string;
}

/**
 * One answer in a cram / practice session. Never touches FSRS state, due dates, daily limits or
 * the scheduled queue: it only drives the practice session it belongs to (`session_id`).
 */
export interface PracticeRecordedPayload {
  practice_id: string;
  session_id: string;
  card_id: string;
  rating: ReviewRating;
  practiced_at: number; // Unix ms
  tz_offset: number;
  duration_ms: number;
  answer_mode: AnswerMode;
}

export interface PracticeUndonePayload {
  practice_id: string;
}

/**
 * Custom study "extra new cards today": grants `extra` more new cards, shared by the whole scope
 * (`deck_ids`, empty = every deck, and optional `categories`), for the study day that contains
 * `raised_at` (in `tz_offset`, with each deck's rollover hour). It is one pool, not a per-deck
 * bonus: only new cards inside the scope may use it, beyond each deck's normal daily limit.
 * Additive and deduplicated by `raise_id`, so it converges under any order.
 */
export interface NewCardLimitRaisedPayload {
  raise_id: string;
  deck_ids: string[];
  extra: number;
  raised_at: number; // Unix ms
  tz_offset: number;
  /** Optional normalized `CategoryCriterion` (note tags) the extra new cards must match. */
  categories?: unknown;
}

/**
 * Shared deck option presets and one level of deck folders. Log-retained like the Study Set
 * events above: replay keeps them in `unknownEvents` and `decks/organization.ts` folds them on
 * demand (per-field HLC last-writer-wins), so snapshots and sync stay byte-compatible.
 * Scheduling never reads them: a preset's retention and weights reach FSRS only through ordinary
 * per-deck `DeckFSRSParamsChanged` events (see `buildPresetParamsPayloads`).
 */
export interface DeckPresetSettings {
  new_cards_per_day: number;
  max_reviews_per_day: number;
  target_retention: number;
}

/** Creates or edits a preset; each present field is its own LWW register. */
export interface DeckPresetSavedPayload {
  preset_id: string;
  name?: string;
  settings?: Partial<DeckPresetSettings>;
  /** FSRS weights shared by the preset's decks (set by the pooled optimizer). */
  w?: number[];
}

/** Deletes a preset unless a later `DeckPresetSaved` edits it again. */
export interface DeckPresetDeletedPayload {
  preset_id: string;
}

export interface DeckFolderSavedPayload {
  folder_id: string;
  name: string;
}

export interface DeckFolderDeletedPayload {
  folder_id: string;
}

/**
 * Puts a deck in a preset and/or a folder. Each present field is a per-deck LWW register; `null`
 * means own settings / no folder.
 */
export interface DeckGroupingChangedPayload {
  deck_id: string;
  preset_id?: string | null;
  folder_id?: string | null;
}

export interface EventPayloadMap {
  ReviewRecorded: ReviewRecordedPayload;
  ReviewUndone: ReviewUndonePayload;
  DeckCreated: DeckCreatedPayload;
  DeckSettingsChanged: DeckSettingsChangedPayload;
  DeckFSRSParamsChanged: DeckFSRSParamsChangedPayload;
  NoteUpserted: NoteUpsertedPayload;
  NoteArchived: NoteArchivedPayload;
  NoteRestored: NoteRestoredPayload;
  NoteTypeChanged: NoteTypeChangedPayload;
  LayoutChanged: LayoutChangedPayload;
  PageUpserted: PageUpsertedPayload;
  PageRead: PageReadPayload;
  CourseChanged: CourseChangedPayload;
  MediaAdded: MediaAddedPayload;
  SourceLinked: SourceLinkedPayload;
  SourceUnlinked: SourceUnlinkedPayload;
  PreferencesChanged: PreferencesChangedPayload;
  CardSuspended: CardSuspendedPayload;
  CardUnsuspended: CardUnsuspendedPayload;
  NoteTagsAdded: NoteTagsAddedPayload;
  StudySetSaved: StudySetSavedPayload;
  StudySetDeleted: StudySetDeletedPayload;
  PracticeRecorded: PracticeRecordedPayload;
  PracticeUndone: PracticeUndonePayload;
  NewCardLimitRaised: NewCardLimitRaisedPayload;
  DeckPresetSaved: DeckPresetSavedPayload;
  DeckPresetDeleted: DeckPresetDeletedPayload;
  DeckFolderSaved: DeckFolderSavedPayload;
  DeckFolderDeleted: DeckFolderDeletedPayload;
  DeckGroupingChanged: DeckGroupingChangedPayload;
}

export type KnownEventType = keyof EventPayloadMap;

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  id: string; // UUIDv7
  device: string; // device ID
  seq: number; // per-device, gapless, strictly increasing
  hlc: string; // hybrid logical clock
  type: TType;
  v: number; // event schema version
  payload: TPayload;
}

export type KnownEvent = {
  [K in KnownEventType]: EventEnvelope<K, EventPayloadMap[K]>;
}[KnownEventType];

/** Forward-compatible event type: preserves unknown future event types untouched. */
export type UnknownEvent = EventEnvelope<string, unknown>;

export type FlashEvent = KnownEvent | UnknownEvent;

/** Event types replay keeps verbatim in `unknownEvents` (see {@link StudySetSavedPayload}). */
export type LogRetainedEventType =
  | 'StudySetSaved'
  | 'StudySetDeleted'
  | 'PracticeRecorded'
  | 'PracticeUndone'
  | 'NewCardLimitRaised'
  | 'DeckPresetSaved'
  | 'DeckPresetDeleted'
  | 'DeckFolderSaved'
  | 'DeckFolderDeleted'
  | 'DeckGroupingChanged';

/**
 * Event types `applyKnownEvent` handles. Log-retained types are intentionally absent: they fall
 * through to `unknownEvents`, which every build serializes into snapshots untouched.
 */
export function isKnownEventType(type: string): type is KnownEventType {
  return (
    type === 'ReviewRecorded' ||
    type === 'ReviewUndone' ||
    type === 'DeckCreated' ||
    type === 'DeckSettingsChanged' ||
    type === 'DeckFSRSParamsChanged' ||
    type === 'NoteUpserted' ||
    type === 'NoteArchived' ||
    type === 'NoteRestored' ||
    type === 'NoteTypeChanged' ||
    type === 'LayoutChanged' ||
    type === 'PageUpserted' ||
    type === 'PageRead' ||
    type === 'CourseChanged' ||
    type === 'MediaAdded' ||
    type === 'SourceLinked' ||
    type === 'SourceUnlinked' ||
    type === 'PreferencesChanged' ||
    type === 'CardSuspended' ||
    type === 'CardUnsuspended' ||
    type === 'NoteTagsAdded'
  );
}
