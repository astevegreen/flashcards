import { decodeUtf8, type CollectionState, type EventFactory, type KnownEvent } from '@flash/core';
import { canCreateOrImportDeck, type EntitlementState } from '@flash/core/license';
import type { PickedFile, PlatformServices } from '@flash/platform';

/**
 * One-shot import of a file picked from OneDrive (§15 Phase 12): `.csv` / `.tsv` / `.xlsx` become a
 * new deck, `.flashpkg` imports exactly like Library > Import .flashpkg. Loaded with the picker.
 */
export interface PickedFileImportContext {
  platform: PlatformServices;
  state: CollectionState;
  entitlement: EntitlementState;
  getEventFactory: () => EventFactory;
  emitEvents: (events: readonly KnownEvent[]) => void;
  createDeck: (name: string, noteTypeId: string, language: string) => string;
  /** Note type and language for a new deck made from a spreadsheet. */
  noteTypeId: string;
  language: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function activeDeckCount(state: CollectionState): number {
  let count = 0;
  for (const deck of state.decks.values()) if (!deck.archived) count += 1;
  return count;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serializes an `.xlsx` grid as CSV so it takes the same import path as a `.csv` file. */
export function gridToCsv(grid: readonly (readonly string[])[]): string {
  return grid.map((row) => row.map(csvField).join(',')).join('\n');
}

async function importSpreadsheet(
  picked: PickedFile,
  ctx: PickedFileImportContext,
): Promise<string> {
  const noteType = ctx.state.noteTypes.get(ctx.noteTypeId);
  if (!noteType) throw new Error('Choose a note type for the new deck.');
  const gate = canCreateOrImportDeck(activeDeckCount(ctx.state), ctx.entitlement);
  if (!gate.allowed) throw new Error(gate.reason ?? 'Free tier deck limit reached.');

  const ext = extensionOf(picked.name);
  let text: string;
  if (ext === '.xlsx') {
    const adapter = await ctx.platform.getLocalFolderSources();
    text = gridToCsv(await adapter.parseXlsxBytes(picked.bytes));
  } else {
    text = decodeUtf8(picked.bytes);
  }
  const { buildEventsFromCsv } = await import('@flash/core/csv');
  const deckName = picked.name.slice(0, picked.name.length - ext.length).trim() || 'OneDrive Deck';
  const deckId = ctx.createDeck(deckName, noteType.id, ctx.language);
  const result = buildEventsFromCsv(text, {
    deckId,
    noteType,
    eventFactory: ctx.getEventFactory(),
    ...(ext === '.tsv' ? { delimiter: '\t' as const } : {}),
    existingNotes: ctx.state.notes.values(),
  });
  if (result.events.length > 0) ctx.emitEvents(result.events);
  const warn = result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : '';
  return `Imported ${result.importedCount} note(s) from OneDrive into "${deckName}"${warn}.`;
}

async function importPackage(picked: PickedFile, ctx: PickedFileImportContext): Promise<string> {
  const { importFlashpkg } = await import('@flash/core/flashpkg');
  const result = importFlashpkg(picked.bytes, ctx.state, ctx.getEventFactory());
  const netNewDecks = Math.max(0, result.decksImported - result.upgradedDecks);
  if (netNewDecks > 0) {
    const gate = canCreateOrImportDeck(
      activeDeckCount(ctx.state) + netNewDecks - 1,
      ctx.entitlement,
    );
    if (!gate.allowed) throw new Error(gate.reason ?? 'Free tier deck limit reached.');
  }
  for (const media of result.extractedMedia) {
    await ctx.platform.storage.putMedia({ hash: media.hash, mime: media.mime, bytes: media.bytes });
  }
  if (result.events.length > 0) ctx.emitEvents(result.events);
  return `Imported "${result.manifest.name}" from OneDrive (${result.decksImported} deck(s), ${result.notesImported} note(s), ${result.pagesImported} page(s)).`;
}

/** Imports one picked file and returns the status line to show. */
export async function importPickedOneDriveFile(
  picked: PickedFile,
  ctx: PickedFileImportContext,
): Promise<string> {
  const ext = extensionOf(picked.name);
  if (ext === '.flashpkg') return importPackage(picked, ctx);
  if (ext === '.csv' || ext === '.tsv' || ext === '.xlsx') return importSpreadsheet(picked, ctx);
  throw new Error(`"${picked.name}" is not a .csv, .tsv, .xlsx or .flashpkg file.`);
}
