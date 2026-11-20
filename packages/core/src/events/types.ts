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

export interface PreferencesChangedPayload {
  preferences: Partial<CollectionPreferences>;
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
  PreferencesChanged: PreferencesChangedPayload;
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
    type === 'PreferencesChanged'
  );
}
