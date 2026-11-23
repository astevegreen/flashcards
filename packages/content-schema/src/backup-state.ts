import { z } from 'zod';
import {
  AnswerModeSchema,
  FieldKindSchema,
  RubyDisplaySchema,
  SpeakTimingSchema,
} from './index.ts';

/**
 * Shape of `backup/state.json` in a rolling backup (a serialized collection state). A backup the
 * user picks is untrusted and its contents become events on a restore, so every value a restore
 * turns into an event payload is checked here (§13). Objects are loose: a backup from a newer
 * build may carry fields this build does not know, which restore never reads.
 */

const id = z.string().min(1);
const time = z.number().finite();
const count = z.number().int().nonnegative();
const optionalTime = time.optional();

const SourceRefSchema = z.looseObject({
  kind: z.enum([
    'google_sheets',
    'google_docs',
    'onedrive_file',
    'local_file',
    'package',
    'package_url',
    'native',
  ]),
  uri: z.string().optional(),
  external_id: z.string().optional(),
  sheet_tab: z.string().optional(),
  read_only: z.boolean().optional(),
  content_hash: z.string().optional(),
  package_id: z.string().optional(),
  package_version: z.string().optional(),
  last_synced_at: optionalTime,
  column_map: z.array(z.looseObject({ header: z.string(), target: z.string() })).optional(),
});

const NoteTypeSchema = z.looseObject({
  id,
  name: z.string(),
  fields: z.array(
    z.looseObject({
      key: id,
      label: z.string(),
      kind: FieldKindSchema,
      lang: z.string(),
      tts: z.boolean().optional(),
      sortKey: z.boolean().optional(),
    }),
  ),
});

const LayoutSchema = z.looseObject({
  id,
  note_type_id: id,
  name: z.string(),
  front_fields: z.array(z.string()),
  reveal_steps: z.array(z.array(z.string())),
  answer_mode: AnswerModeSchema,
  speak_field: z.string().optional(),
  speak_on: SpeakTimingSchema.optional(),
  hide_furigana_on_front: z.boolean(),
  ruby_display: RubyDisplaySchema.optional(),
  enabled: z.boolean(),
  cloze_typed: z.boolean().optional(),
  answer_field: z.string().optional(),
});

const DeckSettingsSchema = z.looseObject({
  new_cards_per_day: count,
  max_reviews_per_day: count,
  target_retention: z.number().gt(0).lt(1),
  new_card_order: z.enum(['source', 'random']),
  enabled_layout_ids: z.array(id).optional(),
  day_start_hour: z.number().int().min(0).max(23).optional(),
});

const DeckSchema = z.looseObject({
  id,
  name: z.string(),
  note_type_id: id,
  language: z.string(),
  settings: DeckSettingsSchema,
  initial_retention: z.number().finite(),
  source: SourceRefSchema.optional(),
  archived: z.boolean(),
  created_at: time,
});

const NoteSchema = z.looseObject({
  id,
  deck_id: id,
  fields: z.record(z.string(), z.string()),
  tags: z.array(z.string()),
  source_key: z.string(),
  provenance: z.looseObject({ source: z.enum(['user', 'import', 'ai']), reviewed: z.boolean() }),
  archived: z.boolean(),
  created_order: z.number().finite(),
});

const CardSchema = z.looseObject({ id, note_id: id, deck_id: id, layout_id: id });

const ReviewSchema = z.looseObject({
  review_id: id,
  card_id: id,
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  reviewed_at: time,
  tz_offset: z
    .number()
    .int()
    .min(-24 * 60)
    .max(24 * 60),
  duration_ms: z.number().finite().nonnegative(),
  answer_mode: AnswerModeSchema,
  typed_answer: z.string().optional(),
  fsrs_params_version: count,
  resulting_due_at: time,
  hlc: z.string(),
});

const FsrsVersionSchema = z.looseObject({
  params_version: count,
  effective_from: time,
  params: z.looseObject({
    request_retention: z.number().gt(0).lt(1),
    maximum_interval: z.number().finite().positive().optional(),
    w: z.array(z.number().finite()).optional(),
    enable_fuzz: z.boolean().optional(),
    enable_short_term: z.boolean().optional(),
  }),
  reschedule_existing: z.boolean().optional(),
});

const PageSchema = z.looseObject({
  id,
  slug: z.string(),
  title: z.string(),
  markdown: z.string(),
  lang: z.string().optional(),
  tags: z.array(z.string()),
  read_at: optionalTime,
  source: SourceRefSchema.optional(),
});

const CourseSchema = z.looseObject({
  id,
  name: z.string(),
  description: z.string().optional(),
  items: z.array(
    z.looseObject({
      kind: z.enum(['page', 'deck']),
      ref_id: id,
      unlocks_after_page_id: z.string().optional(),
    }),
  ),
  archived: z.boolean().optional(),
});

const MediaSchema = z.looseObject({
  hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  ext: z.string().regex(/^\.?[a-zA-Z0-9]{1,8}$/),
  mime: z.string().min(1),
  size: count,
  tts_key: z.string().optional(),
  tts_lang_key: z.string().optional(),
});

const PreferencesSchema = z.looseObject({
  rating_button_mode: z.enum(['2', '3', '4']),
  day_start_hour: z.number().int().min(0).max(23),
  pinyin_tone_colors: z.boolean(),
  ja_kana_equivalent: z.boolean().optional(),
  zh_ignore_tones: z.boolean().optional(),
  auto_play_audio: z.boolean().optional(),
  tts_voices: z.record(z.string(), z.string()).optional(),
  drawing_modes: z.record(z.string(), z.enum(['graded', 'lookup', 'off'])).optional(),
  languages: z.record(z.string(), z.boolean()).optional(),
  leech_auto_suspend: z.boolean().optional(),
});

const EventSchema = z.looseObject({ id, device: z.string(), seq: z.number(), hlc: z.string() });

export const BackupStateSchema = z.looseObject({
  formatVersion: z.number().int().positive(),
  totalEvents: count,
  watermarks: z.record(z.string(), count),
  noteTypes: z.array(NoteTypeSchema),
  layouts: z.array(LayoutSchema),
  decks: z.array(DeckSchema),
  notes: z.array(NoteSchema),
  cards: z.array(CardSchema),
  reviewsByCard: z.record(z.string(), z.array(ReviewSchema)),
  undoneReviewIds: z.array(id),
  deckFsrsParams: z.record(z.string(), z.array(FsrsVersionSchema)),
  pages: z.array(PageSchema),
  courses: z.array(CourseSchema),
  media: z.array(MediaSchema),
  ttsMediaByKey: z.record(z.string(), z.string()).optional(),
  ttsMediaByLangKey: z.record(z.string(), z.string()).optional(),
  preferences: PreferencesSchema,
  unknownEvents: z.array(EventSchema),
  fieldHlcs: z.record(z.string(), z.string()),
  noteArchivedState: z.record(z.string(), z.boolean()),
  pendingDeckPatches: z.record(z.string(), z.looseObject({})),
  pendingPagePatches: z.record(z.string(), z.looseObject({})),
});

/** The first problem found, as `path: message`, or `null` when `input` is a valid backup state. */
export function findBackupStateProblem(input: unknown): string | null {
  const result = BackupStateSchema.safeParse(input);
  if (result.success) return null;
  const issue = result.error.issues[0];
  if (!issue) return 'invalid';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
