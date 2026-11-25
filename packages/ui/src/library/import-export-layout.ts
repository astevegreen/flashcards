/**
 * Fixed outer height of the Decks "Import / Export" panel, shared by the lazy panel and its
 * Suspense fallback in LibraryScreen. The panel sits above SourcesPanel and the deck list, so its
 * box must not change size when the chunk loads, when switching between Import and Export, or when
 * an import route or summary expands: the body inside scrolls instead.
 */
export const IMPORT_EXPORT_PANEL_HEIGHT = 'h-[36rem]';
