/**
 * Anki `.apkg` import (Phase 12), exposed as the lazily loaded `@flash/core/anki` entry. Never
 * re-export this from `@flash/core`'s main barrel: it must stay out of the initial bundle (§8).
 */
export {
  ANKI_IMPORT_LIMITS,
  ANKI_REEXPORT_HINT,
  ANKI_TABLES,
  AnkiImportError,
  type AnkiCard,
  type AnkiCollection,
  type AnkiCollectionFormat,
  type AnkiDeckInfo,
  type AnkiImportErrorCode,
  type AnkiImportLimits,
  type AnkiMediaFile,
  type AnkiModel,
  type AnkiNote,
  type AnkiRawPackage,
  type AnkiRevlogEntry,
  type AnkiSqlTable,
  type AnkiSqlValue,
  type AnkiTableName,
} from './types.ts';
export { normalizeAnkiPackage } from './collection.ts';
export {
  ankiDeckId,
  ankiEaseToRating,
  ankiReviewId,
  convertAnkiCollection,
  importAnkiPackage,
  type AnkiImportOptions,
  type AnkiImportResult,
  type AnkiImportSummary,
  type AnkiSkippedReviews,
  type ExtractedAnkiMedia,
} from './convert.ts';
export {
  APKG_ARCHIVE_ERRORS,
  assertZstdWithinLimit,
  parseAnkiMediaMap,
  planApkg,
  unzipApkg,
  type AnkiMediaMapEntry,
  type ApkgPlan,
} from './package.ts';
export { ankiHtmlToText, decodeHtmlEntities, type AnkiFieldText } from './html.ts';
export { convertAnkiFuriganaRun } from './furigana.ts';
export { parseAnkiTemplate, type AnkiFieldRef, type AnkiTemplateSide } from './template.ts';
export { ankiLayoutId, ankiNoteTypeId } from './model-plan.ts';
export { encodeZstdRaw, inspectZstdStream, isZstd, type ZstdStreamInfo } from './zstd-frames.ts';
export { decodeProtobuf } from './protobuf.ts';
