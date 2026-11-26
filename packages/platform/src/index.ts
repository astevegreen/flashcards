import type {
  CollectionStatePatch,
  FlashEvent,
  HlcState,
  SerializedCollectionState,
  SourceColumnMapping,
  SyncCursorState,
} from '@flash/core';
import type { StoredBackupInfo } from '@flash/core/backup';
import type {
  DictionaryBrowsePage,
  DictionaryBrowseQuery,
  DictionaryBrowseSummary,
  DictionaryDirection,
  DictionaryEntry,
  DictionaryPackId,
  PackCatalog,
  PackCatalogEntry,
  PackId,
  PackKind,
} from '@flash/core/dictionary';
import type {
  HandwritingCandidate,
  HandwritingRecognizeOptions,
  HanziStrokeData,
  InkPoint,
  InkStroke,
  StrokeScript,
} from '@flash/core/drawing';
import type { EntitlementState, LicenseVerifyResult } from '@flash/core/license';
import type { AnkiPackageReader } from './anki.ts';
import type { FsrsOptimizer } from './fsrs-optimizer.ts';

export type * from './anki.ts';
export type * from './fsrs-optimizer.ts';

export type {
  StoredBackupInfo,
  DictionaryBrowsePage,
  DictionaryBrowseQuery,
  DictionaryBrowseSummary,
  DictionaryDirection,
  DictionaryEntry,
  DictionaryPackId,
  EntitlementState,
  HandwritingCandidate,
  HandwritingRecognizeOptions,
  HanziStrokeData,
  InkPoint,
  InkStroke,
  LicenseVerifyResult,
  PackCatalog,
  PackCatalogEntry,
  PackId,
  PackKind,
  StrokeScript,
};

export interface DeviceMeta {
  deviceId: string;
  seq: number;
  hlc: HlcState;
  collectionId?: string;
  lastBackupAt?: number;
  backupReminderDismissedAt?: number;
  seeded?: boolean;
}

export interface MediaBlob {
  hash: string;
  mime: string;
  bytes: Uint8Array;
}

export type SyncProviderKind =
  'none' | 'dev_channel' | 'google_drive' | 'local_folder' | 'dropbox' | 'icloud' | 'onedrive';

export interface SyncConfig {
  provider: SyncProviderKind;
  connectedAt?: number;
  localFolderName?: string;
}

export interface LocalSnapshotRecord {
  snapshot: SerializedCollectionState;
  localSeq: number;
  savedAt: number;
}

export interface Storage {
  /** The IndexedDB database name (web only); the single-writer tab lock is named after it. */
  readonly dbName?: string;
  /** Closes the database for good: every later read or write, backups included, fails. */
  close?(): void;
  appendEvents(events: readonly FlashEvent[]): Promise<void>;
  /**
   * Stores local events and the device meta that counts them together (D11), so a session killed
   * in between can't leave the meta behind. Optional: without it callers append, then set the meta.
   */
  appendEventsWithMeta?(events: readonly FlashEvent[], meta: DeviceMeta): Promise<void>;
  getAllEvents(): Promise<FlashEvent[]>;
  getDeviceEventsAfterSeq(deviceId: string, afterSeq: number): Promise<FlashEvent[]>;
  getEventsAfterLocalSeq(
    afterLocalSeq: number,
  ): Promise<{ events: FlashEvent[]; maxLocalSeq: number }>;
  getMaxLocalSeq(): Promise<number>;
  getDeviceMeta(): Promise<DeviceMeta | undefined>;
  setDeviceMeta(meta: DeviceMeta): Promise<void>;
  getSyncCursor(): Promise<SyncCursorState | undefined>;
  setSyncCursor(cursor: SyncCursorState): Promise<void>;
  getSyncConfig(): Promise<SyncConfig | undefined>;
  setSyncConfig(config: SyncConfig): Promise<void>;
  getLocalSnapshot(): Promise<LocalSnapshotRecord | undefined>;
  setLocalSnapshot(record: LocalSnapshotRecord): Promise<void>;
  getKv<T = unknown>(key: string): Promise<T | undefined>;
  setKv(key: string, value: unknown): Promise<void>;
  deleteKv(key: string): Promise<void>;
  putMedia(media: MediaBlob): Promise<void>;
  getMedia(hash: string): Promise<MediaBlob | undefined>;
  listMediaHashes?(): Promise<string[]>;
  /** Deletes one stored media file (Check media's removal of unused files). */
  deleteMedia?(hash: string): Promise<void>;
  requestPersistence(): Promise<boolean>;
  /**
   * Rolling backups (`@flash/core/backup`). Optional: a storage without it takes no automatic
   * backups. `clearAll` keeps them, so a reset can be undone by restoring one.
   */
  openBackupStore?(): Promise<BackupStore>;
  clearAll(): Promise<void>;
}

/** Rolling backups kept apart from the key-value store, so listing never loads an archive. */
export interface BackupStore {
  /**
   * True when `navigator.storage.estimate()` counts this store and the event log (IndexedDB).
   * Native SQLite stores leave it unset: the WebView's estimate doesn't include the database file.
   */
  readonly measuredByStorageEstimate?: boolean;
  /** Newest first. */
  list(): Promise<StoredBackupInfo[]>;
  put(info: StoredBackupInfo, bytes: Uint8Array): Promise<void>;
  getBytes(backupId: string): Promise<Uint8Array | undefined>;
  delete(backupId: string): Promise<void>;
}

export interface PickedFile {
  name: string;
  /** The file's content; empty when `tooLarge` is set. */
  bytes: Uint8Array;
  mime?: string;
  /** Size in bytes, when the platform reports it before reading. */
  size?: number;
  /** The file is larger than the `maxBytes` passed to `pickFile`, so it was not read at all. */
  tooLarge?: true;
}

export interface PickFileOptions {
  accept?: string;
  /**
   * Largest file to read. A bigger one is never loaded into memory: `pickFile` resolves to it with
   * empty `bytes` and `tooLarge: true`, so the caller can say so without risking a crash.
   */
  maxBytes?: number;
}

export interface ProcessedImage {
  hash: string;
  ext: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
}

export interface ImageProcessOptions {
  maxDimension?: number;
  quality?: number;
  maxInputBytes?: number;
}

/** The part of a DOM `Blob` that `Files.downloadBlob` needs (this package has no DOM types). */
export interface DownloadableBlob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Where a streamed export goes: chunks are written in order, then `close` or `abort`. Callers
 * must await each `write` before the next, and must not write after `close` or `abort`.
 */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Finishes the file (the native share sheet opens, or the saved file is complete). */
  close(): Promise<void>;
  /** Stops and discards the partial file (Tauri leaves it empty). Safe after a failed `write`. */
  abort(): Promise<void>;
}

export interface Files {
  /** `null` when the user cancels; rejects when the chosen file cannot be read. */
  pickFile(options?: PickFileOptions): Promise<PickedFile | null>;
  downloadFile(filename: string, data: Uint8Array, mimeType: string): Promise<void>;
  /**
   * Optional: saves a file built as a `Blob` (pass a real DOM Blob) without copying it into one
   * array first, for large exports. Without it, callers read the Blob and use `downloadFile`.
   */
  downloadBlob?(filename: string, blob: DownloadableBlob): Promise<void>;
  /**
   * Optional (native builds): opens a file to write in chunks, so a large export never sits in
   * memory as one array. Resolves to `null` when the user cancels the save dialog. Without it,
   * callers build the whole file and use `downloadFile`.
   */
  saveStream?(filename: string, mimeType: string): Promise<FileSink | null>;
  /** Optional PC local folder picker (Phase 3). */
  pickDirectory?(): Promise<unknown>;
}

export interface SyncFileInfo {
  path: string;
  size: number;
  updatedAt?: number;
}

/**
 * Exact §4.3 SyncTransport contract. The sync engine depends on these failure codes, so every
 * implementation throws a `SyncTransportError` (`@flash/core`) rather than a provider error:
 * - `read` of a missing file → `NOT_FOUND`;
 * - `write(…, { ifAbsent: true })` over an existing file → `ALREADY_EXISTS` (never a silent
 *   success; any other failure, such as a full drive, must throw);
 * - expired or revoked sign-in → `AUTH_REQUIRED`; throttling → `RATE_LIMITED`.
 * HTTP transports refresh the token once after a 401 and retry 429 / 5xx with backoff before
 * throwing; a provider's own throttling reply (Google's 403 `rateLimitExceeded`) is
 * `RATE_LIMITED`, never `PERMISSION_DENIED`, so throttled users aren't told to reconnect.
 * `list(prefix)` returns every file whose path starts with `prefix` (a missing folder lists as
 * empty), in code-unit order. `packages/platform-web/tests/helpers/sync-transport-contract.ts`
 * is the shared conformance suite.
 */
export interface SyncTransport {
  list(prefix: string): Promise<SyncFileInfo[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void>;
}

export type OAuthSignInIntent = 'sync' | 'sources';

export interface AuthSession {
  provider: string;
  accessToken: string;
  expiresAt: number;
  scope?: string;
  intent?: OAuthSignInIntent;
}

export interface Auth {
  isConfigured(): boolean;
  isConnected(): Promise<boolean>;
  getSession(): Promise<AuthSession | null>;
  getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string>;
  signIn(opts?: { intent?: OAuthSignInIntent }): Promise<AuthSession | null>;
  handleRedirectCallback(): Promise<AuthSession | null>;
  signOut(): Promise<void>;
}

/** Non-blocking import warning surfaced per linked source. */
export interface SourceWarning {
  code: string;
  message: string;
  row?: number;
  header?: string;
  file?: string;
}

export type SourceSyncStatus = 'idle' | 'synced' | 'error' | 'permission_required' | 'offline';

export interface LinkedGoogleSource {
  id: string;
  kind: 'google_sheets' | 'google_docs';
  fileId: string;
  name: string;
  uri: string;
  deckId?: string;
  pageId?: string;
  noteTypeId?: string;
  language?: string;
  sheetTab?: string;
  /**
   * The column mapping chosen when the Sheet was linked through Bring my cards. The deck's
   * synced `source.column_map` wins once it exists; this copy covers the first pull.
   */
  columnMap?: SourceColumnMapping[];
  readOnly?: boolean;
  lastModifiedTime?: string;
  /** The last refresh left the Sheet alone because its deck is archived (`lastError` says so). */
  skipReason?: 'archived';
  lastSyncedAt?: number;
  lastStatus?: SourceSyncStatus;
  lastError?: string;
  warnings?: SourceWarning[];
  /** Cached map of remote `https://` image URL -> localized `media:<sha256>` URI (Option 1). */
  localizedImages?: Record<string, string>;
  /** Cached map of remote `https://` audio URL -> localized `media:<sha256>` URI. */
  localizedAudio?: Record<string, string>;
}

/**
 * A `.csv` / `.tsv` / `.xlsx` file in the user's personal OneDrive, linked like a Google Sheet:
 * it refreshes into one deck. Read-only: the app never writes to the user's OneDrive files.
 */
export interface LinkedOneDriveSource {
  id: string;
  /** Graph drive-item id. */
  itemId: string;
  name: string;
  uri?: string;
  deckId?: string;
  noteTypeId?: string;
  language?: string;
  /** The mapping chosen when linked; the deck's synced `source.column_map` wins once it exists. */
  columnMap?: SourceColumnMapping[];
  /**
   * `columnMap` was chosen on this device but has not reached the deck yet (the pull was held
   * for a rename review). While set, it wins over the deck's older mapping.
   */
  columnMapUnsaved?: true;
  /** Content tag at the last pull; an unchanged tag skips the download. */
  contentTag?: string;
  /**
   * Why the last refresh left the file alone on this device (`lastError` says it in words):
   * `archived` = its deck is archived; `unreadable` = an `.xlsx` this device cannot read (phone
   * and Tauri shells). Cleared by the next pull that lands.
   */
  skipReason?: 'archived' | 'unreadable';
  lastSyncedAt?: number;
  lastStatus?: SourceSyncStatus;
  lastError?: string;
  warnings?: SourceWarning[];
}

/**
 * A plain file in the user's Google Drive, picked with Google Picker (`drive.file` scope only) and
 * linked like a OneDrive file: a `.csv` / `.tsv` / `.xlsx` refreshes into one deck (read-only,
 * rows matched by their first field); a `.flashpkg` is re-imported like a subscribed package when
 * it changes. The app never writes to the file.
 */
export interface LinkedGoogleDriveFileSource {
  id: string;
  /** Drive file id. */
  fileId: string;
  name: string;
  /** `table` = `.csv` / `.tsv` / `.xlsx` into one deck; `flashpkg` = a package. */
  format: 'table' | 'flashpkg';
  /** The file's Drive web address (display and "Open" link only). */
  uri?: string;
  /** The deck it fills (`table`), or one deck it imported (`flashpkg`). */
  deckId?: string;
  noteTypeId?: string;
  language?: string;
  /** The mapping chosen when linked; the deck's synced `source.column_map` wins once it exists. */
  columnMap?: SourceColumnMapping[];
  /** `columnMap` was chosen here but has not reached the deck yet (a held rename review). */
  columnMapUnsaved?: true;
  /** Content tag at the last pull (`md5Checksum`, else `version`, else `modifiedTime`). */
  contentTag?: string;
  /** `flashpkg` only: the package's id and version at the last import. */
  packageId?: string;
  version?: string;
  /** Why the last refresh left the file alone (same meanings as {@link LinkedOneDriveSource}). */
  skipReason?: 'archived' | 'unreadable';
  lastSyncedAt?: number;
  lastStatus?: SourceSyncStatus;
  lastError?: string;
  warnings?: SourceWarning[];
}

/**
 * A `.csv` / `.tsv` / `.xlsx` file in the app's Dropbox App Folder (`Dropbox/Apps/<app name>/`),
 * linked like a OneDrive spreadsheet: it refreshes into one deck. Read-only: the app never writes
 * back to the user's spreadsheets.
 */
export interface LinkedDropboxSource {
  id: string;
  /** Dropbox immutable file id (`id:...`). */
  fileId: string;
  /** Display name (extension stripped for deck title). */
  name: string;
  /** Display path inside the App Folder (e.g. `/Decks/vocab.csv`), for UI context. */
  pathDisplay?: string;
  deckId?: string;
  noteTypeId?: string;
  language?: string;
  /** The mapping chosen when linked; the deck's synced `source.column_map` wins once it exists. */
  columnMap?: SourceColumnMapping[];
  /**
   * `columnMap` was chosen on this device but has not reached the deck yet (the pull was held
   * for a rename review). While set, it wins over the deck's older mapping.
   */
  columnMapUnsaved?: true;
  /** Dropbox `content_hash` (falling back to `rev`) at the last pull; unchanged skips download. */
  contentTag?: string;
  /**
   * Why the last refresh left the file alone on this device (`lastError` says it in words):
   * `archived` = its deck is archived; `unreadable` = an `.xlsx` this device cannot read (phone
   * and Tauri shells). Cleared by the next pull that lands.
   */
  skipReason?: 'archived' | 'unreadable';
  lastSyncedAt?: number;
  lastStatus?: SourceSyncStatus;
  lastError?: string;
  warnings?: SourceWarning[];
}

export interface CachedLocalFileEntry {
  relativePath: string;
  kind: 'csv' | 'tsv' | 'xlsx' | 'md' | 'flashpkg';
  lastModified: number;
  size: number;
  contentHash: string;
  deckId?: string;
  pageId?: string;
  noteTypeId?: string;
  language?: string;
  packageId?: string;
}

export interface InboxImportedEntry {
  fileName: string;
  contentHash: string;
  importedAt: number;
  movedToImported: boolean;
}

export interface PendingXlsxReconciliation {
  folderId: string;
  relativePath: string;
  deckId: string;
  deckName: string;
  missingNotes: Array<{ noteId: string; sortKey: string; preview: string }>;
  addedRows: Array<{ rowNumber: number; sortKey: string; preview: string }>;
}

export interface LinkedLocalFolder {
  id: string;
  name: string;
  addedAt: number;
  writeCardIds: boolean;
  lastScannedAt?: number;
  lastStatus?: SourceSyncStatus;
  lastError?: string;
  files: Record<string, CachedLocalFileEntry>;
  inboxImported: Record<string, InboxImportedEntry>;
  warnings?: SourceWarning[];
}

export interface PackageSubscription {
  id: string;
  url: string;
  title: string;
  packageId?: string;
  version?: string;
  expectedSha256?: string;
  etag?: string;
  lastModified?: string;
  catalogUrl?: string;
  lastSyncedAt?: number;
  lastStatus?: SourceSyncStatus;
  lastError?: string;
  warnings?: SourceWarning[];
}

export interface CatalogPackageInfo {
  package_id: string;
  title: string;
  description?: string;
  url: string;
  version: string;
  languages: string[];
  updated_at?: string;
  author?: string;
  sha256?: string;
}

export interface FamilyCatalogSubscription {
  id: string;
  url: string;
  name: string;
  description?: string;
  updatedAt?: string;
  etag?: string;
  lastFetchedAt?: number;
  lastError?: string;
  packages: CatalogPackageInfo[];
}

export interface SourcesRegistry {
  googleSources: LinkedGoogleSource[];
  /** Absent in registries saved before linked OneDrive sources existed. */
  oneDriveSources?: LinkedOneDriveSource[];
  /** Absent in registries saved before linked Dropbox sources existed. */
  dropboxSources?: LinkedDropboxSource[];
  /**
   * Legacy (PR #19 builds): OneDrive item ids unlinked on this device only; their synced decks
   * are not re-listed as sources. Unlink now emits `SourceUnlinked`, which reaches every device,
   * so this is only read (and cleared when the file is linked again), never added to.
   */
  unlinkedOneDriveIds?: string[];
  /** Linked Google Drive files; absent in registries saved before they existed. */
  googleDriveFiles?: LinkedGoogleDriveFileSource[];
  localFolders: LinkedLocalFolder[];
  packageSubscriptions: PackageSubscription[];
  catalogs: FamilyCatalogSubscription[];
}

export interface GooglePickedFile {
  id: string;
  name: string;
  mimeType: string;
  url?: string;
}

export interface GooglePickerAdapter {
  isConfigured(): boolean;
  pickSheetsAndDocs(): Promise<GooglePickedFile[]>;
  /**
   * Picks Sheets, Docs, and plain Drive files (`.csv` / `.tsv` / `.xlsx` / `.flashpkg`) with the
   * same `drive.file` scope. Optional: adapters without it only offer Sheets and Docs.
   */
  pickDriveFiles?(): Promise<GooglePickedFile[]>;
}

/** One entry in a OneDrive folder listing (Microsoft Graph `driveItem`, §15 Phase 12). */
export interface OneDriveBrowseItem {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size: number;
  /** Number of children, folders only. */
  childCount?: number;
  lastModifiedAt?: number;
}

/** Metadata of one OneDrive file: enough to tell cheaply whether its content changed. */
export interface OneDriveFileInfo {
  id: string;
  name: string;
  size: number;
  /** Content tag: changes only when the file's bytes change (falls back to `eTag`). */
  contentTag?: string;
  lastModifiedAt?: number;
  /** The file's OneDrive web address (display and "Open" link only). */
  webUrl?: string;
}

/**
 * Optional OneDrive file picker (§15 Phase 12): browses the user's OneDrive with the optional
 * `Files.Read` scope and downloads one `.csv` / `.xlsx` / `.flashpkg` file for import.
 */
export interface OneDriveFilePicker {
  isConfigured(): boolean;
  /** True once the user has granted `Files.Read` (sync alone only grants the app folder). */
  hasFileAccess(): Promise<boolean>;
  /** Starts the incremental-consent sign-in for `Files.Read` (a redirect on web). */
  requestFileAccess(): Promise<boolean>;
  /** Lists a folder (the drive root when `folderId` is omitted); folders first, then files. */
  listFolder(folderId?: string): Promise<OneDriveBrowseItem[]>;
  /** Downloads a file picked from `listFolder` (size-capped). */
  downloadFile(item: OneDriveBrowseItem): Promise<PickedFile>;
  /** Reads one file's metadata by item id (a linked source's cheap "did it change?" check). */
  getFileInfo(itemId: string): Promise<OneDriveFileInfo>;
  /** Downloads one file by item id (size-capped), for refreshing a linked source. */
  downloadById(itemId: string): Promise<PickedFile>;
}

/** One entry in a Dropbox App Folder listing (`/2/files/list_folder`). */
export interface DropboxBrowseItem {
  /** Dropbox file/folder id (`id:...`). */
  id: string;
  name: string;
  /** Path inside the App Folder (e.g. `/Decks` or `/Decks/vocab.csv`). */
  pathDisplay: string;
  pathLower: string;
  kind: 'folder' | 'file';
  size: number;
  lastModifiedAt?: number;
}

/** Metadata of one Dropbox App Folder file: enough to tell cheaply whether its content changed. */
export interface DropboxFileInfo {
  /** Dropbox immutable file id (`id:...`). */
  id: string;
  name: string;
  pathDisplay: string;
  size: number;
  /** Dropbox `rev` identifier. */
  rev?: string;
  /** Dropbox SHA-256 block content hash (`content_hash`). */
  contentHash?: string;
  /** Best change detector (`content_hash` when present, else `rev`). */
  contentTag?: string;
  lastModifiedAt?: number;
}

/**
 * Dropbox App Folder file picker: browses files inside `Dropbox/Apps/<app name>/` (excluding
 * the app's own sync data folders) using the same App Folder OAuth sign-in as Dropbox Sync.
 */
export interface DropboxFilePicker {
  isConfigured(): boolean;
  /** True when Dropbox is signed in on this device (shared with Dropbox Sync). */
  isConnected(): Promise<boolean>;
  /** Starts Dropbox sign-in (`intent: 'sources'`); redirects on web, resolves true on native. */
  connect(): Promise<boolean>;
  /** Lists a folder inside the App Folder (`""` or omitted = root); folders first, then files. */
  listFolder(folderPath?: string): Promise<DropboxBrowseItem[]>;
  /** Downloads a file picked from `listFolder` (size-capped). */
  downloadFile(item: DropboxBrowseItem): Promise<PickedFile>;
  /** Reads one file's metadata by Dropbox file id or path (cheap "did it change?" check). */
  getFileInfo(fileIdOrPath: string): Promise<DropboxFileInfo>;
  /** Downloads one file by Dropbox file id or path (size-capped), for refreshing a linked source. */
  downloadById(fileIdOrPath: string, knownSize?: number): Promise<PickedFile>;
}

export interface GoogleDriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  canEdit: boolean;
}

export interface GoogleSheetGrid {
  spreadsheetId: string;
  title: string;
  sheetTitle: string;
  modifiedTime?: string;
  values: string[][];
  readOnly: boolean;
  embeddedImageRows: number[];
}

export interface GoogleSourcesClient {
  getFileMetadata(fileId: string): Promise<GoogleDriveFileMeta>;
  readSheet(fileId: string, sheetTab?: string): Promise<GoogleSheetGrid>;
  writeSheetCells(
    fileId: string,
    sheetTitle: string,
    updates: ReadonlyArray<{ a1: string; value: string }>,
  ): Promise<void>;
  createSheetFromTemplate(options: {
    title: string;
    headers: readonly string[];
    sampleRows?: ReadonlyArray<readonly string[]>;
  }): Promise<{ fileId: string; title: string; sheetTitle: string; uri: string }>;
  exportDocAsMarkdown(
    fileId: string,
  ): Promise<{ fileId: string; title: string; markdown: string; modifiedTime?: string }>;
  /** Plain Drive file metadata (a linked file's cheap "did it change?" check). */
  getDriveFileInfo?(fileId: string): Promise<GoogleDriveFileInfo>;
  /** Downloads a plain Drive file (`files.get?alt=media`), size-capped. */
  downloadDriveFile?(fileId: string): Promise<PickedFile>;
}

/** Metadata of one plain (non-Google-Workspace) Drive file. */
export interface GoogleDriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  md5Checksum?: string;
  version?: string;
  webViewLink?: string;
  trashed?: boolean;
  /** Changes when the bytes change: `md5Checksum`, else `version`, else `modifiedTime`. */
  contentTag?: string;
}

export interface ScannedLocalFileDescriptor {
  relativePath: string;
  name: string;
  kind: 'csv' | 'tsv' | 'xlsx' | 'md' | 'flashpkg';
  isInbox: boolean;
  size: number;
  lastModified: number;
}

export interface LocalFolderSourcesAdapter {
  isSupported(): boolean;
  pickFolder(): Promise<{ id: string; name: string } | null>;
  removeFolder(folderId: string): Promise<void>;
  ensurePermission(
    folderId: string,
    mode: 'read' | 'readwrite',
    requestPermission: boolean,
  ): Promise<boolean>;
  listFolderFiles(folderId: string): Promise<ScannedLocalFileDescriptor[]>;
  readFileBytes(folderId: string, relativePath: string, maxBytes?: number): Promise<Uint8Array>;
  parseXlsxBytes(bytes: Uint8Array): Promise<string[][]>;
  /** False when this adapter has no Excel reader (omitted means it can read `.xlsx`). */
  canParseXlsx?(): boolean;
  readRelativeMedia(
    folderId: string,
    baseFileRelativePath: string,
    mediaRelativePath: string,
  ): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null>;
  writeFileText(folderId: string, relativePath: string, text: string): Promise<void>;
  moveInboxFileToImported(folderId: string, fileName: string): Promise<boolean>;
}

export interface PackageFetchResultNotModified {
  notModified: true;
}

export interface PackageFetchResultUpdated {
  notModified: false;
  bytes: Uint8Array;
  etag?: string;
  lastModified?: string;
}

export type PackageFetchResult = PackageFetchResultNotModified | PackageFetchResultUpdated;

export interface PackageSubscriptionFetcher {
  fetchCatalog(
    url: string,
    opts?: { etag?: string; lastModified?: string },
  ): Promise<
    | { notModified: true }
    | {
        notModified: false;
        rawJson: string;
        etag?: string;
        lastModified?: string;
      }
  >;
  fetchPackage(
    url: string,
    opts?: { etag?: string; lastModified?: string; maxBytes?: number },
  ): Promise<PackageFetchResult>;
}

/** Off-main-thread Web Worker replay client (§4.1 & §8). */
export interface ReplayWorkerClient {
  hydrate(snapshot: SerializedCollectionState): Promise<void>;
  apply(events: readonly FlashEvent[]): Promise<CollectionStatePatch>;
  terminate(): void;
}

export type TtsProviderKind = 'none' | 'google' | 'azure';

export interface TtsProviderConfig {
  provider: TtsProviderKind;
  apiKey?: string;
  azureRegion?: string;
  voices?: Record<string, string>;
}

export interface TtsSynthesisResult {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  voiceId: string;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
}

export interface TtsProvider {
  readonly id: string;
  resolveVoiceId(lang: string, voiceOverride?: string): string;
  synthesize(
    text: string,
    lang: string,
    opts?: { voiceOverride?: string; signal?: AbortSignalLike },
  ): Promise<TtsSynthesisResult>;
}

export interface ProcessedAudio {
  hash: string;
  ext: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
}

export interface AudioPlayer {
  unlock(): void;
  preload(hash: string, bytes: Uint8Array, mime: string): void;
  hasPreloaded(hash: string): boolean;
  retainOnly(keepHashes: ReadonlySet<string>): void;
  playPreloaded(hash: string, rate?: number): Promise<boolean>;
  /** Rejects when playback fails, with or without `cacheHash`. */
  play(bytes: Uint8Array, mime: string, rate?: number, cacheHash?: string): Promise<void>;
  stop(): void;
  dispose(): void;
}

export interface DeviceVoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}

export interface DeviceSpeechResult {
  status: 'spoken' | 'missing_local_voice' | 'unavailable' | 'error';
  lang: string;
  message?: string;
}

export interface DeviceSpeechPlayer {
  isAvailable(): boolean;
  listVoices(langFilter?: string): DeviceVoiceInfo[];
  /** Optional: notifies listeners when the OS voice list finishes loading or changes. */
  onVoicesChanged?(listener: () => void): () => void;
  speak(
    text: string,
    lang: string,
    opts?: { rate?: number; isOnline?: boolean },
  ): DeviceSpeechResult;
  stop(): void;
}

export interface Purchase {
  readonly isPersonalBuild: boolean;
  isUnlocked(): Promise<boolean>;
  restore(): Promise<boolean>;
  getEntitlement(): Promise<EntitlementState>;
  purchaseUnlock(): Promise<EntitlementState>;
  restorePurchases(): Promise<EntitlementState>;
  /**
   * App Store / Play builds only, run at launch: asks the store again so a refunded unlock locks.
   * A check that fails keeps the cached entitlement.
   */
  recheckStore?(): Promise<EntitlementState>;
  activateLicenseKey(
    rawKey: string,
  ): Promise<LicenseVerifyResult & { entitlement: EntitlementState }>;
  clearLicenseKey(): Promise<EntitlementState>;
}

/**
 * Native shell bridge for Google Picker (§11): opens static `picker.html` on the app's
 * domain in the system browser and receives selected Drive file IDs via custom URL scheme.
 */
export interface NativePickerBridge {
  openSystemBrowserPicker(opts: {
    pickerPageUrl: string;
    accessToken: string;
    appId: string;
    apiKey: string;
    callbackScheme?: string;
    /** `drive_files` also lists `.csv` / `.tsv` / `.xlsx` / `.flashpkg` files (default Sheets/Docs). */
    mode?: 'sheets_docs' | 'drive_files';
  }): Promise<GooglePickedFile[]>;
  parseDeepLinkCallback(callbackUrl: string): GooglePickedFile[];
}

/**
 * Pluggable handwriting recognizer interface (§6.4).
 * Web uses custom MIT stroke-matching over Make Me a Hanzi / KanjiVG medians;
 * Phase 8 Capacitor swaps in Google ML Kit Digital Ink Recognition with zero UI changes.
 */
export interface HandwritingRecognizer {
  readonly id: string;
  readonly isNative: boolean;
  isReady(lang?: string): Promise<boolean>;
  recognize(
    strokes: readonly InkStroke[],
    options?: HandwritingRecognizeOptions,
  ): Promise<HandwritingCandidate[]>;
}

export interface StrokeCacheProgress {
  completed: number;
  total: number;
  cached: number;
  failed: number;
  currentChar?: string;
}

export interface StrokeDataProvider {
  getCharacterData(
    script: StrokeScript,
    char: string,
    opts?: { allowNetwork?: boolean },
  ): Promise<HanziStrokeData | null>;
  hasCachedCharacter(script: StrokeScript, char: string): Promise<boolean>;
  getCacheCoverage(
    script: StrokeScript,
    chars: readonly string[],
  ): Promise<{ cached: number; total: number; missing: string[] }>;
  precacheCharacters(
    script: StrokeScript,
    chars: readonly string[],
    opts?: {
      onProgress?: (progress: StrokeCacheProgress) => void;
      signal?: AbortSignalLike;
    },
  ): Promise<{ cached: number; failed: string[] }>;
}

export interface InstalledPackInfo {
  id: PackId;
  kind: PackKind;
  name: string;
  version: string;
  language: string;
  script?: StrokeScript;
  entryCount: number;
  /** Bytes downloaded so far (for a sharded pack: the index plus the shards loaded). */
  byteSize: number;
  installedAt: number;
  licenseName: string;
  licenseUrl: string;
  attribution: string;
  sourceUrl: string;
  sourceCatalogUrl?: string;
  /**
   * Sharded dictionary packs only: how many shards the pack has and how many are on this device.
   * Search works from the index alone; shards with the full entries download as they're needed.
   */
  shardCount?: number;
  shardsLoaded?: number;
}

export interface PackInstallProgress {
  phase: 'downloading' | 'verifying' | 'indexing' | 'done';
  loadedBytes?: number;
  totalBytes?: number;
  indexedEntries?: number;
  totalEntries?: number;
}

export interface PackManager {
  getCatalogUrl(): string | undefined;
  setCustomCatalogUrl(url: string | undefined): Promise<void>;
  fetchCatalog(catalogUrl?: string): Promise<PackCatalog>;
  listInstalledPacks(): Promise<InstalledPackInfo[]>;
  installPackFromCatalog(
    entry: PackCatalogEntry,
    onProgress?: (progress: PackInstallProgress) => void,
  ): Promise<InstalledPackInfo>;
  installPackFromUrl(
    url: string,
    opts?: { expectedSha256?: string; onProgress?: (progress: PackInstallProgress) => void },
  ): Promise<InstalledPackInfo>;
  installPackFromBytes(
    bytes: Uint8Array,
    opts?: {
      expectedSha256?: string;
      sourceCatalogUrl?: string;
      onProgress?: (progress: PackInstallProgress) => void;
    },
  ): Promise<InstalledPackInfo>;
  removePack(packId: PackId): Promise<void>;
  getStorageUsageBytes(): Promise<number>;
  /** Sharded dictionary packs: downloads every shard not on the device yet (full offline use). */
  downloadAllShards?(
    packId: PackId,
    onProgress?: (progress: PackInstallProgress) => void,
  ): Promise<InstalledPackInfo>;
}

export interface DictionarySearchOptions {
  packIds?: readonly DictionaryPackId[];
  limit?: number;
  /** `from-english` never reads Latin letters as romanization. Default `to-english`. */
  direction?: DictionaryDirection;
}

export interface DictionaryService {
  listInstalledDictionaryPacks(): Promise<InstalledPackInfo[]>;
  lookupCharacter(
    char: string,
    opts?: { packIds?: readonly DictionaryPackId[] },
  ): Promise<DictionaryEntry[]>;
  search(query: string, opts?: DictionarySearchOptions): Promise<DictionaryEntry[]>;
  /** One page of a pack's entries in one browse group, in headword (가나다) order. */
  browse(query: DictionaryBrowseQuery): Promise<DictionaryBrowsePage>;
  /** The groups a pack can be browsed by (levels, topics, grades, parts of speech) with counts. */
  getBrowseSummary(packId: DictionaryPackId): Promise<DictionaryBrowseSummary>;
  /**
   * Full entries for `entries` (sharded packs return `stub` rows until their shard is loaded):
   * loads the shards they need and returns the rows in the same order. Rows whose shard can't be
   * loaded (offline) come back unchanged.
   */
  loadFullEntries?(entries: readonly DictionaryEntry[]): Promise<DictionaryEntry[]>;
}

/** OS notification permission as the native shells report it. */
export type ReminderPermission = 'granted' | 'denied' | 'prompt';

/** One local study-reminder notification (Phase 13). */
export interface ScheduledStudyReminder {
  /** Unix ms when the notification shows. */
  atMs: number;
  title: string;
  body: string;
}

/**
 * How a native shell delivers study reminders:
 * - `os-scheduled`: the OS holds the schedule, so reminders show even when the app is closed
 *   (Capacitor local notifications on Android / iOS).
 * - `while-app-runs`: the app fires them itself, so reminders show only while it is running,
 *   minimized included (Tauri desktop: tauri-plugin-notification cannot schedule on desktop).
 */
export type StudyReminderDelivery = 'os-scheduled' | 'while-app-runs';

/**
 * Native local notifications for study reminders (Capacitor Android / iOS, Tauri desktop).
 * The PWA has no scheduler: it shows an in-app badge instead.
 */
export interface StudyReminderScheduler {
  checkPermission(): Promise<ReminderPermission>;
  /** Asks the OS for notification permission (only call when the user turns reminders on). */
  requestPermission(): Promise<ReminderPermission>;
  /** Replaces every study reminder scheduled before with `reminders`. */
  replaceAll(reminders: readonly ScheduledStudyReminder[]): Promise<void>;
  cancelAll(): Promise<void>;
}

export interface PlatformServices {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly isDevMode: boolean;
  readonly hasDeviceSlug: boolean;
  readonly storage: Storage;
  readonly files: Files;
  readonly syncTransport: SyncTransport;
  readonly audioPlayer?: AudioPlayer;
  readonly deviceSpeech?: DeviceSpeechPlayer;
  readonly googleOAuthConfigured: boolean;
  readonly googlePickerConfigured: boolean;
  readonly supportsLocalFolderSync: boolean;
  /**
   * Set by native shells when sign-in secrets fall back to the app database because the OS
   * has no usable keychain (e.g. Linux without a Secret Service). Settings shows it as a warning.
   */
  readonly secureStorageWarning?: string;
  /** Optional static pack catalog URL (`VITE_PACK_CATALOG_URL` -> `packs.json`, §6.3). */
  readonly packCatalogUrl?: string;
  /** Optional built-in Starter Decks catalog URL (`VITE_STARTER_CATALOG_URL` -> `index.json`, §3.4). */
  readonly starterCatalogUrl?: string;
  getGoogleAuth(): Promise<Auth>;
  createGoogleDriveTransport(): Promise<SyncTransport>;
  /** True when a Dropbox app key is configured (`VITE_DROPBOX_APP_KEY`). */
  readonly dropboxConfigured?: boolean;
  getDropboxAuth?(): Promise<Auth>;
  createDropboxTransport?(): Promise<SyncTransport>;
  /** Optional Dropbox App Folder file picker for `.csv` / `.tsv` / `.xlsx` / `.flashpkg` (lazy). */
  getDropboxPicker?(): Promise<DropboxFilePicker>;
  /**
   * True when a Microsoft Entra client ID is configured for OneDrive app-folder sync
   * (`VITE_MS_CLIENT_ID` on web; native shells set it from their own config).
   */
  readonly oneDriveConfigured?: boolean;
  getOneDriveAuth?(): Promise<Auth>;
  createOneDriveTransport?(): Promise<SyncTransport>;
  /** Optional OneDrive file picker for `.csv` / `.xlsx` / `.flashpkg` imports (lazy). */
  getOneDrivePicker?(): Promise<OneDriveFilePicker>;
  /**
   * Apple devices: true on iOS when the iCloud Drive plugin is present (the user may still be signed
   * out), and in a macOS desktop build signed with the iCloud entitlement (unsigned Mac builds have
   * no iCloud container, so they never offer it). Both use the same container.
   */
  readonly iCloudSyncSupported?: boolean;
  /**
   * macOS (entitled builds): false when iCloud Drive was not available at launch (signed out, or
   * iCloud Drive off), or when the launch probe timed out. iCloud is still offered (a saved
   * connection keeps working) but is not the "Sync my devices" default. Unset on
   * iOS.
   */
  readonly iCloudAvailableAtLaunch?: boolean;
  /**
   * macOS (entitled builds): true when iCloud answered at launch that iCloud Drive is off (signed
   * out, or iCloud Drive turned off). Unset when it was available or the probe timed out, so a slow
   * iCloud daemon never shows the "turn on iCloud Drive" hint.
   */
  readonly iCloudOffAtLaunch?: boolean;
  /** iOS / macOS: iCloud Drive transport; throws when iCloud Drive is off or the user is signed out. */
  createICloudTransport?(): Promise<SyncTransport>;
  getGooglePicker(): Promise<GooglePickerAdapter>;
  getGoogleSourcesClient(): Promise<GoogleSourcesClient>;
  getLocalFolderSources(): Promise<LocalFolderSourcesAdapter>;
  getPackageFetcher(): Promise<PackageSubscriptionFetcher>;
  pickLocalSyncFolder(): Promise<{ name: string; transport: SyncTransport } | null>;
  restoreLocalSyncFolder(opts?: {
    requestPermission?: boolean;
  }): Promise<{ name: string; transport: SyncTransport } | null>;
  disconnectLocalSyncFolder(): Promise<void>;
  /**
   * Native shells only: calls `handler` with every `flashcards://add-device?...` link the OS opens
   * the app with (a scanned QR code or a tapped link), including the link that launched the app.
   * Returns an unsubscribe function. The handler must treat the URL as untrusted text.
   */
  onAddDeviceUrl?: (handler: (url: string) => void) => () => void;
  /**
   * Native shells only (Android): subscribes to the hardware/gesture Back button. The handler
   * returns `true` if it handled the press (e.g. closed a dialog or navigated back to Study), or
   * `false` to let the OS minimize/background the app.
   */
  onBackButton?: (handler: () => boolean) => () => void;
  onDevSyncNotification?: (listener: (path: string) => void) => () => void;
  createReplayWorker?: () => Promise<ReplayWorkerClient | null>;
  processImage?: (
    bytes: Uint8Array,
    mime: string,
    opts?: ImageProcessOptions,
  ) => Promise<ProcessedImage>;
  fetchAndCacheHttpsImage?: (url: string, opts?: ImageProcessOptions) => Promise<ProcessedImage>;
  createTtsProvider?: (config: TtsProviderConfig) => Promise<TtsProvider | null>;
  processAudio?: (bytes: Uint8Array, mime: string) => Promise<ProcessedAudio>;
  fetchAndCacheHttpsAudio?: (url: string) => Promise<ProcessedAudio>;
  getPackManager?: () => Promise<PackManager>;
  getStrokeDataProvider?: () => Promise<StrokeDataProvider>;
  getHandwritingRecognizer?: () => Promise<HandwritingRecognizer>;
  getDictionaryService?: () => Promise<DictionaryService>;
  getPurchase?: () => Promise<Purchase>;
  getNativePickerBridge?: () => Promise<NativePickerBridge>;
  /** Native shells only: local-notification study reminders (lazy, never in the PWA). */
  getStudyReminderScheduler?: () => Promise<StudyReminderScheduler>;
  /**
   * Set together with `getStudyReminderScheduler`: how its reminders reach the user (known
   * up front so Settings can say so without loading the scheduler).
   */
  readonly studyReminderDelivery?: StudyReminderDelivery;
  /** Phase 11 on-device FSRS optimizer (lazy: WASM + Worker load only when called). */
  getFsrsOptimizer?: () => Promise<FsrsOptimizer>;
  /** Phase 12 Anki `.apkg` reader (lazy: Worker + sql.js WASM load only when called). */
  getAnkiPackageReader?: () => Promise<AnkiPackageReader>;
}
