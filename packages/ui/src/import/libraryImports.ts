import type { CollectionState, EventFactory, KnownEvent } from '@flash/core';
import type { ColumnTarget } from '@flash/core/import-mapping';
import { canCreateOrImportDeck } from '@flash/core/license';
import type { EntitlementState, PlatformServices } from '@flash/platform';
import { putMediaListTracked } from '../state/recentMedia.ts';

/**
 * The Library's CSV/TSV and `.flashpkg` imports, shared by the header buttons and the guided
 * "Bring my cards" flow (Phase 14), so both run the same importer code. Parsers stay lazy:
 * `@flash/core/csv` and `@flash/core/flashpkg` load on first use. Every result is plain text.
 */

export interface LibraryImportContext {
  platform: PlatformServices;
  state: CollectionState;
  entitlement: EntitlementState;
  getEventFactory: () => EventFactory;
  emitEvents: (events: readonly KnownEvent[]) => void;
}

/** Thrown for refusals the user can act on (no deck, free-tier limit, …). */
export class LibraryImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryImportError';
  }
}

function activeDeckCount(state: CollectionState): number {
  return [...state.decks.values()].filter((d) => !d.archived).length;
}

/** Refuses when `newDecks` more decks would pass the free-tier limit. */
export function assertCanAddDecks(ctx: LibraryImportContext, newDecks: number): void {
  if (newDecks <= 0) return;
  const gate = canCreateOrImportDeck(activeDeckCount(ctx.state) + newDecks - 1, ctx.entitlement);
  if (!gate.allowed) throw new LibraryImportError(gate.reason ?? 'Free tier deck limit reached.');
}

export interface CsvImportOutcome {
  message: string;
  importedCount: number;
  warnings: number;
}

export interface CsvImportOptions {
  ankiRuby?: boolean;
  /** Where each column goes (the mapping step); without it, columns are matched by name. */
  columns?: readonly ColumnTarget[];
  /** `false` when the first row is already a card. */
  hasHeaderRow?: boolean;
  delimiter?: ',' | '\t';
}

/** Imports CSV/TSV rows (incl. Flashcards Deluxe `Text 1..N`) into an existing deck. */
export async function importCsvIntoDeck(
  ctx: LibraryImportContext,
  csvText: string,
  deckId: string,
  options: CsvImportOptions = {},
): Promise<CsvImportOutcome> {
  const deck = ctx.state.decks.get(deckId);
  if (!deck) throw new LibraryImportError('Select or create a deck before importing CSV/TSV.');
  const noteType = ctx.state.noteTypes.get(deck.note_type_id);
  if (!noteType) throw new LibraryImportError('Deck note type not found.');
  const { buildEventsFromCsv } = await import('@flash/core/csv');
  const result = buildEventsFromCsv(csvText, {
    deckId: deck.id,
    noteType,
    eventFactory: ctx.getEventFactory(),
    ankiRuby: options.ankiRuby === true,
    existingNotes: ctx.state.notes.values(),
    ...(options.columns ? { columns: options.columns } : {}),
    ...(options.hasHeaderRow === undefined ? {} : { hasHeaderRow: options.hasHeaderRow }),
    ...(options.delimiter ? { delimiter: options.delimiter } : {}),
  });
  if (result.events.length > 0) ctx.emitEvents(result.events);
  const warnSuffix = result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : '';
  return {
    message: `Imported ${result.importedCount} note(s) into "${deck.name}"${warnSuffix}.`,
    importedCount: result.importedCount,
    warnings: result.warnings.length,
  };
}

/** Imports a `.flashpkg` (safe-unzip caps and schema checks live in `importFlashpkg`). */
export async function importFlashpkgBytes(
  ctx: LibraryImportContext,
  bytes: Uint8Array,
): Promise<string> {
  const { importFlashpkg } = await import('@flash/core/flashpkg');
  const result = importFlashpkg(bytes, ctx.state, ctx.getEventFactory());
  assertCanAddDecks(ctx, Math.max(0, result.decksImported - result.upgradedDecks));
  await putMediaListTracked(ctx.platform.storage, result.extractedMedia);
  if (result.events.length > 0) ctx.emitEvents(result.events);
  return `Imported "${result.manifest.name}" (${result.decksImported} deck(s), ${result.notesImported} note(s), ${result.pagesImported} page(s), ${result.upgradedDecks} upgraded).`;
}
