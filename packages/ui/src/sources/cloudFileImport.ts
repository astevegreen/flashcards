import {
  createEventFactory,
  createHlcState,
  decodeUtf8,
  type CollectionState,
  type EventFactory,
  type KnownEvent,
} from '@flash/core';
import { canCreateOrImportDeck, type EntitlementState } from '@flash/core/license';
import type { PickedFile, PlatformServices } from '@flash/platform';
import { putMediaListTracked } from '../state/recentMedia.ts';

/**
 * One-shot import of a file picked from OneDrive or Dropbox (§15 Phase 12): `.csv` / `.tsv` / `.xlsx` become a
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

/** Trimmed first: a spreadsheet cell has no quotes, so every `.xlsx` path trims it (C17). */
function csvField(raw: string): string {
  const value = raw.trim();
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serializes an `.xlsx` grid as CSV so it takes the same import path as a `.csv` file. */
export function gridToCsv(grid: readonly (readonly string[])[]): string {
  return grid.map((row) => row.map(csvField).join(',')).join('\n');
}

/**
 * Reads the first sheet of an `.xlsx` file being imported. The phone shells have no Excel reader
 * yet, so it says so instead of parsing; linked files check the same thing (C21).
 */
export async function readXlsxGrid(
  platform: PlatformServices,
  name: string,
  bytes: Uint8Array,
): Promise<string[][]> {
  const adapter = await platform.getLocalFolderSources();
  if (adapter.canParseXlsx && !adapter.canParseXlsx()) {
    throw new Error(
      `Excel files can't be read on this device. Save "${name}" as CSV in Excel and import that instead.`,
    );
  }
  return adapter.parseXlsxBytes(bytes);
}

async function importSpreadsheet(
  picked: PickedFile,
  ctx: PickedFileImportContext,
  provider: string,
): Promise<string> {
  const noteType = ctx.state.noteTypes.get(ctx.noteTypeId);
  if (!noteType) throw new Error('Choose a note type for the new deck.');
  const gate = canCreateOrImportDeck(activeDeckCount(ctx.state), ctx.entitlement);
  if (!gate.allowed) throw new Error(gate.reason ?? 'Free tier deck limit reached.');

  const ext = extensionOf(picked.name);
  let text: string;
  if (ext === '.xlsx') {
    text = gridToCsv(await readXlsxGrid(ctx.platform, picked.name, picked.bytes));
  } else {
    text = decodeUtf8(picked.bytes);
  }
  const { buildEventsFromCsv } = await import('@flash/core/csv');
  const deckName =
    picked.name.slice(0, picked.name.length - ext.length).trim() || `${provider} Deck`;
  const build = (deckId: string, eventFactory: EventFactory) =>
    buildEventsFromCsv(text, {
      deckId,
      noteType,
      eventFactory,
      ...(ext === '.tsv' ? { delimiter: '\t' as const } : {}),
      existingNotes: ctx.state.notes.values(),
    });
  // Parse first with a throwaway factory (no sequence numbers used), so a file that fails to
  // parse or holds no notes never leaves an empty deck behind.
  const dryRunFactory = createEventFactory('dry-run', 0, createHlcState('dry-run', Date.now()));
  if (build('cloud-import-dry-run', dryRunFactory).importedCount === 0) {
    throw new Error(`"${picked.name}" has no notes to import, so no deck was created.`);
  }
  const deckId = ctx.createDeck(deckName, noteType.id, ctx.language);
  const result = build(deckId, ctx.getEventFactory());
  if (result.events.length > 0) ctx.emitEvents(result.events);
  const warn = result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : '';
  return `Imported ${result.importedCount} note(s) from ${provider} into "${deckName}"${warn}.`;
}

async function importPackage(
  picked: PickedFile,
  ctx: PickedFileImportContext,
  provider: string,
): Promise<string> {
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
  await putMediaListTracked(ctx.platform.storage, result.extractedMedia);
  if (result.events.length > 0) ctx.emitEvents(result.events);
  return `Imported "${result.manifest.name}" from ${provider} (${result.decksImported} deck(s), ${result.notesImported} note(s), ${result.pagesImported} page(s)).`;
}

/**
 * Imports one file picked from a cloud drive (OneDrive or Dropbox) and returns the status line to
 * show. `provider` names the drive in messages and in a new deck's fallback name.
 */
export async function importPickedCloudFile(
  picked: PickedFile,
  ctx: PickedFileImportContext,
  provider: string,
): Promise<string> {
  const ext = extensionOf(picked.name);
  if (ext === '.flashpkg') return importPackage(picked, ctx, provider);
  if (ext === '.csv' || ext === '.tsv' || ext === '.xlsx')
    return importSpreadsheet(picked, ctx, provider);
  throw new Error(`"${picked.name}" is not a .csv, .tsv, .xlsx or .flashpkg file.`);
}
