import {
  BUILTIN_NOTE_TYPE_IDS,
  decodeUtf8,
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
import { parseDelimitedText } from '@flash/core/csv';
import { diffTabularSource, inferPresetNoteTypeId, sha256Hex } from '@flash/core/sources';
import type {
  PendingXlsxReconciliation,
  PickedFile,
  PlatformServices,
  SourcesRegistry,
  SourceSyncStatus,
  SourceWarning,
} from '@flash/platform';
import {
  isOnline,
  loadSourcesRegistry,
  resolveNoteType,
  saveSourcesRegistry,
  type SourceRefreshSummary,
  type SourceRunContext,
  withSourcesLock,
} from './sourcesRegistry.ts';

/**
 * Linked cloud FILES (§3.1, §15 Phase 12): one `.csv` / `.tsv` / `.xlsx` in OneDrive, Dropbox or
 * Google Drive refreshes into one deck. One runner serves all three through a
 * {@link CloudFileProvider}: a cheap metadata call compares the content tag, the file is
 * downloaded only when it changed, rows are matched by their first field (the app never writes to
 * the file), and a likely rename holds the pull for the reconciliation prompt. A file whose deck is
 * archived, or an `.xlsx` this device can't read, is left alone and its row says why.
 */

export type CloudFileKind = 'onedrive_file' | 'dropbox_file' | 'google_drive_file';

/** The fields every linked cloud file row has (`LinkedOneDriveSource` and the others). */
export interface CloudFileRow {
  id: string;
  name: string;
  deckId?: string;
  noteTypeId?: string;
  language?: string;
  columnMap?: SourceColumnMapping[];
  columnMapUnsaved?: true;
  contentTag?: string;
  skipReason?: 'archived' | 'unreadable';
  lastSyncedAt?: number;
  lastStatus?: SourceSyncStatus;
  lastError?: string;
  warnings?: SourceWarning[];
}

/** The metadata a provider returns before any download. */
export interface CloudFileInfo {
  name: string;
  contentTag?: string;
}

/** Options for linking: the choices made in the column-mapping step. */
export interface CloudFileLinkOptions {
  noteTypeId?: string;
  language?: string;
  columnMap?: SourceColumnMapping[];
}

export interface CloudFileRefreshOptions {
  force?: boolean;
  columnMap?: SourceColumnMapping[];
  /** existing note id -> new first-field value, from the reconciliation prompt. */
  renameMap?: Readonly<Record<string, string>>;
}

export interface CloudFileRefreshResult {
  updated: boolean;
  notesTouched: number;
  warnings: SourceWarning[];
  pending?: PendingXlsxReconciliation;
  /** An `.xlsx` this device cannot read: nothing was downloaded or changed. */
  unreadable?: true;
}

export interface CloudFilePullReady<I, C> {
  client: C;
  info: I;
  nowMs: number;
}

/** What one provider does differently; the runner does the rest. */
export interface CloudFileProvider<
  S extends CloudFileRow,
  I extends CloudFileInfo = CloudFileInfo,
  C = unknown,
  F extends { id: string; name: string } = { id: string; name: string },
> {
  kind: CloudFileKind;
  /** Row id prefix, deck-id seed and `PendingXlsxReconciliation.folderId` prefix (`onedrive:`). */
  prefix: string;
  /** The provider's name in messages ("OneDrive"). */
  label: string;
  /** The provider's file id. */
  idOf(source: S): string;
  rows(registry: SourcesRegistry): S[] | undefined;
  setRows(registry: SourcesRegistry, rows: S[]): void;
  /** Throws when `file` can't be linked; else says whether it is a table or a `.flashpkg`. */
  checkLinkable(file: F): 'table' | 'package';
  newRow(file: F, options: CloudFileLinkOptions | undefined): S;
  /** Row changes when linking a file again (a newer path, a cleared legacy unlink). */
  beforeLink?(registry: SourcesRegistry, source: S, file: F): void;
  /** Opens the provider, or marks the row `permission_required` and returns `null`. */
  open(ctx: SourceRunContext, source: S): Promise<C | null>;
  getInfo(client: C, source: S): Promise<I>;
  download(client: C, source: S, info: I): Promise<PickedFile>;
  /** The file's address to show and store (`SourceRef.uri`), else the row's old one. */
  uriOf(info: I, source: S): string | undefined;
  setUri(source: S, uri: string): void;
  isXlsx(info: I): boolean;
  readTable(platform: PlatformServices, picked: PickedFile): Promise<string[][]>;
  /** Package rows (Drive `.flashpkg`) skip the archived check and pull with `pullPackage`. */
  isPackage?(source: S): boolean;
  pullPackage?(
    source: S,
    ctx: SourceRunContext,
    ready: CloudFilePullReady<I, C>,
  ): Promise<CloudFileRefreshResult>;
  /** Turns an access failure into row state (true), or lets it throw (false). */
  onAccessError?(source: S, err: unknown): boolean;
}

const TABLE_EXTENSION = /\.(csv|tsv|xlsx)$/i;

export function archivedDeckRefreshMessage(deckName: string): string {
  return `The deck "${deckName}" is archived. Restore it to refresh this source.`;
}

export function excelUnreadableMessage(name: string): string {
  return `Excel files can't be read on this device. Save "${name}" as CSV in Excel and link that instead.`;
}

/** True when this device can read `.xlsx` (the web and PC shells; not the phone shells yet). */
export async function canReadExcel(platform: PlatformServices): Promise<boolean> {
  try {
    const adapter = await platform.getLocalFolderSources();
    return adapter.canParseXlsx ? adapter.canParseXlsx() : true;
  } catch {
    return false;
  }
}

/** Throws unless `name` is a `.csv`, `.tsv` or `.xlsx` file. */
export function assertTableFileName(name: string): 'table' {
  if (!TABLE_EXTENSION.test(name)) throw new Error(`"${name}" is not a .csv, .tsv or .xlsx file.`);
  return 'table';
}

/** A table file's name as a deck title (extension removed). */
export function tableDisplayName(name: string): string {
  return name.replace(TABLE_EXTENSION, '');
}

/** Reads a downloaded `.csv` / `.tsv` / `.xlsx` into a grid whose first row is the headers. */
export async function readCloudTable(
  platform: PlatformServices,
  picked: PickedFile,
): Promise<string[][]> {
  const lower = picked.name.toLowerCase();
  let grid: string[][];
  if (lower.endsWith('.xlsx')) {
    try {
      grid = await (await platform.getLocalFolderSources()).parseXlsxBytes(picked.bytes);
    } catch {
      // Native shells have no Excel reader (the phone folder adapter is PC-only, Tauri has no parser).
      throw new Error(excelUnreadableMessage(picked.name));
    }
  } else if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    const parsed = parseDelimitedText(decodeUtf8(picked.bytes), {
      delimiter: lower.endsWith('.tsv') ? '\t' : ',',
    });
    grid = parsed.headers.length > 0 ? [parsed.headers, ...parsed.rows] : [];
  } else {
    throw new Error(`"${picked.name}" is not a .csv, .tsv or .xlsx file.`);
  }
  if ((grid[0] ?? []).every((cell) => cell.trim() === '')) {
    throw new Error(`"${picked.name}" has no column names in its first row.`);
  }
  return grid;
}

/** The deck a file fills: the row's, else one derived from the provider prefix and file id. */
export function cloudFileDeckId(prefix: string, fileId: string, deckId?: string): string {
  return deckId ?? uuidv5(FLASH_NAMESPACE_UUID, `${prefix}${fileId}`);
}

/** Leaves the file alone on this refresh, and says why on its row. */
function markSkipped(
  source: CloudFileRow,
  reason: NonNullable<CloudFileRow['skipReason']>,
  message: string,
): void {
  source.lastStatus = 'idle';
  source.lastError = message;
  source.skipReason = reason;
}

export function markCloudFileSynced(source: CloudFileRow, nowMs: number): void {
  source.lastSyncedAt = nowMs;
  source.lastStatus = 'synced';
  delete source.lastError;
  delete source.skipReason;
}

export function markPermissionRequired(source: CloudFileRow, message: string): void {
  source.lastStatus = 'permission_required';
  source.lastError = message;
}

/**
 * Leaves a table row whose deck is archived alone and says so on the row (returns true). Package
 * rows are never skipped here: their decks are checked by the import.
 */
export function skipIfArchived<
  S extends CloudFileRow,
  I extends CloudFileInfo,
  C,
  F extends { id: string; name: string },
>(p: CloudFileProvider<S, I, C, F>, source: S, state: CollectionState): boolean {
  if (p.isPackage?.(source)) return false;
  const deck = state.decks.get(cloudFileDeckId(p.prefix, p.idOf(source), source.deckId));
  if (!deck?.archived) return false;
  markSkipped(source, 'archived', archivedDeckRefreshMessage(deck.name));
  return true;
}

function unchangedResult(source: CloudFileRow): CloudFileRefreshResult {
  return { updated: false, notesTouched: 0, warnings: source.warnings ?? [] };
}

/**
 * Everything a refresh decides before downloading: an archived deck, offline, no access, an
 * unchanged content tag, or an `.xlsx` this device can't read end it with `result`.
 */
async function preparePull<
  S extends CloudFileRow,
  I extends CloudFileInfo,
  C,
  F extends { id: string; name: string },
>(
  p: CloudFileProvider<S, I, C, F>,
  source: S,
  ctx: SourceRunContext,
  opts: CloudFileRefreshOptions | undefined,
): Promise<{ result: CloudFileRefreshResult } | CloudFilePullReady<I, C>> {
  const unchanged = unchangedResult(source);
  const isPackage = p.isPackage?.(source) ?? false;
  // Before any network call, so the row keeps saying why even when the file is unchanged.
  if (skipIfArchived(p, source, ctx.getState())) return { result: unchanged };
  if (!isOnline()) {
    source.lastStatus = 'offline';
    return { result: unchanged };
  }
  const client = await p.open(ctx, source);
  if (client === null) return { result: unchanged };

  const nowMs = Date.now();
  const info = await p.getInfo(client, source);
  const tagUnchanged =
    !opts?.force &&
    source.deckId &&
    source.contentTag &&
    !source.columnMapUnsaved &&
    info.contentTag === source.contentTag;
  if (tagUnchanged) {
    markCloudFileSynced(source, nowMs);
    return { result: unchanged };
  }
  // Decide from the name before fetching up to 50 MB this device could not read anyway.
  if (!isPackage && p.isXlsx(info) && !(await canReadExcel(ctx.platform))) {
    markSkipped(source, 'unreadable', excelUnreadableMessage(info.name));
    return { result: { ...unchanged, unreadable: true } };
  }
  return { client, info, nowMs };
}

/**
 * The mapping for this pull: one chosen now, else one chosen here that hasn't reached the deck
 * yet, else the deck's synced one, else the copy kept when it was linked.
 */
function resolveColumnMap(
  source: CloudFileRow,
  opts: CloudFileRefreshOptions | undefined,
  deckSource: SourceRef | undefined,
): SourceColumnMapping[] | undefined {
  return (
    opts?.columnMap ??
    (source.columnMapUnsaved ? source.columnMap : undefined) ??
    deckSource?.column_map ??
    source.columnMap
  );
}

/** The deck's note type and language, else the ones chosen when linking, else guessed. */
function resolveDeckShape(
  state: CollectionState,
  source: CloudFileRow,
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

/** `DeckCreated` for a new deck, else `SourceLinked` when the deck's source changed. */
function deckEvent(
  factory: EventFactory,
  existingDeck: Deck | undefined,
  created: DeckCreatedPayload & { source: SourceRef },
  nowMs: number,
): KnownEvent | null {
  if (!existingDeck) return factory.create('DeckCreated', created, nowMs);
  const prev = existingDeck.source;
  const next = created.source;
  const sameRef =
    prev?.kind === next.kind &&
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

export function toSourceWarnings(
  warnings: ReadonlyArray<{ code: string; message: string; row?: number; header?: string }>,
): SourceWarning[] {
  return warnings.map((w) => ({
    code: w.code,
    message: w.message,
    ...(w.row !== undefined ? { row: w.row } : {}),
    ...(w.header !== undefined ? { header: w.header } : {}),
  }));
}

/**
 * Downloads, diffs and applies one table. Applying a likely rename now would archive the old note
 * (and its review history) and add a new one, so it holds the pull instead; the content tag stays
 * old, so the next refresh asks again. A mapping chosen for this pull is kept on the row until it
 * lands on the deck.
 */
async function pullTable<
  S extends CloudFileRow,
  I extends CloudFileInfo,
  C,
  F extends { id: string; name: string },
>(
  p: CloudFileProvider<S, I, C, F>,
  source: S,
  ctx: SourceRunContext,
  opts: CloudFileRefreshOptions | undefined,
  ready: CloudFilePullReady<I, C>,
): Promise<CloudFileRefreshResult> {
  const { client, info, nowMs } = ready;
  const picked = await p.download(client, source, info);
  const grid = await p.readTable(ctx.platform, picked);

  const state = ctx.getState();
  const factory = ctx.getEventFactory();
  const fileId = p.idOf(source);
  const deckId = cloudFileDeckId(p.prefix, fileId, source.deckId);
  const existingDeck = state.decks.get(deckId);
  const { noteType, language } = resolveDeckShape(state, source, existingDeck, grid[0]);
  const columnMap = resolveColumnMap(source, opts, existingDeck?.source);

  // Read-only, so rows are matched by their first field (like a linked local `.xlsx`).
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
      ...unchangedResult(source),
      pending: {
        folderId: `${p.prefix}${fileId}`,
        relativePath: picked.name,
        deckId,
        deckName: existingDeck.name,
        missingNotes: diff.reconciliationCandidates.missingNotes,
        addedRows: diff.reconciliationCandidates.addedRows,
      },
    };
  }

  const uri = p.uriOf(info, source);
  const sourceRef: SourceRef = {
    kind: p.kind,
    ...(uri ? { uri } : {}),
    external_id: fileId,
    read_only: true,
    content_hash: sha256Hex(picked.bytes),
    last_synced_at: nowMs,
    ...(columnMap ? { column_map: [...columnMap] } : {}),
  };
  const event = deckEvent(
    factory,
    existingDeck,
    {
      deck_id: deckId,
      name: source.name,
      note_type_id: noteType.id,
      language,
      source: sourceRef,
      created_at: nowMs,
    },
    nowMs,
  );
  const events: KnownEvent[] = event ? [event, ...diff.events] : [...diff.events];
  if (events.length > 0) ctx.emitEvents(events);

  source.deckId = deckId;
  source.noteTypeId = noteType.id;
  source.language = language;
  if (columnMap) source.columnMap = [...columnMap];
  delete source.columnMapUnsaved;
  if (uri) p.setUri(source, uri);
  if (info.contentTag) source.contentTag = info.contentTag;
  markCloudFileSynced(source, nowMs);
  source.warnings = toSourceWarnings(diff.warnings);

  const notesTouched =
    diff.stats.added + diff.stats.updated + diff.stats.archived + diff.stats.restored;
  return {
    updated: !existingDeck || notesTouched > 0,
    notesTouched,
    warnings: source.warnings,
  };
}

/**
 * Refreshes one linked file. The content tag is compared first; the file is downloaded and
 * applied only when it changed (or `force`). When some rows went missing and new ones appeared (a
 * likely rename), nothing is applied and `pending` carries the reconciliation prompt; pass its
 * answer back as `renameMap` to apply the pull.
 */
export async function refreshCloudFile<
  S extends CloudFileRow,
  I extends CloudFileInfo,
  C,
  F extends { id: string; name: string },
>(
  p: CloudFileProvider<S, I, C, F>,
  source: S,
  ctx: SourceRunContext,
  opts?: CloudFileRefreshOptions,
): Promise<CloudFileRefreshResult> {
  try {
    const ready = await preparePull(p, source, ctx, opts);
    if ('result' in ready) return ready.result;
    if (p.pullPackage && p.isPackage?.(source)) return await p.pullPackage(source, ctx, ready);
    return await pullTable(p, source, ctx, opts, ready);
  } catch (err) {
    if (p.onAccessError?.(source, err)) return unchangedResult(source);
    throw err;
  }
}

/** A first pull that failed leaves nothing to refresh, so don't keep a row without a deck. */
function recordFailedLink<
  S extends CloudFileRow,
  I extends CloudFileInfo,
  C,
  F extends { id: string; name: string },
>(
  p: CloudFileProvider<S, I, C, F>,
  registry: SourcesRegistry,
  source: S,
  err: unknown,
  chosenColumnMap: boolean,
): void {
  if (!source.deckId) {
    p.setRows(
      registry,
      (p.rows(registry) ?? []).filter((s) => s !== source),
    );
    return;
  }
  source.lastStatus = 'error';
  source.lastError = err instanceof Error ? err.message : String(err);
  // The chosen mapping was already written to this device's copy: keep it winning.
  if (chosenColumnMap) source.columnMapUnsaved = true;
}

/**
 * Links one file as a source and runs the first pull. When the first pull fails, nothing is kept.
 * When it finds likely renamed rows, nothing is applied and `pending` asks the user.
 */
export async function linkCloudFile<
  S extends CloudFileRow,
  I extends CloudFileInfo,
  C,
  F extends { id: string; name: string },
>(
  p: CloudFileProvider<S, I, C, F>,
  file: F,
  ctx: SourceRunContext,
  options?: CloudFileLinkOptions,
): Promise<CloudFileLinkResult<S>> {
  return withSourcesLock(async () => {
    const format = p.checkLinkable(file);
    const state = ctx.getState();
    const registry = await loadSourcesRegistry(ctx.platform, state);
    const existing = p.rows(registry)?.find((s) => p.idOf(s) === file.id);
    if (format === 'table') {
      const archived = state.decks.get(cloudFileDeckId(p.prefix, file.id, existing?.deckId));
      if (archived?.archived) {
        throw new Error(
          `The deck "${archived.name}" from this file is archived. Restore it in the Library first.`,
        );
      }
    }
    let source = existing;
    if (!source) {
      source = p.newRow(file, options);
      p.setRows(registry, [...(p.rows(registry) ?? []), source]);
    }
    p.beforeLink?.(registry, source, file);
    if (options?.columnMap) source.columnMap = [...options.columnMap];
    try {
      const res = await refreshCloudFile(p, source, ctx, {
        force: true,
        ...(options?.columnMap ? { columnMap: options.columnMap } : {}),
      });
      if (res.unreadable || source.lastStatus === 'permission_required') {
        throw new Error(source.lastError ?? 'This file cannot be read here.');
      }
      await saveSourcesRegistry(ctx.platform, registry);
      return {
        source,
        registry,
        notesTouched: res.notesTouched,
        ...(res.pending ? { pending: res.pending } : {}),
      };
    } catch (err) {
      recordFailedLink(p, registry, source, err, Boolean(options?.columnMap));
      await saveSourcesRegistry(ctx.platform, registry);
      throw err;
    }
  });
}

/** What linking a file returns. */
export interface CloudFileLinkResult<S> {
  source: S;
  registry: SourcesRegistry;
  notesTouched: number;
  pending?: PendingXlsxReconciliation;
}

export type CloudFileRefreshTally = Pick<
  SourceRefreshSummary,
  | 'updatedSources'
  | 'importedNotes'
  | 'warningsCount'
  | 'pendingReconciliations'
  | 'errors'
  | 'skipped'
>;

/** One provider's part of `refreshAllSources`: one row's failure never stops the others. */
export async function refreshCloudFiles<
  S extends CloudFileRow,
  I extends CloudFileInfo,
  C,
  F extends { id: string; name: string },
>(
  p: CloudFileProvider<S, I, C, F>,
  sources: readonly S[],
  ctx: SourceRunContext,
  force: boolean | undefined,
): Promise<CloudFileRefreshTally> {
  const tally: CloudFileRefreshTally = {
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
      // One file at a time on purpose: each pull may download up to 50 MB (one buffer at a time
      // on a phone), and the providers throttle bursts of requests from one app.
      const res = await refreshCloudFile(p, src, ctx, refreshOpts); // NOSONAR (S9382)
      if (res.pending) tally.pendingReconciliations.push(res.pending);
      if (res.updated) tally.updatedSources += 1;
      tally.importedNotes += res.notesTouched;
      tally.warningsCount += res.warnings.length;
      if (src.skipReason || src.lastStatus === 'permission_required') {
        tally.skipped.push(`${src.name}: ${src.lastError ?? 'not refreshed'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      src.lastStatus = 'error';
      src.lastError = msg;
      tally.errors.push(`${src.name}: ${msg}`);
    }
  }
  return tally;
}

export type CloudFileRowOutcome =
  | { kind: 'pending'; pending: PendingXlsxReconciliation; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; message: string; updated: boolean };

/** What a finished single refresh means for the user (shared by Refresh and reconciliation). */
function describeRefresh(source: CloudFileRow, res: CloudFileRefreshResult): CloudFileRowOutcome {
  if (res.pending) {
    return {
      kind: 'pending',
      pending: res.pending,
      message: `"${source.name}" has rows that may be renamed. Match them below to keep review history.`,
    };
  }
  if (source.lastStatus === 'offline') {
    return { kind: 'error', message: 'You are offline. Try again when you are back online.' };
  }
  if (source.lastError) return { kind: 'error', message: source.lastError };
  return {
    kind: 'ok',
    updated: res.updated,
    message: res.updated
      ? `Refreshed "${source.name}" (${res.notesTouched} note change(s)).`
      : `"${source.name}" is already up to date.`,
  };
}

/** The panel's Refresh button for one row: refresh, save, and say what happened. */
export async function refreshCloudFileRow<
  S extends CloudFileRow,
  I extends CloudFileInfo,
  C,
  F extends { id: string; name: string },
>(
  p: CloudFileProvider<S, I, C, F>,
  id: string,
  ctx: SourceRunContext,
  opts?: Pick<CloudFileRefreshOptions, 'renameMap'>,
): Promise<{ registry: SourcesRegistry; outcome: CloudFileRowOutcome } | null> {
  return withSourcesLock(async () => {
    const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
    const target = p.rows(registry)?.find((s) => s.id === id);
    if (!target) return null;
    let outcome: CloudFileRowOutcome;
    try {
      const res = await refreshCloudFile(p, target, ctx, { force: true, ...opts });
      outcome = describeRefresh(target, res);
    } catch (err) {
      target.lastStatus = 'error';
      target.lastError = err instanceof Error ? err.message : String(err);
      outcome = { kind: 'error', message: target.lastError };
    }
    await saveSourcesRegistry(ctx.platform, registry);
    return { registry, outcome };
  });
}

/**
 * Applies a held pull with the user's matches. `applied` is false when nothing landed (offline,
 * no access, archived deck): the prompt should stay. `null` when the row is gone.
 */
export async function applyCloudFileReconciliation<
  S extends CloudFileRow,
  I extends CloudFileInfo,
  C,
  F extends { id: string; name: string },
>(
  p: CloudFileProvider<S, I, C, F>,
  rec: PendingXlsxReconciliation,
  renameMap: Record<string, string>,
  ctx: SourceRunContext,
): Promise<{ registry: SourcesRegistry; applied: boolean; message: string } | null> {
  const fileId = rec.folderId.slice(p.prefix.length);
  const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
  const row = p.rows(registry)?.find((s) => p.idOf(s) === fileId);
  if (!row) return null;
  const res = await refreshCloudFileRow(p, row.id, ctx, { renameMap });
  if (!res) return null;
  const { outcome } = res;
  if (outcome.kind !== 'ok') {
    return { registry: res.registry, applied: false, message: outcome.message };
  }
  return {
    registry: res.registry,
    applied: true,
    message: outcome.updated
      ? `Applied the ${p.label} changes to "${rec.deckName}".`
      : `"${rec.deckName}" is already up to date.`,
  };
}
