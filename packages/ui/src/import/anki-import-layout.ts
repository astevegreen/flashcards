/**
 * Fixed outer height of the Library "Import from Anki" panel, shared by the lazy panel and its
 * Suspense fallback in LibraryScreen. The panel sits above SourcesPanel and the rest of the
 * Library, so its box must not change size when the chunk loads, while an import runs, or when
 * it finishes with a long summary, warnings or an error: the status area inside scrolls instead.
 * Sized so the heading, description and controls fit at a 320px-wide viewport with room left for
 * about five lines of status.
 */
export const ANKI_IMPORT_PANEL_HEIGHT = 'h-[22rem]';
