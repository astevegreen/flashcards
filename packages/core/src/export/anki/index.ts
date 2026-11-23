/**
 * Export to Anki, exposed as the lazily loaded `@flash/core/anki-export` entry. Never re-export
 * this from `@flash/core`'s main barrel: it must stay out of the initial bundle (§8).
 */
export {
  ankiExportSlug,
  planAnkiCsvExport,
  writeAnkiCsvZip,
  type AnkiCsvExportOptions,
  type AnkiCsvZipOptions,
  type AnkiMediaReader,
  type AnkiCsvExportPlan,
  type AnkiCsvExportZip,
} from './csv.ts';
export {
  ANKI_MEDIA_MIME_BY_EXT,
  AnkiMediaNamer,
  ankiFieldHtml,
  ankiFieldNames,
  ankiGuid,
  ankiTags,
  escapeAnkiText,
  hasRuby,
  rubyTextToAnkiHtml,
  type AnkiFieldHtmlContext,
  type AnkiMediaFile,
  type AnkiRichTextConverter,
} from './field-html.ts';
export { ANKI_RICH_TEXT_COLORS, ankiRichTextToHtml } from './rich-text-html.ts';
export { AnkiZipTooLargeError, AnkiZipWriter, crc32 } from './zip-writer.ts';
export {
  ANKI_SCHEMA_11,
  planAnkiApkgExport,
  writeApkg,
  type AnkiApkgExportOptions,
  type AnkiApkgPlan,
  type AnkiApkgResult,
  type AnkiCollectionPlan,
  type AnkiExportTable,
  type AnkiSqlCell,
} from './apkg.ts';
