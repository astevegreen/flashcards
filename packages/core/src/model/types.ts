import type { AnswerMode, FieldKind, ProvenanceDef } from '@flash/content-schema';

export type { AnswerMode, FieldKind };
export type Provenance = ProvenanceDef;

export interface NoteTypeField {
  key: string;
  label: string;
  kind: FieldKind;
  lang: string;
  tts?: boolean;
  sortKey?: boolean;
}

export interface NoteType {
  id: string;
  name: string;
  fields: NoteTypeField[];
}

export interface Layout {
  id: string;
  note_type_id: string;
  name: string;
  front_fields: string[];
  reveal_steps: string[][];
  answer_mode: AnswerMode;
  speak_field?: string;
  hide_furigana_on_front: boolean;
  enabled: boolean;
}

export type NewCardOrder = 'source' | 'random';

export interface DeckSettings {
  new_cards_per_day: number;
  max_reviews_per_day: number;
  target_retention: number;
  new_card_order: NewCardOrder;
  /** Layout IDs enabled for this deck (overrides Layout.enabled when present). */
  enabled_layout_ids?: string[];
  /** Optional override for study-day start hour (0-23); falls back to collection default (4). */
  day_start_hour?: number;
}

export interface FSRSParamsConfig {
  request_retention: number;
  maximum_interval?: number;
  w?: readonly number[];
  enable_fuzz?: boolean;
  enable_short_term?: boolean;
}

export interface DeckFSRSParamsVersion {
  params_version: number;
  effective_from: number; // Unix ms
  params: FSRSParamsConfig;
  reschedule_existing?: boolean;
}

export type SourceKind =
  'google_sheets' | 'google_docs' | 'local_file' | 'package' | 'package_url' | 'native';

export interface SourceRef {
  kind: SourceKind;
  uri?: string;
  package_id?: string;
  package_version?: string;
  last_synced_at?: number;
}

export interface Deck {
  id: string;
  name: string;
  note_type_id: string;
  language: string;
  settings: DeckSettings;
  /** Baseline retention captured at deck creation so later settings changes don't drift version-0 historical reviews. */
  initial_retention: number;
  source?: SourceRef;
  archived: boolean;
  created_at: number;
}

export interface Note {
  id: string;
  deck_id: string;
  fields: Record<string, string>;
  tags: string[];
  source_key: string;
  provenance: Provenance;
  archived: boolean;
  created_order: number;
}

/** Rating values matching ts-fsrs Rating enum (1=Again, 2=Hard, 3=Good, 4=Easy). */
export type ReviewRating = 1 | 2 | 3 | 4;

/** FSRS card state codes matching ts-fsrs State enum (0=New, 1=Learning, 2=Review, 3=Relearning). */
export type CardLearningState = 0 | 1 | 2 | 3;

export interface CardScheduleState {
  due: number; // Unix ms
  stability: number;
  difficulty: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: CardLearningState;
  last_review?: number; // Unix ms
}

export interface Card {
  id: string; // deterministic uuidv5(note_id, layout_id + ':' + variant)
  note_id: string;
  deck_id: string;
  layout_id: string;
  variant: number;
  schedule: CardScheduleState;
  last_reviewed_at?: number;
  last_reviewed_tz_offset?: number;
}

export interface ReviewRecord {
  review_id: string;
  card_id: string;
  rating: ReviewRating;
  reviewed_at: number; // Unix ms
  tz_offset: number; // minutes offset from UTC (like Date.getTimezoneOffset(), or signed UTC offset; we standardize on minutes east of UTC: e.g. KST = +540, EST = -300)
  duration_ms: number;
  answer_mode: AnswerMode;
  typed_answer?: string;
  fsrs_params_version: number;
  resulting_due_at: number;
  hlc: string;
}

/** Schema-ready Page entity for Phase 4. */
export interface Page {
  id: string;
  slug: string;
  title: string;
  markdown: string;
  lang?: string;
  tags: string[];
  read_at?: number;
  source?: SourceRef;
}

/** Schema-ready Course entity for Phase 4. */
export interface Course {
  id: string;
  name: string;
  description?: string;
  items: Array<{
    kind: 'page' | 'deck';
    ref_id: string;
    unlocks_after_page_id?: string;
  }>;
}

export interface MediaEntry {
  hash: string; // sha256
  ext: string;
  mime: string;
  size: number;
}

export type RatingButtonMode = '2' | '3' | '4';

export interface CollectionPreferences {
  rating_button_mode: RatingButtonMode;
  day_start_hour: number; // default 4 (04:00 local)
  pinyin_tone_colors: boolean;
}

export const DEFAULT_DECK_SETTINGS: DeckSettings = {
  new_cards_per_day: 20,
  max_reviews_per_day: 200,
  target_retention: 0.9,
  new_card_order: 'source',
};

export const DEFAULT_COLLECTION_PREFERENCES: CollectionPreferences = {
  rating_button_mode: '3',
  day_start_hour: 4,
  pinyin_tone_colors: true,
};
