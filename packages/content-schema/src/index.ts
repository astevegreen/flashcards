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

export const LayoutDefSchema = z.object({
  id: z.string().min(1),
  note_type_id: z.string().min(1),
  name: z.string().min(1),
  front_fields: z.array(z.string().min(1)).min(1),
  reveal_steps: z.array(z.array(z.string().min(1)).min(1)).min(1),
  answer_mode: AnswerModeSchema.default('flip'),
  speak_field: z.string().min(1).optional(),
  hide_furigana_on_front: z.boolean().default(false),
  enabled: z.boolean().default(true),
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
});
export type PackageDeckEntry = z.infer<typeof PackageDeckEntrySchema>;

export const PackageManifestSchema = z.object({
  package_id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  format_version: z.literal(1),
  author: z.string().optional(),
  license: z.string().optional(),
  languages: z.array(z.string().min(1)).default([]),
  decks: z.array(PackageDeckEntrySchema).default([]),
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

export function getPackageJsonSchemas(): Record<string, unknown> {
  return {
    manifest: z.toJSONSchema(PackageManifestSchema),
    note_type: z.toJSONSchema(NoteTypeDefSchema),
    layout: z.toJSONSchema(LayoutDefSchema),
    note_record: z.toJSONSchema(PackageNoteRecordSchema),
    page_frontmatter: z.toJSONSchema(PageFrontmatterSchema),
    course: z.toJSONSchema(CourseDefSchema),
  };
}
