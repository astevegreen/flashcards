import { z } from 'zod';

export const FieldKindSchema = z.enum(['text', 'reading', 'rich', 'image', 'audio']);
export type FieldKind = z.infer<typeof FieldKindSchema>;

export const NoteTypeFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1).optional(),
  kind: FieldKindSchema,
  lang: z.string().min(1),
  tts: z.boolean().optional(),
  sortKey: z.boolean().optional(),
});
export type NoteTypeFieldDef = z.infer<typeof NoteTypeFieldSchema>;

export const NoteTypeDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  fields: z.array(NoteTypeFieldSchema).min(1),
});
export type NoteTypeDef = z.infer<typeof NoteTypeDefSchema>;

export const AnswerModeSchema = z.enum(['flip', 'typed', 'choice', 'cloze', 'listen', 'draw']);
export type AnswerMode = z.infer<typeof AnswerModeSchema>;

export const SpeakTimingSchema = z.enum(['front', 'reveal', 'manual']);
export type SpeakTiming = z.infer<typeof SpeakTimingSchema>;

export const RubyDisplaySchema = z.enum(['both', 'readings', 'bases']);
export type RubyDisplay = z.infer<typeof RubyDisplaySchema>;

export const LayoutDefSchema = z.object({
  id: z.string().min(1),
  note_type_id: z.string().min(1),
  name: z.string().min(1),
  front_fields: z.array(z.string().min(1)).min(1),
  reveal_steps: z.array(z.array(z.string().min(1)).min(1)).min(1),
  answer_mode: AnswerModeSchema.default('flip'),
  speak_field: z.string().min(1).optional(),
  speak_on: SpeakTimingSchema.optional(),
  hide_furigana_on_front: z.boolean().default(false),
  ruby_display: RubyDisplaySchema.optional(),
  enabled: z.boolean().default(true),
  cloze_typed: z.boolean().optional(),
  answer_field: z.string().min(1).optional(),
  required_field: z.string().min(1).optional(),
});
export type LayoutDef = z.infer<typeof LayoutDefSchema>;

export const ProvenanceSchema = z.object({
  source: z.enum(['user', 'import', 'ai']),
  reviewed: z.boolean(),
});
export type ProvenanceDef = z.infer<typeof ProvenanceSchema>;

export const PackageNoteRecordSchema = z.object({
  id: z.string().min(1),
  fields: z.record(z.string(), z.string()),
  tags: z.array(z.string()).default([]),
  provenance: ProvenanceSchema.optional(),
});
export type PackageNoteRecord = z.infer<typeof PackageNoteRecordSchema>;

export const PackageDeckEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  file: z.string().min(1),
  note_type_id: z.string().min(1),
  language: z.string().min(1).optional(),
  /** Plain-text deck description for the overview before study (never HTML). */
  description: z.string().max(10000).optional(),
  /** Id of the shared option preset (in `manifest.presets`) the deck uses. */
  preset_id: z.string().min(1).max(200).optional(),
  /** Id of the deck folder (in `manifest.folders`) the deck sits in. */
  folder_id: z.string().min(1).max(200).optional(),
});
export type PackageDeckEntry = z.infer<typeof PackageDeckEntrySchema>;

/**
 * A shared deck option preset. Values outside what deck options accept are dropped on import
 * (a missing setting falls back to the app default), so the bounds here only cap the size.
 */
export const PackagePresetSchema = z.object({
  id: z.string().min(1).max(200),
  /** Up to 80 characters, like preset and folder names in the app. */
  name: z.string().min(1).max(80),
  settings: z
    .object({
      new_cards_per_day: z.number().finite().optional(),
      max_reviews_per_day: z.number().finite().optional(),
      target_retention: z.number().finite().optional(),
    })
    .default({}),
  /** Shared FSRS weights, when the preset was optimized. */
  w: z.array(z.number().finite()).max(21).optional(),
});
export type PackagePreset = z.infer<typeof PackagePresetSchema>;

/** A deck folder (one level). */
export const PackageFolderSchema = z.object({
  id: z.string().min(1).max(200),
  /** Up to 80 characters, like preset and folder names in the app. */
  name: z.string().min(1).max(80),
});
export type PackageFolder = z.infer<typeof PackageFolderSchema>;

export const PackageManifestSchema = z.object({
  package_id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  format_version: z.literal(1),
  author: z.string().optional(),
  license: z.string().optional(),
  languages: z.array(z.string().min(1)).default([]),
  decks: z.array(PackageDeckEntrySchema).default([]),
  /**
   * True when the decks hold only part of their notes (e.g. one category). Importers then never
   * archive the deck's other notes or relink the existing deck to this package.
   */
  subset: z.boolean().optional(),
  /** Presets the exported decks use (optional; older packages have none). */
  presets: z.array(PackagePresetSchema).max(1000).optional(),
  /** Folders the exported decks sit in (optional; older packages have none). */
  folders: z.array(PackageFolderSchema).max(1000).optional(),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export const PageFrontmatterSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  lang: z.string().min(1).optional(),
  tags: z.array(z.string()).default([]),
});
export type PageFrontmatter = z.infer<typeof PageFrontmatterSchema>;

export const CourseItemSchema = z.object({
  kind: z.enum(['page', 'deck']),
  ref_id: z.string().min(1),
  unlocks_after_page_id: z.string().min(1).optional(),
});
export type CourseItemDef = z.infer<typeof CourseItemSchema>;

export const CourseDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  items: z.array(CourseItemSchema).default([]),
});
export type CourseDef = z.infer<typeof CourseDefSchema>;

function hasWhitespaceOrControlChar(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Pure ES2023 strict HTTPS URL validator (§13 — rejects http:, javascript:, data:, credentials, backslashes). */
export function isStrictHttpsUrl(raw: string): boolean {
  if (!raw || hasWhitespaceOrControlChar(raw)) return false;
  if (!/^https:\/\//i.test(raw)) return false;
  const rest = raw.slice(8);
  const endAuthority = rest.search(/[/?#]/);
  const authority = endAuthority === -1 ? rest : rest.slice(0, endAuthority);
  if (!authority || authority.includes('@') || authority.includes('\\')) return false;

  let host = authority;
  let portStr = '';
  if (authority.startsWith('[')) {
    const closeIdx = authority.indexOf(']');
    if (closeIdx <= 1) return false;
    host = authority.slice(1, closeIdx);
    const after = authority.slice(closeIdx + 1);
    if (after.length > 0) {
      if (!after.startsWith(':')) return false;
      portStr = after.slice(1);
    }
    if (!/^[0-9a-fA-F:]+$/.test(host)) return false;
  } else {
    const colonIdx = authority.lastIndexOf(':');
    if (colonIdx !== -1) {
      host = authority.slice(0, colonIdx);
      portStr = authority.slice(colonIdx + 1);
    }
    if (!host || host.length > 253 || host.startsWith('.') || host.endsWith('.')) return false;
    const labels = host.split('.');
    if (labels.length < 2) return false;
    for (const label of labels) {
      if (
        !label ||
        label.length > 63 ||
        !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
      ) {
        return false;
      }
    }
  }

  if (portStr !== '') {
    if (!/^\d{1,5}$/.test(portStr)) return false;
    const port = Number(portStr);
    if (port < 1 || port > 65535) return false;
  }

  return true;
}

/** Strict HTTPS URL schema (§13 — rejects http:, javascript:, data:, credentials). */
export const HttpsUrlSchema = z.string().min(1).refine(isStrictHttpsUrl, {
  message: 'URL must use https: scheme with a valid host and no embedded credentials.',
});

export const FamilyCatalogEntrySchema = z.object({
  package_id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  url: HttpsUrlSchema,
  version: z.string().min(1),
  languages: z.array(z.string().min(1)).default([]),
  updated_at: z.string().optional(),
  author: z.string().optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'sha256 must be a 64-character hex string')
    .optional(),
});
export type FamilyCatalogEntry = z.infer<typeof FamilyCatalogEntrySchema>;

export const FamilyCatalogSchema = z.object({
  format_version: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  updated_at: z.string().optional(),
  packages: z.array(FamilyCatalogEntrySchema),
});
export type FamilyCatalog = z.infer<typeof FamilyCatalogSchema>;

/** Safe same-origin relative path for static dev/test fixtures (`/packs/...`, zero `..`, zero protocol-relative `//`). */
export function isSafeRelativePackPath(raw: string): boolean {
  if (!raw || hasWhitespaceOrControlChar(raw)) return false;
  if (!raw.startsWith('/') || raw.startsWith('//')) return false;
  if (raw.includes('\\') || raw.includes('..') || raw.includes(':')) return false;
  return true;
}

export function isSafePackUrl(raw: string, allowRelative = false): boolean {
  if (isStrictHttpsUrl(raw)) return true;
  if (allowRelative && isSafeRelativePackPath(raw)) return true;
  return false;
}

export const PackKindSchema = z.enum(['dictionary', 'strokes']);
export type PackKindDef = z.infer<typeof PackKindSchema>;

export const PackIdSchema = z.enum([
  'dict-hanja-unihan',
  'dict-kanjidic2',
  'dict-cc-cedict',
  'dict-jmdict',
  'dict-krdict',
  'dict-urimalsam',
  'dict-kaikki-ko',
  'strokes-ja-kanjivg',
  'strokes-zh-mmah',
]);
export type PackIdDef = z.infer<typeof PackIdSchema>;

export const PackUrlSchema = z
  .string()
  .min(1)
  .refine((v) => isSafePackUrl(v, true), {
    message: 'Pack URL must be a valid https:// URL or safe relative /packs/... path.',
  });

/** Sharding scheme of a dictionary pack split by the first Hangul syllable of each headword. */
export const DictionaryShardSchemeSchema = z.literal('first-syllable-v1');

const HANGUL_SYLLABLE_RE = /^[가-힣]$/;

/**
 * One shard of a sharded dictionary pack. `from` / `to` (inclusive) bound the first syllable of
 * the shard's headwords. A shard without them holds the headwords that don't start with a Hangul
 * syllable. `file` is a bare file name, fetched from the directory of the pack's index URL.
 */
export const DictionaryShardDescriptorSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]{1,32}$/),
    file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json(\.gz)?$/),
    from: z.string().regex(HANGUL_SYLLABLE_RE).optional(),
    to: z.string().regex(HANGUL_SYLLABLE_RE).optional(),
    entry_count: z.number().int().nonnegative(),
    compressed_bytes: z.number().int().nonnegative(),
    uncompressed_bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'sha256 must be a 64-character hex string'),
  })
  .refine((s) => (s.from === undefined) === (s.to === undefined), {
    message: 'A shard sets both "from" and "to", or neither.',
  })
  .refine((s) => s.from === undefined || s.to === undefined || s.from <= s.to, {
    message: 'A shard\'s "from" syllable must not come after its "to" syllable.',
  });
export type DictionaryShardDescriptorDef = z.infer<typeof DictionaryShardDescriptorSchema>;

/** `manifest.sharding` of a sharded dictionary pack's index file (pack `format_version: 2`). */
export const DictionaryShardingSchema = z.object({
  scheme: DictionaryShardSchemeSchema,
  total_entries: z.number().int().nonnegative(),
  shards: z.array(DictionaryShardDescriptorSchema).min(1).max(256),
});
export type DictionaryShardingDef = z.infer<typeof DictionaryShardingSchema>;

/** Catalog summary of a sharded pack: `url` is its index, and the shards download on demand. */
export const PackCatalogShardsSchema = z.object({
  scheme: DictionaryShardSchemeSchema,
  count: z.number().int().positive(),
  /** Sum over every shard file (the index itself is the entry's `compressed_bytes`). */
  compressed_bytes: z.number().int().nonnegative(),
  uncompressed_bytes: z.number().int().nonnegative().optional(),
});
export type PackCatalogShardsDef = z.infer<typeof PackCatalogShardsSchema>;

export const PackCatalogEntrySchema = z.object({
  id: PackIdSchema,
  kind: PackKindSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  language: z.string().min(1),
  script: z.enum(['ja', 'zh-Hans']).optional(),
  url: PackUrlSchema,
  compressed_bytes: z.number().int().nonnegative(),
  uncompressed_bytes: z.number().int().nonnegative().optional(),
  entry_count: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'sha256 must be a 64-character hex string')
    .optional(),
  license_name: z.string().min(1),
  license_url: HttpsUrlSchema,
  attribution: z.string().min(1),
  source_url: HttpsUrlSchema,
  optional: z.boolean().optional(),
  /** Optional per-character static URL template on the same host (e.g. `https://.../strokes/ja/{hex5}.json` or `{char}.json`). */
  char_url_template: PackUrlSchema.optional(),
  /** Set when the pack is sharded. Older apps ignore it and refuse the `format_version: 2` index. */
  shards: PackCatalogShardsSchema.optional(),
});
export type PackCatalogEntryDef = z.infer<typeof PackCatalogEntrySchema>;

export const PackCatalogSchema = z.object({
  format_version: z.literal(1),
  name: z.string().min(1),
  updated_at: z.string().optional(),
  packs: z.array(PackCatalogEntrySchema),
});
export type PackCatalogDef = z.infer<typeof PackCatalogSchema>;

export interface SchemaValidationError {
  path: string;
  code: string;
  message: string;
}

export type ValidationResult<T> =
  { ok: true; data: T } | { ok: false; errors: SchemaValidationError[] };

function formatZodIssues(issues: readonly z.core.$ZodIssue[]): SchemaValidationError[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

export function validatePackageManifest(input: unknown): ValidationResult<PackageManifest> {
  const result = PackageManifestSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodIssues(result.error.issues) };
}

export function validatePackageNote(input: unknown): ValidationResult<PackageNoteRecord> {
  const result = PackageNoteRecordSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodIssues(result.error.issues) };
}

export function validateNoteTypes(input: unknown): ValidationResult<NoteTypeDef[]> {
  const result = z.array(NoteTypeDefSchema).safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodIssues(result.error.issues) };
}

export function validateLayouts(input: unknown): ValidationResult<LayoutDef[]> {
  const result = z.array(LayoutDefSchema).safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodIssues(result.error.issues) };
}

export function validateCourses(input: unknown): ValidationResult<CourseDef[]> {
  const result = z.array(CourseDefSchema).safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodIssues(result.error.issues) };
}

export function validateFamilyCatalog(input: unknown): ValidationResult<FamilyCatalog> {
  const result = FamilyCatalogSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodIssues(result.error.issues) };
}

export function validatePackCatalog(input: unknown): ValidationResult<PackCatalogDef> {
  const result = PackCatalogSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodIssues(result.error.issues) };
}

export function validateDictionarySharding(
  input: unknown,
): ValidationResult<DictionaryShardingDef> {
  const result = DictionaryShardingSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatZodIssues(result.error.issues) };
}

export function getPackageJsonSchemas(): Record<string, unknown> {
  return {
    manifest: z.toJSONSchema(PackageManifestSchema),
    note_type: z.toJSONSchema(NoteTypeDefSchema),
    layout: z.toJSONSchema(LayoutDefSchema),
    note_record: z.toJSONSchema(PackageNoteRecordSchema),
    page_frontmatter: z.toJSONSchema(PageFrontmatterSchema),
    course: z.toJSONSchema(CourseDefSchema),
    family_catalog: z.toJSONSchema(FamilyCatalogSchema),
    pack_catalog: z.toJSONSchema(PackCatalogSchema),
    dictionary_pack_sharding: z.toJSONSchema(DictionaryShardingSchema),
  };
}
