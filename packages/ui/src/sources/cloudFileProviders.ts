import type {
  DropboxFileInfo,
  DropboxFilePicker,
  LinkedDropboxSource,
  LinkedOneDriveSource,
  OneDriveFileInfo,
  OneDriveFilePicker,
} from '@flash/platform';
import {
  assertTableFileName,
  linkCloudFile,
  markPermissionRequired,
  readCloudTable,
  refreshCloudFile,
  tableDisplayName,
  type CloudFileLinkOptions,
  type CloudFileLinkResult,
  type CloudFileProvider,
  type CloudFileRefreshOptions,
  type CloudFileRefreshResult,
} from './cloudFileSource.ts';
import type { SourceRunContext } from './sourcesRegistry.ts';

/** Prefix of `PendingXlsxReconciliation.folderId` for a linked OneDrive file (then the item id). */
export const ONEDRIVE_RECONCILE_PREFIX = 'onedrive:';
/** Prefix of `PendingXlsxReconciliation.folderId` for a linked Dropbox file (then the file id). */
export const DROPBOX_RECONCILE_PREFIX = 'dropbox:';

const isXlsxName = (info: { name: string }): boolean => info.name.toLowerCase().endsWith('.xlsx');

/**
 * Linked OneDrive files: the user's personal OneDrive, read-only `Files.Read` (asked for only by
 * the picker). The app never writes to the user's OneDrive.
 */
export const ONEDRIVE_FILES: CloudFileProvider<
  LinkedOneDriveSource,
  OneDriveFileInfo,
  OneDriveFilePicker
> = {
  kind: 'onedrive_file',
  prefix: ONEDRIVE_RECONCILE_PREFIX,
  label: 'OneDrive',
  idOf: (s) => s.itemId,
  rows: (r) => r.oneDriveSources,
  setRows: (r, rows) => {
    r.oneDriveSources = rows;
  },
  checkLinkable: (file) => assertTableFileName(file.name),
  newRow: (file, options) => ({
    id: `${ONEDRIVE_RECONCILE_PREFIX}${file.id}`,
    itemId: file.id,
    name: tableDisplayName(file.name),
    ...(options?.noteTypeId !== undefined ? { noteTypeId: options.noteTypeId } : {}),
    ...(options?.language !== undefined ? { language: options.language } : {}),
    lastStatus: 'idle',
  }),
  beforeLink(registry, _source, file) {
    // Linking again after an unlink is deliberate: stop hiding the file's synced deck.
    registry.unlinkedOneDriveIds = (registry.unlinkedOneDriveIds ?? []).filter(
      (id) => id !== file.id,
    );
  },
  async open(ctx, source) {
    if (!ctx.platform.getOneDrivePicker)
      throw new Error('OneDrive is not available in this build.');
    const picker = await ctx.platform.getOneDrivePicker();
    if (await picker.hasFileAccess()) return picker;
    markPermissionRequired(source, 'Allow OneDrive file access to refresh this source.');
    return null;
  },
  getInfo: (picker, source) => picker.getFileInfo(source.itemId),
  download: (picker, source) => picker.downloadById(source.itemId),
  uriOf: (info, source) => info.webUrl ?? source.uri,
  setUri: (source, uri) => {
    source.uri = uri;
  },
  isXlsx: isXlsxName,
  readTable: readCloudTable,
};

/**
 * Linked Dropbox files: the app's own `Dropbox › Apps › Flashcards` folder, with the same App
 * Folder sign-in as Dropbox sync. Read-only: the app never writes back to the user's spreadsheets.
 */
export const DROPBOX_FILES: CloudFileProvider<
  LinkedDropboxSource,
  DropboxFileInfo,
  DropboxFilePicker,
  { id: string; name: string; pathDisplay?: string }
> = {
  kind: 'dropbox_file',
  prefix: DROPBOX_RECONCILE_PREFIX,
  label: 'Dropbox',
  idOf: (s) => s.fileId,
  rows: (r) => r.dropboxSources,
  setRows: (r, rows) => {
    r.dropboxSources = rows;
  },
  checkLinkable: (file) => assertTableFileName(file.name),
  newRow: (file, options) => ({
    id: `${DROPBOX_RECONCILE_PREFIX}${file.id}`,
    fileId: file.id,
    name: tableDisplayName(file.name),
    ...(file.pathDisplay ? { pathDisplay: file.pathDisplay } : {}),
    ...(options?.noteTypeId !== undefined ? { noteTypeId: options.noteTypeId } : {}),
    ...(options?.language !== undefined ? { language: options.language } : {}),
    lastStatus: 'idle',
  }),
  beforeLink(_registry, source, file) {
    if (file.pathDisplay) source.pathDisplay = file.pathDisplay;
  },
  async open(ctx, source) {
    if (!ctx.platform.getDropboxPicker) throw new Error('Dropbox is not available in this build.');
    const picker = await ctx.platform.getDropboxPicker();
    if (await picker.isConnected()) return picker;
    markPermissionRequired(source, 'Connect Dropbox to refresh this source.');
    return null;
  },
  getInfo: (picker, source) => picker.getFileInfo(source.fileId),
  download: (picker, source, info) => picker.downloadById(source.fileId, info.size),
  uriOf: (info, source) => info.pathDisplay || source.pathDisplay,
  setUri: (source, uri) => {
    source.pathDisplay = uri;
  },
  isXlsx: isXlsxName,
  readTable: readCloudTable,
};

/**
 * Links one OneDrive `.csv` / `.tsv` / `.xlsx` file as a source and runs the first pull (see
 * `linkCloudFile`).
 */
export function linkOneDriveFile(
  file: { id: string; name: string },
  ctx: SourceRunContext,
  options?: CloudFileLinkOptions,
): Promise<CloudFileLinkResult<LinkedOneDriveSource>> {
  return linkCloudFile(ONEDRIVE_FILES, file, ctx, options);
}

/** Refreshes one linked OneDrive file (see `refreshCloudFile`). */
export function refreshSingleOneDriveSource(
  source: LinkedOneDriveSource,
  ctx: SourceRunContext,
  opts?: CloudFileRefreshOptions,
): Promise<CloudFileRefreshResult> {
  return refreshCloudFile(ONEDRIVE_FILES, source, ctx, opts);
}

/** Links one Dropbox App Folder `.csv` / `.tsv` / `.xlsx` file and runs the first pull. */
export function linkDropboxFile(
  file: { id: string; name: string; pathDisplay?: string },
  ctx: SourceRunContext,
  options?: CloudFileLinkOptions,
): Promise<CloudFileLinkResult<LinkedDropboxSource>> {
  return linkCloudFile(DROPBOX_FILES, file, ctx, options);
}

/** Refreshes one linked Dropbox file; Dropbox `content_hash`/`rev` is compared first. */
export function refreshSingleDropboxSource(
  source: LinkedDropboxSource,
  ctx: SourceRunContext,
  opts?: CloudFileRefreshOptions,
): Promise<CloudFileRefreshResult> {
  return refreshCloudFile(DROPBOX_FILES, source, ctx, opts);
}
