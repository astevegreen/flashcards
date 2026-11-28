import { isSyncTransportError, type KnownEvent } from '@flash/core';
import { importFlashpkg } from '@flash/core/flashpkg';
import type {
  GoogleDriveFileInfo,
  GooglePickedFile,
  GoogleSourcesClient,
  LinkedGoogleDriveFileSource,
  PendingXlsxReconciliation,
  PickedFile,
  PlatformServices,
  SourcesRegistry,
} from '@flash/platform';
import {
  applyCloudFileReconciliation,
  linkCloudFile,
  markCloudFileSynced,
  markPermissionRequired,
  readCloudTable,
  refreshCloudFile,
  refreshCloudFileRow,
  refreshCloudFiles,
  skipIfArchived,
  type CloudFileLinkOptions,
  type CloudFileLinkResult,
  type CloudFileProvider,
  type CloudFilePullReady,
  type CloudFileRefreshOptions,
  type CloudFileRefreshResult,
  type CloudFileRefreshTally,
  type CloudFileRowOutcome,
} from './cloudFileSource.ts';
import { deckLimitReason, newDeckIds } from './deckLimit.ts';
import {
  archivePreviewRequest,
  throwIfArchiveHeld,
  type SourceRunContext,
} from './sourcesRegistry.ts';
import { putMediaListTracked } from '../state/recentMedia.ts';

/**
 * Linked Google Drive FILES (§3.1): plain `.csv` / `.tsv` / `.xlsx` / `.flashpkg` files the user
 * picked with Google Picker. Runs on the shared cloud-file runner (`cloudFileSource.ts`):
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
  return readCloudTable(platform, { ...picked, name: tableFileName(picked) });
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

/** A Drive file, Sheet or Doc row while Google is disconnected. */
export const GOOGLE_RECONNECT_MESSAGE = 'Connect Google to refresh this file.';
const RECONNECT_MESSAGE = GOOGLE_RECONNECT_MESSAGE;

function lostAccessMessage(name: string): string {
  return `This app can no longer open "${name}" in Google Drive. Pick it again with Link from Google Drive to restore access.`;
}

function notFoundMessage(name: string): string {
  return `"${name}" was not found in Google Drive (it was deleted, or access was removed). Pick it again with Link from Google Drive, or unlink it.`;
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

/**
 * Re-imports a linked `.flashpkg` like a subscribed package. The free-tier deck limit is checked
 * against every new deck the package adds before any media is stored or event emitted.
 */
async function pullDrivePackage(
  source: LinkedGoogleDriveFileSource,
  ctx: SourceRunContext,
  ready: CloudFilePullReady<GoogleDriveFileInfo, DriveFilesClient>,
): Promise<CloudFileRefreshResult> {
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
  await throwIfArchiveHeld(
    ctx,
    archivePreviewRequest(pkgRes.manifest.name, pkgRes.notesArchived, picked.name),
  );
  await putMediaListTracked(ctx.platform.storage, pkgRes.extractedMedia);
  if (pkgRes.events.length > 0) ctx.emitEvents(pkgRes.events);

  const deckId = firstImportedDeckId(pkgRes.events);
  if (deckId) source.deckId = deckId;
  source.name = pkgRes.manifest.name;
  source.packageId = pkgRes.manifest.package_id;
  source.version = pkgRes.manifest.version;
  if (uri) source.uri = uri;
  if (info.contentTag) source.contentTag = info.contentTag;
  markCloudFileSynced(source, nowMs);
  source.warnings = pkgRes.warnings.map((w) => ({ code: w.code, message: w.message }));
  return { updated: true, notesTouched: pkgRes.notesImported, warnings: source.warnings };
}

type DriveLinkFile = { id: string; name: string; mimeType?: string; url?: string };

/**
 * Linked Drive files on the shared cloud-file runner. Differences from OneDrive and Dropbox: the
 * Google sign-in is checked first, a trashed file is an error, lost sign-in or file access marks
 * the row `permission_required` (a deleted file throws a clear error), a name without an
 * extension is read by its MIME type, and `.flashpkg` rows re-import as packages.
 */
export const GOOGLE_DRIVE_FILES: CloudFileProvider<
  LinkedGoogleDriveFileSource,
  GoogleDriveFileInfo,
  DriveFilesClient,
  DriveLinkFile
> = {
  kind: SOURCE_KIND,
  prefix: GDRIVE_RECONCILE_PREFIX,
  label: 'Google Drive',
  idOf: (s) => s.fileId,
  rows: (r) => r.googleDriveFiles,
  setRows: (r, rows) => {
    r.googleDriveFiles = rows;
  },
  checkLinkable(file) {
    const kind = classifyGoogleDriveFile(file.name, file.mimeType ?? '');
    if (kind === 'table') return 'table';
    if (kind === 'flashpkg') return 'package';
    throw new Error(`"${file.name}" is not a .csv, .tsv, .xlsx or .flashpkg file.`);
  },
  newRow: (file, options) => ({
    id: `${GDRIVE_RECONCILE_PREFIX}${file.id}`,
    fileId: file.id,
    name: displayName(file.name),
    format: PACKAGE_EXTENSION.test(file.name) ? 'flashpkg' : 'table',
    ...(file.url ? { uri: file.url } : {}),
    ...(options?.noteTypeId !== undefined ? { noteTypeId: options.noteTypeId } : {}),
    ...(options?.language !== undefined ? { language: options.language } : {}),
    lastStatus: 'idle',
  }),
  async open(ctx, source) {
    if (!ctx.platform.googleOAuthConfigured) {
      throw new Error('Google is not configured in this build.');
    }
    const connected = await ctx.platform
      .getGoogleAuth()
      .then((auth) => auth.isConnected())
      .catch(() => false);
    if (!connected) {
      markPermissionRequired(source, RECONNECT_MESSAGE);
      return null;
    }
    return getDriveFilesClient(ctx.platform);
  },
  async getInfo(client, source) {
    const info = await client.getDriveFileInfo(source.fileId);
    if (info.trashed) {
      throw new Error(
        `"${info.name}" is in the Google Drive trash. Restore it there, or unlink it.`,
      );
    }
    return info;
  },
  download: (client, source) => client.downloadDriveFile(source.fileId),
  uriOf: (info, source) => info.webViewLink ?? source.uri,
  setUri: (source, uri) => {
    source.uri = uri;
  },
  isXlsx: isXlsxFile,
  readTable: readGoogleDriveTable,
  isPackage: (source) => source.format === 'flashpkg',
  pullPackage: pullDrivePackage,
  onAccessError(source, err) {
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
  },
};

/**
 * Links one picked Drive file and runs the first pull. A table takes the mapping chosen in the
 * column-mapping step; a `.flashpkg` imports its decks.
 */
export function linkGoogleDriveFile(
  file: DriveLinkFile,
  ctx: SourceRunContext,
  options?: CloudFileLinkOptions,
): Promise<CloudFileLinkResult<LinkedGoogleDriveFileSource>> {
  return linkCloudFile(GOOGLE_DRIVE_FILES, file, ctx, options);
}

/** Refreshes one linked Drive file (see `refreshCloudFile`). */
export function refreshSingleGoogleDriveFileSource(
  source: LinkedGoogleDriveFileSource,
  ctx: SourceRunContext,
  opts?: CloudFileRefreshOptions,
): Promise<CloudFileRefreshResult> {
  return refreshCloudFile(GOOGLE_DRIVE_FILES, source, ctx, opts);
}

/** The Drive-file part of `refreshAllSources`. */
export function refreshLinkedGoogleDriveFiles(
  sources: readonly LinkedGoogleDriveFileSource[],
  ctx: SourceRunContext,
  force: boolean | undefined,
): Promise<CloudFileRefreshTally> {
  return refreshCloudFiles(GOOGLE_DRIVE_FILES, sources, ctx, force);
}

/**
 * "Refresh all" while Google is disconnected: each Drive file row says why it was not refreshed,
 * like any other skip, and returns the `name: why` lines for the summary. A row whose deck is
 * archived keeps saying so (as a refresh would, before checking access). A build without Google
 * marks nothing: its user could not act on "Connect Google".
 */
export function markGoogleDriveFilesDisconnected(
  sources: readonly LinkedGoogleDriveFileSource[],
  ctx: SourceRunContext,
): string[] {
  if (!ctx.platform.googleOAuthConfigured) return [];
  const state = ctx.getState();
  return sources.map((src) => {
    if (!skipIfArchived(GOOGLE_DRIVE_FILES, src, state)) {
      markPermissionRequired(src, RECONNECT_MESSAGE);
    }
    return `${src.name}: ${src.lastError ?? RECONNECT_MESSAGE}`;
  });
}

/** The panel's Refresh button for one Drive file row: refresh, save, and say what happened. */
export function refreshGoogleDriveFileRow(
  id: string,
  ctx: SourceRunContext,
  opts?: Pick<CloudFileRefreshOptions, 'renameMap'>,
): Promise<{ registry: SourcesRegistry; outcome: CloudFileRowOutcome } | null> {
  return refreshCloudFileRow(GOOGLE_DRIVE_FILES, id, ctx, opts);
}

/** Applies a held Drive pull with the user's matches (see `applyCloudFileReconciliation`). */
export function applyGoogleDriveReconciliation(
  rec: PendingXlsxReconciliation,
  renameMap: Record<string, string>,
  ctx: SourceRunContext,
): Promise<{ registry: SourcesRegistry; applied: boolean; message: string } | null> {
  return applyCloudFileReconciliation(GOOGLE_DRIVE_FILES, rec, renameMap, ctx);
}
