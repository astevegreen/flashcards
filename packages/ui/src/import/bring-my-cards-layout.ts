/**
 * Fixed outer height of the Library "Bring my cards" panel (Phase 14), shared by the lazy panel
 * and its Suspense fallback in LibraryScreen. The panel opens above SourcesPanel and the deck
 * list, so its box never changes size: not when the chunk loads, not while a file is detected,
 * and not when a route (Anki, CSV, Sheets) replaces the drop zone. Its body scrolls instead.
 * Sized so the heading, drop zone and link field fit at 320px wide with room for a message.
 */
export const BRING_MY_CARDS_PANEL_HEIGHT = 'h-[30rem]';
