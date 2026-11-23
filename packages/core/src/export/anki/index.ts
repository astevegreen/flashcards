/**
 * Export to Anki, exposed as the lazily loaded `@flash/core/anki-export` entry. Never re-export
 * this from `@flash/core`'s main barrel: it must stay out of the initial bundle (§8).
 */
export {
  ankiExportSlug,
  planAnkiCsvExport,
  zipAnkiCsvExport,
  type AnkiCsvExportOptions,
  type AnkiCsvExportPlan,
  type AnkiCsvExportZip,
} from './csv.ts';
export {
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
