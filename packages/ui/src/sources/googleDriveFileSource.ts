import {
  BUILTIN_NOTE_TYPE_IDS,
  FLASH_NAMESPACE_UUID,
  isSyncTransportError,
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
import { importFlashpkg } from '@flash/core/flashpkg';
import { diffTabularSource, inferPresetNoteTypeId, sha256Hex } from '@flash/core/sources';
import type {
  GoogleDriveFileInfo,
  GooglePickedFile,
  GoogleSourcesClient,
  LinkedGoogleDriveFileSource,
  PendingXlsxReconciliation,
  PickedFile,
  PlatformServices,
  SourcesRegistry,
  SourceWarning,
} from '@flash/platform';
import {
  archivedDeckRefreshMessage,
  canReadExcel,
  excelUnreadableMessage,
  isOnline,
  loadSourcesRegistry,
  readOneDriveTable,
  resolveNoteType,
  saveSourcesRegistry,
  type SourceRefreshSummary,
  type SourceRunContext,
  withSourcesLock,
} from './sourceRunner.ts';
import { deckLimitReason, newDeckIds } from './deckLimit.ts';
import { putMediaTracked } from '../state/recentMedia.ts';

/**
 * Linked Google Drive FILES (§3.1): plain `.csv` / `.tsv` / `.xlsx` / `.flashpkg` files the user
 * picked with Google Picker. Mirrors the linked OneDrive file design (`refreshSingleOneDriveSource`):
 * a cheap metadata call compares the content tag (`md5Checksum`), the file is downloaded only
 * when it changed, rows are matched by their first field (the app never writes to the file), and
 * a likely rename holds the pull for the same reconciliation prompt. A `.flashpkg` is re-imported
 * like a subscribed package. Access stays `drive.file`: only files the user picked are reachable.
 */

const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const SOURCE_KIND = 'google_drive_file' as const;

/** Prefix of `PendingXlsxReconciliation.folderId` for a linked Drive file (then the file id). */
export const GDRIVE_RECONCILE_PREFIX = 'gdrive:';

const TABLE_EXTENSION = /\.(csv|tsv|xlsx)$/i;
const PACKAGE_EXTENSION = /\.flashpkg$/i;

/** Extension to read a table as when its name has none (Drive keeps the uploader's MIME type). */
const TABLE_EXT_BY_MIME: Readonly<Record<string, string>> = {
  'text/csv': '.csv',
  'application/vnd.ms-excel': '.csv',
  'text/tab-separated-values': '.tsv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

export type GoogleDriveFileFormat = LinkedGoogleDriveFileSource['format'];

/** What a picked Drive item is: a Sheet/Doc (linked the old way), a plain file, or neither. */
export function classifyGoogleDriveFile(
  name: string,
  mimeType: string,
): 'sheet' | 'doc' | GoogleDriveFileFormat | null {
  if (mimeType === GOOGLE_SHEET_MIME) return 'sheet';
  if (mimeType === GOOGLE_DOC_MIME) return 'doc';
  if (mimeType.startsWith('application/vnd.google-apps.')) return null;
  if (TABLE_EXTENSION.test(name)) return 'table';
  if (PACKAGE_EXTENSION.test(name)) return 'flashpkg';
  // `.xls` is old binary Excel that the reader can't open, even when the MIME type says Excel.
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return null;
  return TABLE_EXT_BY_MIME[mimeType] ? 'table' : null;
}

export interface PickedDriveFile {
  id: string;
  name: string;
  mimeType: string;
  format: GoogleDriveFileFormat;
  url?: string;
}

/** Splits a Picker result: Sheets/Docs go through the Sheets/Docs path, files through this one. */
export function splitPickedGoogleFiles(picked: readonly GooglePickedFile[]): {
  workspace: GooglePickedFile[];
  files: PickedDriveFile[];
  rejected: string[];
} {
  const workspace: GooglePickedFile[] = [];
  const files: PickedDriveFile[] = [];
  const rejected: string[] = [];
  for (const file of picked) {
    const kind = classifyGoogleDriveFile(file.name, file.mimeType);
    if (kind === 'sheet' || kind === 'doc') workspace.push(file);
    else if (kind) {
      files.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        format: kind,
        ...(file.url !== undefined ? { url: file.url } : {}),
      });
    } else rejected.push(file.name);
  }
  return { workspace, files, rejected };
}

/** Message for picked items that are neither Sheets/Docs nor supported files. */
export function rejectedDriveFilesMessage(names: readonly string[]): string {
  return `Not linked (only Google Sheets, Google Docs, and .csv, .tsv, .xlsx or .flashpkg files can be linked): ${names.join(', ')}.`;
}

function displayName(fileName: string): string {
  return fileName.replace(TABLE_EXTENSION, '').replace(PACKAGE_EXTENSION, '') || fileName;
}

/** The name to parse a downloaded table as: its own extension, else one from its MIME type. */
function tableFileName(picked: Pick<PickedFile, 'name' | 'mime'>): string {
  if (TABLE_EXTENSION.test(picked.name)) return picked.name;
  const ext = picked.mime ? TABLE_EXT_BY_MIME[picked.mime] : undefined;
  return ext ? `${picked.name}${ext}` : picked.name;
}

function isXlsxFile(info: Pick<GoogleDriveFileInfo, 'name' | 'mimeType'>): boolean {
  return tableFileName({ name: info.name, mime: info.mimeType }).toLowerCase().endsWith('.xlsx');
}

/** Reads a downloaded Drive `.csv` / `.tsv` / `.xlsx` into a grid whose first row is the headers. */
export async function readGoogleDriveTable(
  platform: PlatformServices,
  picked: PickedFile,
): Promise<string[][]> {
  return readOneDriveTable(platform, { ...picked, name: tableFileName(picked) });
}

type DriveFilesClient = GoogleSourcesClient &
  Required<Pick<GoogleSourcesClient, 'getDriveFileInfo' | 'downloadDriveFile'>>;

async function getDriveFilesClient(platform: PlatformServices): Promise<DriveFilesClient> {
  const client = await platform.getGoogleSourcesClient();
  if (!client.getDriveFileInfo || !client.downloadDriveFile) {
    throw new Error('Google Drive files are not available in this build.');
  }
  return client as DriveFilesClient;
}

/** Downloads a picked Drive file (for the column-mapping step before linking). */
export async function downloadGoogleDriveFile(
  platform: PlatformServices,
  fileId: string,
): Promise<PickedFile> {
  return (await getDriveFilesClient(platform)).downloadDriveFile(fileId);
}

function driveDeckId(source: Pick<LinkedGoogleDriveFileSource, 'fileId' | 'deckId'>): string {
  return source.deckId ?? uuidv5(FLASH_NAMESPACE_UUID, `gdrive:${source.fileId}`);
}

function carriesDriveFile(source: SourceRef | undefined, fileId: string): boolean {
  return source?.kind === SOURCE_KIND && source.external_id === fileId;
}

/**
 * The active deck a Drive file fills, if any (its note type then can't change). Archived decks
 * don't count, like {@link linkedOneDriveDeck}.
 */
export function linkedGoogleDriveDeck(state: CollectionState, fileId: string): Deck | undefined {
  for (const deck of state.decks.values()) {
    if (!deck.archived && carriesDriveFile(deck.source, fileId)) return deck;
  }
  return undefined;
}

/** Adds Drive files linked on another device (their decks synced here) to this registry. */
export function mergeSyncedGoogleDriveFiles(
  registry: SourcesRegistry,
  state: CollectionState,
): void {
  const known = new Set((registry.googleDriveFiles ?? []).map((s) => s.fileId));
  for (const deck of state.decks.values()) {
    const src = deck.source;
    if (deck.archived || src?.kind !== SOURCE_KIND || !src.external_id) continue;
    if (known.has(src.external_id)) continue;
    known.add(src.external_id);
    const isPackage = src.package_id !== undefined;
    registry.googleDriveFiles ??= [];
    registry.googleDriveFiles.push({
      id: `gdrive:${src.external_id}`,
      fileId: src.external_id,
      name: deck.name,
      format: isPackage ? 'flashpkg' : 'table',
      ...(src.uri !== undefined ? { uri: src.uri } : {}),
      deckId: deck.id,
      ...(isPackage ? {} : { noteTypeId: deck.note_type_id, language: deck.language }),
      ...(src.package_id !== undefined ? { packageId: src.package_id } : {}),
      ...(src.package_version !== undefined ? { version: src.package_version } : {}),
      ...(src.last_synced_at !== undefined ? { lastSyncedAt: src.last_synced_at } : {}),
      lastStatus: 'idle',
    });
  }
}

/** Drops rows whose deck no longer carries the file: it was unlinked, maybe on another device. */
export function dropGoogleDriveFilesUnlinkedElsewhere(
  registry: SourcesRegistry,
  state: CollectionState,
): void {
  if (!registry.googleDriveFiles) return;
  registry.googleDriveFiles = registry.googleDriveFiles.filter((s) => {
    const deck = s.deckId ? state.decks.get(s.deckId) : undefined;
    return !deck || carriesDriveFile(deck.source, s.fileId);
  });
}

/** Matcher for the synced decks a registry row stands for (Unlink emits `SourceUnlinked`). */
export function googleDriveFileMatcher(
  registry: SourcesRegistry,
  id: string,
): ((source: SourceRef) => boolean) | null {
  const row = registry.googleDriveFiles?.find((s) => s.id === id);
  return row ? (src) => carriesDriveFile(src, row.fileId) : null;
}

interface DriveLinkOptions {
  noteTypeId?: string;
  language?: string;
  columnMap?: SourceColumnMapping[];
}

interface DriveRefreshOptions {
  force?: boolean;
  columnMap?: SourceColumnMapping[];
  /** existing note id -> new first-field value, from the reconciliation prompt. */
  renameMap?: Readonly<Record<string, string>>;
}

export interface GoogleDriveRefreshResult {
  updated: boolean;
  notesTouched: number;
  warnings: SourceWarning[];
  pending?: PendingXlsxReconciliation;
  /** An `.xlsx` this device cannot read: nothing was downloaded or changed. */
  unreadable?: true;
}

function addDriveSource(
  registry: SourcesRegistry,
  file: { id: string; name: string; format: GoogleDriveFileFormat; url?: string },
  options: DriveLinkOptions | undefined,
): LinkedGoogleDriveFileSource {
  const source: LinkedGoogleDriveFileSource = {
    id: `gdrive:${file.id}`,
    fileId: file.id,
    name: displayName(file.name),
    format: file.format,
    ...(file.url ? { uri: file.url } : {}),
    ...(options?.noteTypeId !== undefined ? { noteTypeId: options.noteTypeId } : {}),
    ...(options?.language !== undefined ? { language: options.language } : {}),
    lastStatus: 'idle',
  };
  registry.googleDriveFiles ??= [];
  registry.googleDriveFiles.push(source);
  return source;
}

/**
 * Links one picked Drive file and runs the first pull. A table takes the mapping chosen in the
 * column-mapping step; a `.flashpkg` imports its decks. When the first pull fails, nothing is
 * kept. When it finds likely renamed rows, nothing is applied and `pending` asks the user.
 */
export async function linkGoogleDriveFile(
  file: { id: string; name: string; mimeType?: string; url?: string },
  ctx: SourceRunContext,
  options?: DriveLinkOptions,
): Promise<{
  source: LinkedGoogleDriveFileSource;
  registry: SourcesRegistry;
  notesTouched: number;
  pending?: PendingXlsxReconciliation;
}> {
  return withSourcesLock(async () => {
    const kind = classifyGoogleDriveFile(file.name, file.mimeType ?? '');
    if (kind !== 'table' && kind !== 'flashpkg') {
      throw new Error(`"${file.name}" is not a .csv, .tsv, .xlsx or .flashpkg file.`);
    }
    const state = ctx.getState();
    const registry = await loadSourcesRegistry(ctx.platform, state);
    const existing = registry.googleDriveFiles?.find((s) => s.fileId === file.id);
    if (kind === 'table') {
      const archived = state.decks.get(driveDeckId(existing ?? { fileId: file.id }));
      if (archived?.archived) {
        throw new Error(
          `The deck "${archived.name}" from this file is archived. Restore it in the Library first.`,
        );
      }
    }
    const source =
      existing ??
      addDriveSource(
        registry,
        { id: file.id, name: file.name, format: kind, ...(file.url ? { url: file.url } : {}) },
        options,
      );
    if (options?.columnMap) source.columnMap = [...options.columnMap];
    try {
      const res = await refreshSingleGoogleDriveFileSource(source, ctx, {
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
      if (!source.deckId) {
        registry.googleDriveFiles = (registry.googleDriveFiles ?? []).filter((s) => s !== source);
      } else {
        source.lastStatus = 'error';
        source.lastError = err instanceof Error ? err.message : String(err);
        if (options?.columnMap) source.columnMapUnsaved = true;
      }
      await saveSourcesRegistry(ctx.platform, registry);
      throw err;
    }
  });
}

function markSkipped(
  source: LinkedGoogleDriveFileSource,
  reason: NonNullable<LinkedGoogleDriveFileSource['skipReason']>,
  message: string,
): void {
  source.lastStatus = 'idle';
  source.lastError = message;
  source.skipReason = reason;
}

function markSynced(source: LinkedGoogleDriveFileSource, nowMs: number): void {
  source.lastSyncedAt = nowMs;
  source.lastStatus = 'synced';
  delete source.lastError;
  delete source.skipReason;
}

function markPermissionRequired(source: LinkedGoogleDriveFileSource, message: string): void {
  source.lastStatus = 'permission_required';
  source.lastError = message;
}

const RECONNECT_MESSAGE = 'Connect Google to refresh this file.';

function lostAccessMessage(name: string): string {
  return `This app can no longer open "${name}" in Google Drive. Pick it again with Link from Google Drive to restore access.`;
}

function notFoundMessage(name: string): string {
  return `"${name}" was not found in Google Drive (it was deleted, or access was removed). Pick it again with Link from Google Drive, or unlink it.`;
}

/**
 * Turns Drive access failures into the row's state: a lost sign-in or lost file access asks the
 * user to reconnect / pick again (returns true); a missing file becomes a clear error (throws).
 */
function handleDriveAccessError(source: LinkedGoogleDriveFileSource, err: unknown): boolean {
  if (!isSyncTransportError(err)) return false;
  if (err.code === 'AUTH_REQUIRED') {
    markPermissionRequired(source, RECONNECT_MESSAGE);
    return true;
  }
  if (err.code === 'PERMISSION_DENIED') {
    markPermissionRequired(source, lostAccessMessage(source.name));
    return true;
  }
  if (err.code === 'NOT_FOUND') throw new Error(notFoundMessage(source.name));
  return false;
}

/**
 * Everything a refresh decides before downloading: an archived deck, offline, no Google
 * sign-in, an unchanged content tag, or an `.xlsx` this device can't read end it with `result`.
 */
async function prepareDrivePull(
  source: LinkedGoogleDriveFileSource,
  ctx: SourceRunContext,
  opts: DriveRefreshOptions | undefined,
): Promise<
  | { result: GoogleDriveRefreshResult }
  | { client: DriveFilesClient; info: GoogleDriveFileInfo; nowMs: number }
> {
  const unchanged = { updated: false, notesTouched: 0, warnings: source.warnings ?? [] };
  if (source.format === 'table') {
    const deck = ctx.getState().decks.get(driveDeckId(source));
    if (deck?.archived) {
      markSkipped(source, 'archived', archivedDeckRefreshMessage(deck.name));
      return { result: unchanged };
    }
  }
  if (!isOnline()) {
    source.lastStatus = 'offline';
    return { result: unchanged };
  }
  if (!ctx.platform.googleOAuthConfigured) {
    throw new Error('Google is not configured in this build.');
  }
  const connected = await ctx.platform
    .getGoogleAuth()
    .then((auth) => auth.isConnected())
    .catch(() => false);
  if (!connected) {
    markPermissionRequired(source, RECONNECT_MESSAGE);
    return { result: unchanged };
  }
  const client = await getDriveFilesClient(ctx.platform);
  const nowMs = Date.now();
  const info = await client.getDriveFileInfo(source.fileId);
  if (info.trashed) {
    throw new Error(`"${info.name}" is in the Google Drive trash. Restore it there, or unlink it.`);
  }
  const tagUnchanged =
    !opts?.force &&
    source.deckId &&
    source.contentTag &&
    !source.columnMapUnsaved &&
    info.contentTag === source.contentTag;
  if (tagUnchanged) {
    markSynced(source, nowMs);
    return { result: unchanged };
  }
  // Decide from the name before fetching up to 50 MB this device could not read anyway.
  if (source.format === 'table' && isXlsxFile(info) && !(await canReadExcel(ctx.platform))) {
    markSkipped(source, 'unreadable', excelUnreadableMessage(info.name));
    return { result: { ...unchanged, unreadable: true } };
  }
  return { client, info, nowMs };
}

/** The deck's note type and language, else the ones chosen when linking, else guessed. */
function resolveDeckShape(
  state: CollectionState,
  source: LinkedGoogleDriveFileSource,
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
function driveDeckEvent(
  factory: EventFactory,
  existingDeck: Deck | undefined,
  created: DeckCreatedPayload & { source: SourceRef },
  nowMs: number,
): KnownEvent | null {
  if (!existingDeck) return factory.create('DeckCreated', created, nowMs);
  const prev = existingDeck.source;
  const next = created.source;
  const sameRef =
    prev?.kind === SOURCE_KIND &&
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

function toSourceWarnings(
  warnings: ReturnType<typeof diffTabularSource>['warnings'],
): SourceWarning[] {
  return warnings.map((w) => ({
    code: w.code,
    message: w.message,
    ...(w.row !== undefined ? { row: w.row } : {}),
    ...(w.header !== undefined ? { header: w.header } : {}),
  }));
}

async function pullDriveTable(
  source: LinkedGoogleDriveFileSource,
  ctx: SourceRunContext,
  opts: DriveRefreshOptions | undefined,
  ready: { client: DriveFilesClient; info: GoogleDriveFileInfo; nowMs: number },
): Promise<GoogleDriveRefreshResult> {
  const { client, info, nowMs } = ready;
  const picked = await client.downloadDriveFile(source.fileId);
  const grid = await readGoogleDriveTable(ctx.platform, picked);

  const state = ctx.getState();
  const factory = ctx.getEventFactory();
  const deckId = driveDeckId(source);
  const existingDeck = state.decks.get(deckId);
  const { noteType, language } = resolveDeckShape(state, source, existingDeck, grid[0]);
  // A mapping chosen now, else one chosen here not yet on the deck, else the deck's, else linked.
  const columnMap =
    opts?.columnMap ??
    (source.columnMapUnsaved ? source.columnMap : undefined) ??
    existingDeck?.source?.column_map ??
    source.columnMap;

  // Read-only, so rows are matched by their first field (like a linked OneDrive file).
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
    // Applying a likely rename now would archive the old note and its review history. The
    // content tag stays old, so the next refresh asks again.
    if (opts?.columnMap) {
      source.columnMap = [...opts.columnMap];
      source.columnMapUnsaved = true;
    }
    return {
      updated: false,
      notesTouched: 0,
      warnings: source.warnings ?? [],
      pending: {
        folderId: `${GDRIVE_RECONCILE_PREFIX}${source.fileId}`,
        relativePath: picked.name,
        deckId,
        deckName: existingDeck.name,
        missingNotes: diff.reconciliationCandidates.missingNotes,
        addedRows: diff.reconciliationCandidates.addedRows,
      },
    };
  }

  const uri = info.webViewLink ?? source.uri;
  const sourceRef: SourceRef = {
    kind: SOURCE_KIND,
    ...(uri ? { uri } : {}),
    external_id: source.fileId,
    read_only: true,
    content_hash: sha256Hex(picked.bytes),
    last_synced_at: nowMs,
    ...(columnMap ? { column_map: [...columnMap] } : {}),
  };
  const deckEvent = driveDeckEvent(
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
  const events: KnownEvent[] = deckEvent ? [deckEvent, ...diff.events] : [...diff.events];
  if (events.length > 0) ctx.emitEvents(events);

  source.deckId = deckId;
  source.noteTypeId = noteType.id;
  source.language = language;
  if (columnMap) source.columnMap = [...columnMap];
  delete source.columnMapUnsaved;
  if (uri) source.uri = uri;
  if (info.contentTag) source.contentTag = info.contentTag;
  markSynced(source, nowMs);
  source.warnings = toSourceWarnings(diff.warnings);

  const notesTouched =
    diff.stats.added + diff.stats.updated + diff.stats.archived + diff.stats.restored;
  return { updated: !existingDeck || notesTouched > 0, notesTouched, warnings: source.warnings };
}

/** The first deck a package import created or relinked (the row's anchor for unlink checks). */
function firstImportedDeckId(events: readonly KnownEvent[]): string | undefined {
  for (const ev of events) {
    if (ev.type === 'DeckCreated') return ev.payload.deck_id;
    if (ev.type === 'SourceLinked' && ev.payload.target_kind === 'deck') {
      return ev.payload.target_id;
    }
  }
  return undefined;
}

async function pullDrivePackage(
  source: LinkedGoogleDriveFileSource,
  ctx: SourceRunContext,
  ready: { client: DriveFilesClient; info: GoogleDriveFileInfo; nowMs: number },
): Promise<GoogleDriveRefreshResult> {
  const { client, info, nowMs } = ready;
  const picked = await client.downloadDriveFile(source.fileId);
  const uri = info.webViewLink ?? source.uri;
  const state = ctx.getState();
  // importFlashpkg enforces the §13 zip limits (path traversal, file count, uncompressed bytes).
  const pkgRes = importFlashpkg(picked.bytes, state, ctx.getEventFactory(), {
    nowMs,
    sourceOverride: { kind: SOURCE_KIND, external_id: source.fileId, ...(uri ? { uri } : {}) },
    archiveRemovedOnUpgrade: true,
  });
  const overLimit = deckLimitReason(ctx.entitlement, state, newDeckIds(state, pkgRes.events));
  if (overLimit) throw new Error(overLimit);
  for (const media of pkgRes.extractedMedia) {
    await putMediaTracked(ctx.platform.storage, {
      hash: media.hash,
      mime: media.mime,
      bytes: media.bytes,
    });
  }
  if (pkgRes.events.length > 0) ctx.emitEvents(pkgRes.events);

  const deckId = firstImportedDeckId(pkgRes.events);
  if (deckId) source.deckId = deckId;
  source.name = pkgRes.manifest.name;
  source.packageId = pkgRes.manifest.package_id;
  source.version = pkgRes.manifest.version;
  if (uri) source.uri = uri;
  if (info.contentTag) source.contentTag = info.contentTag;
  markSynced(source, nowMs);
  source.warnings = pkgRes.warnings.map((w) => ({ code: w.code, message: w.message }));
  return { updated: true, notesTouched: pkgRes.notesImported, warnings: source.warnings };
}

/**
 * Refreshes one linked Drive file. The content tag is compared first; the file is downloaded and
 * applied only when it changed (or `force`). Lost sign-in or file access marks the row
 * `permission_required`; a deleted file throws a clear error.
 */
export async function refreshSingleGoogleDriveFileSource(
  source: LinkedGoogleDriveFileSource,
  ctx: SourceRunContext,
  opts?: DriveRefreshOptions,
): Promise<GoogleDriveRefreshResult> {
  const unchanged = { updated: false, notesTouched: 0, warnings: source.warnings ?? [] };
  try {
    const ready = await prepareDrivePull(source, ctx, opts);
    if ('result' in ready) return ready.result;
    return source.format === 'flashpkg'
      ? await pullDrivePackage(source, ctx, ready)
      : await pullDriveTable(source, ctx, opts, ready);
  } catch (err) {
    if (handleDriveAccessError(source, err)) return unchanged;
    throw err;
  }
}

export type GoogleDriveRefreshTally = Pick<
  SourceRefreshSummary,
  | 'updatedSources'
  | 'importedNotes'
  | 'warningsCount'
  | 'pendingReconciliations'
  | 'errors'
  | 'skipped'
>;

/** The Drive-file part of `refreshAllSources`: one row's failure never stops the others. */
export async function refreshLinkedGoogleDriveFiles(
  sources: readonly LinkedGoogleDriveFileSource[],
  ctx: SourceRunContext,
  force: boolean | undefined,
): Promise<GoogleDriveRefreshTally> {
  const tally: GoogleDriveRefreshTally = {
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
      // One file at a time on purpose: each pull may hold up to 50 MB in memory.
      const res = await refreshSingleGoogleDriveFileSource(src, ctx, refreshOpts); // NOSONAR (S9382)
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

export type DriveRowOutcome =
  | { kind: 'pending'; pending: PendingXlsxReconciliation; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; message: string };

/** What a finished single refresh means for the user (shared by Refresh and reconciliation). */
function describeRefresh(
  source: LinkedGoogleDriveFileSource,
  res: GoogleDriveRefreshResult,
): DriveRowOutcome {
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
    message: res.updated
      ? `Refreshed "${source.name}" (${res.notesTouched} note change(s)).`
      : `"${source.name}" is already up to date.`,
  };
}

/** The panel's Refresh button for one Drive file row: refresh, save, and say what happened. */
export async function refreshGoogleDriveFileRow(
  id: string,
  ctx: SourceRunContext,
  opts?: Pick<DriveRefreshOptions, 'renameMap'>,
): Promise<{ registry: SourcesRegistry; outcome: DriveRowOutcome } | null> {
  return withSourcesLock(async () => {
    const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
    const target = registry.googleDriveFiles?.find((s) => s.id === id);
    if (!target) return null;
    let outcome: DriveRowOutcome;
    try {
      const res = await refreshSingleGoogleDriveFileSource(target, ctx, { force: true, ...opts });
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
 * Applies a held Drive pull with the user's matches. `applied` is false when nothing landed
 * (offline, no access, archived deck): the prompt should stay.
 */
export async function applyGoogleDriveReconciliation(
  rec: PendingXlsxReconciliation,
  renameMap: Record<string, string>,
  ctx: SourceRunContext,
): Promise<{ registry: SourcesRegistry; applied: boolean; message: string } | null> {
  const fileId = rec.folderId.slice(GDRIVE_RECONCILE_PREFIX.length);
  const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
  const row = registry.googleDriveFiles?.find((s) => s.fileId === fileId);
  if (!row) return null;
  const res = await refreshGoogleDriveFileRow(row.id, ctx, { renameMap });
  if (!res) return null;
  const { outcome } = res;
  if (outcome.kind !== 'ok') {
    return { registry: res.registry, applied: false, message: outcome.message };
  }
  return {
    registry: res.registry,
    applied: true,
    message: outcome.message.startsWith('Refreshed')
      ? `Applied the Google Drive changes to "${rec.deckName}".`
      : `"${rec.deckName}" is already up to date.`,
  };
}
