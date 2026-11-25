import {
  BUILTIN_NOTE_TYPE_IDS,
  FLASH_NAMESPACE_UUID,
  uuidv5,
  type CollectionState,
  type Deck,
  type DeckCreatedPayload,
  type EventFactory,
  type KnownEvent,
  type NoteType,
  type SourceColumnMapping,
  type SourceRef,
} from '@flash/core';
import { diffTabularSource, inferPresetNoteTypeId, sha256Hex } from '@flash/core/sources';
import type {
  DropboxFileInfo,
  DropboxFilePicker,
  LinkedDropboxSource,
  PendingXlsxReconciliation,
  PlatformServices,
  SourcesRegistry,
  SourceWarning,
} from '@flash/platform';
import {
  loadSourcesRegistry,
  readOneDriveTable,
  saveSourcesRegistry,
  type SourceRefreshSummary,
  type SourceRunContext,
  withSourcesLock,
} from './sourceRunner.ts';

const DROPBOX_TABLE_EXTENSION = /\.(csv|tsv|xlsx)$/i;

/** Prefix of `PendingXlsxReconciliation.folderId` for a linked Dropbox file (then the file id). */
export const DROPBOX_RECONCILE_PREFIX = 'dropbox:';

export interface DropboxLinkOptions {
  noteTypeId?: string;
  language?: string;
  columnMap?: SourceColumnMapping[];
}

export interface DropboxRefreshOptions {
  force?: boolean;
  columnMap?: SourceColumnMapping[];
  /** existing note id -> new first-field value, from the reconciliation prompt. */
  renameMap?: Readonly<Record<string, string>>;
}

export interface DropboxRefreshResult {
  updated: boolean;
  notesTouched: number;
  warnings: SourceWarning[];
  pending?: PendingXlsxReconciliation;
  unreadable?: true;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
    ? true
    : navigator.onLine;
}

function dropboxDeckId(source: Pick<LinkedDropboxSource, 'fileId' | 'deckId'>): string {
  return source.deckId ?? uuidv5(FLASH_NAMESPACE_UUID, `dropbox:${source.fileId}`);
}

function archivedDeckRefreshMessage(deckName: string): string {
  return `The deck "${deckName}" is archived. Restore it to refresh this source.`;
}

function excelUnreadableMessage(name: string): string {
  return `Excel files can't be read on this device. Save "${name}" as CSV in Excel and link that instead.`;
}

async function canReadExcel(platform: PlatformServices): Promise<boolean> {
  try {
    const adapter = await platform.getLocalFolderSources();
    return adapter.canParseXlsx ? adapter.canParseXlsx() : true;
  } catch {
    return false;
  }
}

function resolveNoteType(state: CollectionState, noteTypeId?: string): NoteType {
  if (noteTypeId) {
    const found = state.noteTypes.get(noteTypeId);
    if (found) return found;
  }
  const fallback =
    state.noteTypes.get(BUILTIN_NOTE_TYPE_IDS.VOCAB_KO) ?? [...state.noteTypes.values()][0];
  if (!fallback) throw new Error('No note types available in collection state.');
  return fallback;
}

function addDropboxSource(
  registry: SourcesRegistry,
  file: { id: string; name: string; pathDisplay?: string },
  options: DropboxLinkOptions | undefined,
): LinkedDropboxSource {
  const source: LinkedDropboxSource = {
    id: `dropbox:${file.id}`,
    fileId: file.id,
    name: file.name.replace(DROPBOX_TABLE_EXTENSION, ''),
    ...(file.pathDisplay ? { pathDisplay: file.pathDisplay } : {}),
    ...(options?.noteTypeId !== undefined ? { noteTypeId: options.noteTypeId } : {}),
    ...(options?.language !== undefined ? { language: options.language } : {}),
    lastStatus: 'idle',
  };
  registry.dropboxSources ??= [];
  registry.dropboxSources.push(source);
  return source;
}

function recordFailedDropboxLink(
  registry: SourcesRegistry,
  source: LinkedDropboxSource,
  err: unknown,
  chosenColumnMap: boolean,
): void {
  if (!source.deckId) {
    registry.dropboxSources = (registry.dropboxSources ?? []).filter((s) => s !== source);
    return;
  }
  source.lastStatus = 'error';
  source.lastError = err instanceof Error ? err.message : String(err);
  if (chosenColumnMap) source.columnMapUnsaved = true;
}

function markDropboxSkipped(
  source: LinkedDropboxSource,
  reason: NonNullable<LinkedDropboxSource['skipReason']>,
  message: string,
): void {
  source.lastStatus = 'idle';
  source.lastError = message;
  source.skipReason = reason;
}

function markDropboxSynced(source: LinkedDropboxSource, nowMs: number): void {
  source.lastSyncedAt = nowMs;
  source.lastStatus = 'synced';
  delete source.lastError;
  delete source.skipReason;
}

async function prepareDropboxPull(
  source: LinkedDropboxSource,
  ctx: SourceRunContext,
  opts: DropboxRefreshOptions | undefined,
): Promise<
  | { result: DropboxRefreshResult }
  | { picker: DropboxFilePicker; info: DropboxFileInfo; nowMs: number }
> {
  const unchanged = { updated: false, notesTouched: 0, warnings: source.warnings ?? [] };
  const deck = ctx.getState().decks.get(dropboxDeckId(source));
  if (deck?.archived) {
    markDropboxSkipped(source, 'archived', archivedDeckRefreshMessage(deck.name));
    return { result: unchanged };
  }
  if (!isOnline()) {
    source.lastStatus = 'offline';
    return { result: unchanged };
  }
  if (!ctx.platform.getDropboxPicker) throw new Error('Dropbox is not available in this build.');
  const picker = await ctx.platform.getDropboxPicker();
  if (!(await picker.isConnected())) {
    source.lastStatus = 'permission_required';
    source.lastError = 'Connect Dropbox to refresh this source.';
    return { result: unchanged };
  }

  const nowMs = Date.now();
  const info = await picker.getFileInfo(source.fileId);
  const tagUnchanged =
    !opts?.force &&
    source.deckId &&
    source.contentTag &&
    !source.columnMapUnsaved &&
    info.contentTag === source.contentTag;
  if (tagUnchanged) {
    markDropboxSynced(source, nowMs);
    return { result: unchanged };
  }
  if (info.name.toLowerCase().endsWith('.xlsx') && !(await canReadExcel(ctx.platform))) {
    markDropboxSkipped(source, 'unreadable', excelUnreadableMessage(info.name));
    return { result: { ...unchanged, unreadable: true } };
  }
  return { picker, info, nowMs };
}

function resolveDropboxColumnMap(
  source: LinkedDropboxSource,
  opts: DropboxRefreshOptions | undefined,
  deckSource: SourceRef | undefined,
): SourceColumnMapping[] | undefined {
  return (
    opts?.columnMap ??
    (source.columnMapUnsaved ? source.columnMap : undefined) ??
    deckSource?.column_map ??
    source.columnMap
  );
}

function dropboxDeckEvent(
  factory: EventFactory,
  existingDeck: Deck | undefined,
  created: DeckCreatedPayload & { source: SourceRef },
  nowMs: number,
): KnownEvent | null {
  if (!existingDeck) return factory.create('DeckCreated', created, nowMs);
  const prev = existingDeck.source;
  const next = created.source;
  const sameRef =
    prev?.kind === 'dropbox_file' &&
    prev.content_hash === next.content_hash &&
    prev.uri === next.uri &&
    JSON.stringify(prev.column_map ?? null) === JSON.stringify(next.column_map ?? null);
  if (sameRef) return null;
  return factory.create(
    'SourceLinked',
    { target_kind: 'deck', target_id: created.deck_id, source: next },
    nowMs,
  );
}

function resolveDropboxDeckShape(
  state: CollectionState,
  source: LinkedDropboxSource,
  existingDeck: Deck | undefined,
  headers: readonly string[] | undefined,
): { noteType: NoteType; language: string } {
  const inferred = inferPresetNoteTypeId(
    headers ? [...headers] : [],
    source.noteTypeId ?? BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
  );
  const noteType = resolveNoteType(
    state,
    existingDeck?.note_type_id ?? source.noteTypeId ?? inferred.noteTypeId,
  );
  return { noteType, language: existingDeck?.language ?? source.language ?? inferred.language };
}

function dropboxSourceRef(
  fileId: string,
  pathDisplay: string | undefined,
  contentHash: string,
  columnMap: SourceColumnMapping[] | undefined,
  nowMs: number,
): SourceRef {
  return {
    kind: 'dropbox_file',
    ...(pathDisplay ? { uri: pathDisplay } : {}),
    external_id: fileId,
    read_only: true,
    content_hash: contentHash,
    last_synced_at: nowMs,
    ...(columnMap ? { column_map: [...columnMap] } : {}),
  };
}

/**
 * Links one Dropbox App Folder `.csv` / `.tsv` / `.xlsx` file as a source and runs the first pull.
 * Read-only: rows match by their first field, and potential renames are held for reconciliation.
 */
export async function linkDropboxFile(
  file: { id: string; name: string; pathDisplay?: string },
  ctx: SourceRunContext,
  options?: DropboxLinkOptions,
): Promise<{
  source: LinkedDropboxSource;
  registry: SourcesRegistry;
  notesTouched: number;
  pending?: PendingXlsxReconciliation;
}> {
  return withSourcesLock(async () => {
    if (!DROPBOX_TABLE_EXTENSION.test(file.name)) {
      throw new Error(`"${file.name}" is not a .csv, .tsv or .xlsx file.`);
    }
    const state = ctx.getState();
    const registry = await loadSourcesRegistry(ctx.platform, state);
    const existing = registry.dropboxSources?.find((s) => s.fileId === file.id);
    const archived = state.decks.get(dropboxDeckId(existing ?? { fileId: file.id }));
    if (archived?.archived) {
      throw new Error(
        `The deck "${archived.name}" from this file is archived. Restore it in the Library first.`,
      );
    }
    const source = existing ?? addDropboxSource(registry, file, options);
    if (file.pathDisplay) source.pathDisplay = file.pathDisplay;
    if (options?.columnMap) source.columnMap = [...options.columnMap];
    try {
      const res = await refreshSingleDropboxSource(source, ctx, {
        force: true,
        ...(options?.columnMap ? { columnMap: options.columnMap } : {}),
      });
      if (res.unreadable) throw new Error(source.lastError ?? 'This file cannot be read here.');
      await saveSourcesRegistry(ctx.platform, registry);
      return {
        source,
        registry,
        notesTouched: res.notesTouched,
        ...(res.pending ? { pending: res.pending } : {}),
      };
    } catch (err) {
      recordFailedDropboxLink(registry, source, err, Boolean(options?.columnMap));
      await saveSourcesRegistry(ctx.platform, registry);
      throw err;
    }
  });
}

/**
 * Refreshes one linked Dropbox App Folder file. Compares Dropbox `content_hash`/`rev` first and
 * skips downloading when unchanged.
 */
export async function refreshSingleDropboxSource(
  source: LinkedDropboxSource,
  ctx: SourceRunContext,
  opts?: DropboxRefreshOptions,
): Promise<DropboxRefreshResult> {
  const ready = await prepareDropboxPull(source, ctx, opts);
  if ('result' in ready) return ready.result;
  const { picker, info, nowMs } = ready;

  const picked = await picker.downloadById(source.fileId, info.size);
  const grid = await readOneDriveTable(ctx.platform, picked);

  const state = ctx.getState();
  const factory = ctx.getEventFactory();
  const deckId = dropboxDeckId(source);
  const existingDeck = state.decks.get(deckId);
  const { noteType, language } = resolveDropboxDeckShape(state, source, existingDeck, grid[0]);
  const columnMap = resolveDropboxColumnMap(source, opts, existingDeck?.source);

  const diff = diffTabularSource({
    deckId,
    noteType,
    state,
    eventFactory: factory,
    grid,
    identityMode: 'sort_key',
    canWriteBack: false,
    ...(opts?.renameMap ? { renameMap: opts.renameMap } : {}),
    ...(columnMap ? { columnMap } : {}),
    nowMs,
  });

  if (existingDeck && diff.reconciliationCandidates && !opts?.renameMap) {
    if (opts?.columnMap) {
      source.columnMap = [...opts.columnMap];
      source.columnMapUnsaved = true;
    }
    return {
      updated: false,
      notesTouched: 0,
      warnings: source.warnings ?? [],
      pending: {
        folderId: `${DROPBOX_RECONCILE_PREFIX}${source.fileId}`,
        relativePath: picked.name,
        deckId,
        deckName: existingDeck.name,
        missingNotes: diff.reconciliationCandidates.missingNotes,
        addedRows: diff.reconciliationCandidates.addedRows,
      },
    };
  }

  const pathDisplay = info.pathDisplay || source.pathDisplay;
  const deckEvent = dropboxDeckEvent(
    factory,
    existingDeck,
    {
      deck_id: deckId,
      name: source.name,
      note_type_id: noteType.id,
      language,
      source: dropboxSourceRef(
        source.fileId,
        pathDisplay,
        sha256Hex(picked.bytes),
        columnMap,
        nowMs,
      ),
      created_at: nowMs,
    },
    nowMs,
  );
  const events: KnownEvent[] = deckEvent ? [deckEvent, ...diff.events] : [...diff.events];
  if (events.length > 0) ctx.emitEvents(events);

  source.deckId = deckId;
  source.noteTypeId = noteType.id;
  source.language = language;
  if (columnMap) source.columnMap = [...columnMap];
  delete source.columnMapUnsaved;
  if (pathDisplay) source.pathDisplay = pathDisplay;
  if (info.contentTag) source.contentTag = info.contentTag;
  markDropboxSynced(source, nowMs);
  source.warnings = diff.warnings.map((w) => ({
    code: w.code,
    message: w.message,
    ...(w.row !== undefined ? { row: w.row } : {}),
    ...(w.header !== undefined ? { header: w.header } : {}),
  }));

  const notesTouched =
    diff.stats.added + diff.stats.updated + diff.stats.archived + diff.stats.restored;
  return {
    updated: !existingDeck || notesTouched > 0,
    notesTouched,
    warnings: source.warnings ?? [],
  };
}

type DropboxRefreshTally = Pick<
  SourceRefreshSummary,
  | 'updatedSources'
  | 'importedNotes'
  | 'warningsCount'
  | 'pendingReconciliations'
  | 'errors'
  | 'skipped'
>;

/** The Dropbox part of `refreshAllSources`: one row's failure never stops the others. */
export async function refreshLinkedDropboxFiles(
  sources: readonly LinkedDropboxSource[],
  ctx: SourceRunContext,
  force: boolean | undefined,
): Promise<DropboxRefreshTally> {
  const tally: DropboxRefreshTally = {
    updatedSources: 0,
    importedNotes: 0,
    warningsCount: 0,
    pendingReconciliations: [],
    errors: [],
    skipped: [],
  };
  const refreshOpts = force !== undefined ? { force } : {};
  for (const src of sources) {
    try {
      const res = await refreshSingleDropboxSource(src, ctx, refreshOpts); // NOSONAR (S9382)
      if (res.pending) tally.pendingReconciliations.push(res.pending);
      if (res.updated) tally.updatedSources += 1;
      tally.importedNotes += res.notesTouched;
      tally.warningsCount += res.warnings.length;
      if (src.skipReason) tally.skipped.push(`${src.name}: ${src.lastError ?? 'not refreshed'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      src.lastStatus = 'error';
      src.lastError = msg;
      tally.errors.push(`${src.name}: ${msg}`);
    }
  }
  return tally;
}
