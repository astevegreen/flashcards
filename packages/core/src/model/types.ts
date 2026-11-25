import type {
  AnswerMode,
  FieldKind,
  ProvenanceDef,
  RubyDisplay,
  SpeakTiming,
} from '@flash/content-schema';

export type { AnswerMode, FieldKind, RubyDisplay, SpeakTiming };
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
  speak_on?: SpeakTiming;
  hide_furigana_on_front: boolean;
  /**
   * Which part of ruby the layout shows: `both` (default when absent), the `readings` alone, or
   * the `bases` alone. Imports keep the full ruby; this decides what is displayed.
   */
  ruby_display?: RubyDisplay;
  enabled: boolean;
  /** For `cloze` layouts: enable composable typed-blank input by default (§5.2). */
  cloze_typed?: boolean;
  /** Explicit field key evaluated in `typed` / `choice` modes (defaults to `reveal_steps[0][0]`). */
  answer_field?: string;
  /**
   * Optional card rule: make this layout's card for a note only when this field is filled
   * (`model/optional-cards.ts`). A card that already has review history is kept, flagged
   * {@link Card.empty}, when the field is emptied later.
   */
  required_field?: string;
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
  | 'google_sheets'
  | 'google_docs'
  | 'onedrive_file'
  | 'google_drive_file'
  | 'local_file'
  | 'package'
  | 'package_url'
  | 'native';

export interface SourceRef {
  kind: SourceKind;
  uri?: string;
  external_id?: string;
  sheet_tab?: string;
  read_only?: boolean;
  content_hash?: string;
  package_id?: string;
  package_version?: string;
  last_synced_at?: number;
  /**
   * Where each column of a linked Sheet goes, chosen in the import mapping step. Matched by header
   * name on every refresh; a column it doesn't list falls back to matching by name.
   */
  column_map?: SourceColumnMapping[];
}

/**
 * One column of a saved import mapping. `target` is `field:<field key>`, `tags`, `card_id`,
 * `notes` (appended to the Notes field as `Header: value`) or `ignore`.
 */
export interface SourceColumnMapping {
  header: string;
  target: string;
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
  /**
   * Set when the layout's `required_field` is empty but the card has active review history: the
   * card is kept with its schedule, left out of Study, and shown as "empty" in Browse. Filling
   * the field again clears it. Never set on cards without history (those are not made at all).
   */
  empty?: true;
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
  /** Soft-deleted from the course list; kept so a later sync or undo can restore it. */
  archived?: boolean;
}

export interface MediaEntry {
  hash: string; // sha256(bytes)
  ext: string;
  mime: string;
  size: number;
  /** Optional deterministic TTS cache key: sha256(normalized_text + '\0' + canonical_voice_id) (§7.1). */
  tts_key?: string;
  /** Optional language-level TTS fallback key: sha256(normalized_text + '\0' + normalized_lang) for key-less secondary devices. */
  tts_lang_key?: string;
}

export type RatingButtonMode = '2' | '3' | '4';

export type DrawingMode = 'graded' | 'lookup' | 'off';

export interface CollectionPreferences {
  rating_button_mode: RatingButtonMode;
  day_start_hour: number; // default 4 (04:00 local)
  pinyin_tone_colors: boolean;
  /** Treat Japanese hiragana and katakana as equivalent in typed-answer mode (default true). */
  ja_kana_equivalent?: boolean;
  /** Ignore Mandarin tone marks/numbers in typed-answer mode (default false). */
  zh_ignore_tones?: boolean;
  /** Automatically play card audio on front/reveal during study (default false; Listen mode always auto-plays). */
  auto_play_audio?: boolean;
  /** Optional synced per-language cloud TTS voice overrides (e.g. { ja: 'ja-JP-Neural2-C' }). */
  tts_voices?: Record<string, string>;
  /** Optional synced per-language drawing mode overrides (§6.4: graded | lookup | off). */
  drawing_modes?: Record<string, DrawingMode>;
  /**
   * Optional synced Settings > Languages tick boxes (UX #2), per normalized language code: `true`
   * keeps a language's options shown with no deck in it, `false` drops the onboarding choice.
   * Decks always count; see `deriveActiveLanguages`.
   */
  languages?: Record<string, boolean>;
  /** Phase 9: suspend a card when a review makes it a leech (8 lapses; default false). */
  leech_auto_suspend?: boolean;
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
  ja_kana_equivalent: true,
  zh_ignore_tones: false,
  auto_play_audio: false,
};
