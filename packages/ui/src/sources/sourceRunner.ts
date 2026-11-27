import {
  BUILTIN_NOTE_TYPE_IDS,
  decodeUtf8,
  FLASH_NAMESPACE_UUID,
  isSyncTransportError,
  uuidv5,
  type CollectionState,
  type EventFactory,
  type KnownEvent,
  type NoteType,
  type SourceColumnMapping,
  type SourceRef,
} from '@flash/core';
import { parseDelimitedText } from '@flash/core/csv';
import { importFlashpkg } from '@flash/core/flashpkg';
import {
  applyCardIdsToGridAndSerialize,
  assertSafeHttpsUrl,
  diffTabularSource,
  filterSafeWriteBackCells,
  inferPresetNoteTypeId,
  isStrictHttpsUrl,
  mapTabularHeaders,
  normalizeMarkdownPage,
  parseAndValidateFamilyCatalog,
  parseImageCellValue,
  sha256Hex,
  sha256String,
} from '@flash/core/sources';
import type {
  CachedLocalFileEntry,
  CatalogPackageInfo,
  FamilyCatalogSubscription,
  GooglePickedFile,
  LinkedGoogleSource,
  LinkedLocalFolder,
  PackageSubscription,
  PendingXlsxReconciliation,
  SourcesRegistry,
  SourceWarning,
} from '@flash/platform';
import { putMediaListTracked, putMediaTracked } from '../state/recentMedia.ts';
import { DROPBOX_FILES, ONEDRIVE_FILES } from './cloudFileProviders.ts';
import {
  applyCloudFileReconciliation,
  archivedDeckRefreshMessage,
  excelUnreadableMessage,
  refreshCloudFileRow,
  refreshCloudFiles,
  type CloudFileRowOutcome,
} from './cloudFileSource.ts';
import { deckLimitReason, newDeckIds } from './deckLimit.ts';
import {
  GOOGLE_DRIVE_FILES,
  GOOGLE_RECONNECT_MESSAGE,
  markGoogleDriveFilesDisconnected,
  refreshLinkedGoogleDriveFiles,
} from './googleDriveFileSource.ts';
import {
  carriesSource,
  isOnline,
  loadSourcesRegistry,
  resolveNoteType,
  saveSourcesRegistry,
  type SourceRefreshSummary,
  type SourceRunContext,
  withSourcesLock,
} from './sourcesRegistry.ts';

export {
  LINKED_SOURCES_KV_KEY,
  loadSourcesRegistry,
  saveSourcesRegistry,
  type SourceRefreshSummary,
  type SourceRunContext,
  withSourcesLock,
} from './sourcesRegistry.ts';
export { readCloudTable as readOneDriveTable } from './cloudFileSource.ts';
export {
  downloadGoogleDriveFile,
  linkGoogleDriveFile,
  readGoogleDriveTable,
  rejectedDriveFilesMessage,
  splitPickedGoogleFiles,
} from './googleDriveFileSource.ts';
export {
  DROPBOX_RECONCILE_PREFIX,
  linkDropboxFile,
  linkOneDriveFile,
  ONEDRIVE_RECONCILE_PREFIX,
  refreshSingleDropboxSource,
  refreshSingleOneDriveSource,
} from './cloudFileProviders.ts';

const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/** A linked-source row that Unlink removes. */
export type UnlinkSourceKind =
  'google' | 'onedrive' | 'gdrive_file' | 'dropbox' | 'folder' | 'package' | 'catalog';

/** Which synced deck/page sources a registry row stands for (none for folders and catalogs). */
function syncedSourceMatcher(
  registry: SourcesRegistry,
  kind: UnlinkSourceKind,
  id: string,
): ((source: SourceRef) => boolean) | null {
  if (kind === 'google') {
    const row = registry.googleSources.find((s) => s.id === id);
    return row ? (src) => carriesSource(src, row.kind, row.fileId) : null;
  }
  if (kind === 'onedrive') {
    const row = registry.oneDriveSources?.find((s) => s.id === id);
    return row ? (src) => carriesSource(src, 'onedrive_file', row.itemId) : null;
  }
  if (kind === 'gdrive_file') {
    const row = registry.googleDriveFiles?.find((s) => s.id === id);
    return row ? (src) => carriesSource(src, 'google_drive_file', row.fileId) : null;
  }
  if (kind === 'dropbox') {
    const row = registry.dropboxSources?.find((s) => s.id === id);
    return row ? (src) => carriesSource(src, 'dropbox_file', row.fileId) : null;
  }
  if (kind === 'package') {
    const row = registry.packageSubscriptions.find((p) => p.id === id);
    return row ? (src) => src.kind === 'package_url' && src.uri === row.url : null;
  }
  // Local folders are linked per device, and catalogs only list packages.
  return null;
}

/** One `SourceUnlinked` per deck and page whose source `matches`. */
function planSourceUnlinkEvents(
  state: CollectionState,
  factory: EventFactory,
  matches: (source: SourceRef) => boolean,
  nowMs: number,
): KnownEvent[] {
  const events: KnownEvent[] = [];
  for (const deck of state.decks.values()) {
    if (deck.source && matches(deck.source)) {
      events.push(
        factory.create('SourceUnlinked', { target_kind: 'deck', target_id: deck.id }, nowMs),
      );
    }
  }
  for (const page of state.pages.values()) {
    if (page.source && matches(page.source)) {
      events.push(
        factory.create('SourceUnlinked', { target_kind: 'page', target_id: page.id }, nowMs),
      );
    }
  }
  return events;
}

/**
 * Unlinks one source. A Google Sheet / Doc, OneDrive file or `.flashpkg` URL is unlinked on every
 * device through `SourceUnlinked` (its decks and pages keep their notes and reviews but lose the
 * source); a local folder or catalog only lives in this device's registry. Returns the saved
 * registry.
 */
export async function unlinkSource(
  kind: UnlinkSourceKind,
  id: string,
  ctx: SourceRunContext,
): Promise<SourcesRegistry> {
  return withSourcesLock(async () => {
    const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
    const matches = syncedSourceMatcher(registry, kind, id);
    if (matches) {
      ctx.emitEvents(
        planSourceUnlinkEvents(ctx.getState(), ctx.getEventFactory(), matches, Date.now()),
      );
    }
    if (kind === 'google') {
      registry.googleSources = registry.googleSources.filter((s) => s.id !== id);
    } else if (kind === 'onedrive') {
      registry.oneDriveSources = (registry.oneDriveSources ?? []).filter((s) => s.id !== id);
    } else if (kind === 'gdrive_file') {
      registry.googleDriveFiles = (registry.googleDriveFiles ?? []).filter((s) => s.id !== id);
    } else if (kind === 'dropbox') {
      registry.dropboxSources = (registry.dropboxSources ?? []).filter((s) => s.id !== id);
    } else if (kind === 'folder') {
      registry.localFolders = registry.localFolders.filter((f) => f.id !== id);
      const adapter = await ctx.platform.getLocalFolderSources();
      await adapter.removeFolder(id);
    } else if (kind === 'package') {
      registry.packageSubscriptions = registry.packageSubscriptions.filter((p) => p.id !== id);
    } else {
      registry.catalogs = registry.catalogs.filter((c) => c.id !== id);
    }
    await saveSourcesRegistry(ctx.platform, registry);
    return registry;
  });
}

type RemoteMediaFetcher =
  | ((url: string) => Promise<{
      hash: string;
      ext: string;
      mime: string;
      size: number;
      bytes: Uint8Array;
    }>)
  | undefined;

/** What differs between localizing images and audio: the fetcher, the cache field, the warning. */
interface RemoteMediaKind {
  fetcher: RemoteMediaFetcher;
  cache: 'localizedImages' | 'localizedAudio';
  warningCode: string;
  warn: (url: string, reason: string) => string;
}

interface LocalizedRemoteMedia {
  mediaPathMap: Record<string, string>;
  mediaEvents: KnownEvent[];
  warnings: SourceWarning[];
}

/** A cached `media:<sha256>` URI still backed by local media storage and state, else null. */
async function reusableCachedMedia(
  cachedUri: string | undefined,
  ctx: SourceRunContext,
): Promise<string | null> {
  const cachedMatch = cachedUri ? /^media:([0-9a-f]{64})$/i.exec(cachedUri) : null;
  if (!cachedMatch?.[1]) return null;
  const hash = cachedMatch[1].toLowerCase();
  if (!ctx.getState().media.has(hash)) return null;
  return (await ctx.platform.storage.getMedia(hash)) ? `media:${hash}` : null;
}

/**
 * Option 1 (§13 + R7): Pre-localizes remote `https:` image or audio URLs BEFORE diffing Google
 * Sheets / Docs so:
 * 1. `MediaAdded` events are emitted FIRST with strictly ascending `seq` (before `NoteUpserted`/`PageUpserted`).
 * 2. Already-cached URLs (`source.localizedImages` / `localizedAudio`) are reused with zero
 *    redundant network fetches and zero spurious `NoteUpserted`/`PageUpserted` diffs on later pulls.
 * 3. CORS failures emit a clear non-blocking warning without failing the pull.
 */
async function preLocalizeHttpsMedia(
  kind: RemoteMediaKind,
  urls: Iterable<string>,
  source: LinkedGoogleSource,
  ctx: SourceRunContext,
  nowMs: number,
): Promise<LocalizedRemoteMedia> {
  const result: LocalizedRemoteMedia = { mediaPathMap: {}, mediaEvents: [], warnings: [] };
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 0) return result;

  const factory = ctx.getEventFactory();
  const emittedHashes = new Set<string>(ctx.getState().media.keys());
  const nextCache: Record<string, string> = { ...source[kind.cache] };
  let cacheMutated = false;

  for (const url of uniqueUrls) {
    // One file at a time, right after it is fetched or read.
    const reused = await reusableCachedMedia(nextCache[url], ctx); // NOSONAR (S9382)
    if (reused) {
      result.mediaPathMap[url] = reused;
      continue;
    }
    if (!kind.fetcher) continue;
    try {
      const processed = await kind.fetcher(url); // NOSONAR (S9382)
      const blob = { hash: processed.hash, mime: processed.mime, bytes: processed.bytes };
      await putMediaTracked(ctx.platform.storage, blob); // NOSONAR (S9382)
      if (!emittedHashes.has(processed.hash)) {
        emittedHashes.add(processed.hash);
        result.mediaEvents.push(
          factory.create(
            'MediaAdded',
            {
              media: {
                hash: processed.hash,
                ext: processed.ext,
                mime: processed.mime,
                size: processed.size,
              },
            },
            nowMs,
          ),
        );
      }
      const mediaUri = `media:${processed.hash}`;
      result.mediaPathMap[url] = mediaUri;
      nextCache[url] = mediaUri;
      cacheMutated = true;
    } catch (err) {
      result.warnings.push({
        code: kind.warningCode,
        message: kind.warn(url, err instanceof Error ? err.message : String(err)),
      });
    }
  }

  if (cacheMutated) source[kind.cache] = nextCache;
  return result;
}

function preLocalizeHttpsImageUrls(
  urls: Iterable<string>,
  source: LinkedGoogleSource,
  ctx: SourceRunContext,
  nowMs: number,
): Promise<LocalizedRemoteMedia> {
  const kind: RemoteMediaKind = {
    fetcher: ctx.platform.fetchAndCacheHttpsImage,
    cache: 'localizedImages',
    warningCode: 'remote_image_cors_blocked',
    warn: (url, reason) =>
      `Could not cache remote image "${url}" (${reason}). Upload the image directly or bundle it in .flashpkg / a linked local folder for offline display.`,
  };
  return preLocalizeHttpsMedia(kind, urls, source, ctx, nowMs);
}

/** Remote audio from Google Sheets `Audio` / `Sound 1` columns, like images. */
function preLocalizeHttpsAudioUrls(
  urls: Iterable<string>,
  source: LinkedGoogleSource,
  ctx: SourceRunContext,
  nowMs: number,
): Promise<LocalizedRemoteMedia> {
  const kind: RemoteMediaKind = {
    fetcher: ctx.platform.fetchAndCacheHttpsAudio,
    cache: 'localizedAudio',
    warningCode: 'remote_audio_cors_blocked',
    warn: (url, reason) =>
      `Could not cache remote audio "${url}" (${reason}). Upload the audio clip directly or bundle it in .flashpkg / a linked local folder for offline playback.`,
  };
  return preLocalizeHttpsMedia(kind, urls, source, ctx, nowMs);
}

function extractHttpsImageUrlsFromSheetGrid(
  grid: readonly (readonly string[])[],
  noteType: NoteType,
  columnMap?: readonly SourceColumnMapping[],
): string[] {
  const headerRow = grid[0];
  if (!headerRow || headerRow.length === 0) return [];
  const headerMap = mapTabularHeaders(headerRow, noteType, columnMap);
  if (headerMap.imageColumnIndices.length === 0) return [];
  const urls = new Set<string>();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    for (const colIdx of headerMap.imageColumnIndices) {
      const rawCell = (row[colIdx] ?? '').trim();
      if (!rawCell) continue;
      const parsed = parseImageCellValue(rawCell, { allowRelativePath: false });
      if (parsed.value && /^https:\/\//i.test(parsed.value)) {
        urls.add(parsed.value);
      }
    }
  }
  return [...urls];
}

function extractHttpsAudioUrlsFromSheetGrid(
  grid: readonly (readonly string[])[],
  noteType: NoteType,
  columnMap?: readonly SourceColumnMapping[],
): string[] {
  const headerRow = grid[0];
  if (!headerRow || headerRow.length === 0) return [];
  const headerMap = mapTabularHeaders(headerRow, noteType, columnMap);
  if (headerMap.audioColumnIndices.length === 0) return [];
  const urls = new Set<string>();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    for (const colIdx of headerMap.audioColumnIndices) {
      const rawCell = (row[colIdx] ?? '').trim();
      if (!rawCell) continue;
      if (isStrictHttpsUrl(rawCell)) {
        urls.add(`https://${rawCell.slice(8)}`);
      }
    }
  }
  return [...urls];
}

function extractHttpsImageUrlsFromMarkdown(rawMarkdown: string): string[] {
  const urls = new Set<string>();
  for (const m of rawMarkdown.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/gi)) {
    if (m[1]) urls.add(`https://${m[1].slice(8)}`);
  }
  for (const m of rawMarkdown.matchAll(
    /::image\[[^\]]*\]\{[^}]*\bsrc=(?:"(https:\/\/[^"]+)"|'(https:\/\/[^']+)'|(https:\/\/[^\s}]+))/gi,
  )) {
    const u = m[1] ?? m[2] ?? m[3];
    if (u) urls.add(`https://${u.slice(8)}`);
  }
  return [...urls];
}

/**
 * Adds picked Google Sheets/Docs to the registry and immediately pulls their content.
 */
export async function linkPickedGoogleFiles(
  picked: readonly GooglePickedFile[],
  ctx: SourceRunContext,
  options?: {
    defaultNoteTypeId?: string;
    defaultLanguage?: string;
    /** Where each Sheet column goes (Bring my cards mapping step); saved on the deck's source. */
    columnMap?: SourceColumnMapping[];
  },
): Promise<SourceRefreshSummary> {
  return withSourcesLock(async () => {
    const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
    const toRefresh: LinkedGoogleSource[] = [];

    for (const file of picked) {
      const isSheet = file.mimeType === GOOGLE_SHEET_MIME;
      const isDoc = file.mimeType === GOOGLE_DOC_MIME;
      if (!isSheet && !isDoc) continue;

      const existing = registry.googleSources.find((s) => s.fileId === file.id);
      if (existing) {
        if (isSheet && options?.columnMap) existing.columnMap = options.columnMap;
        toRefresh.push(existing);
        continue;
      }

      const entry: LinkedGoogleSource = isSheet
        ? {
            id: `gsheet:${file.id}`,
            kind: 'google_sheets',
            fileId: file.id,
            name: file.name,
            uri: file.url || `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
            ...(options?.defaultNoteTypeId !== undefined
              ? { noteTypeId: options.defaultNoteTypeId }
              : {}),
            ...(options?.defaultLanguage !== undefined
              ? { language: options.defaultLanguage }
              : {}),
            ...(options?.columnMap ? { columnMap: options.columnMap } : {}),
            lastStatus: 'idle',
          }
        : {
            id: `gdoc:${file.id}`,
            kind: 'google_docs',
            fileId: file.id,
            name: file.name,
            uri: file.url || `https://docs.google.com/document/d/${file.id}/edit`,
            lastStatus: 'idle',
          };

      registry.googleSources.push(entry);
      toRefresh.push(entry);
    }

    let updatedSources = 0;
    let importedNotes = 0;
    let importedPages = 0;
    let warningsCount = 0;
    const errors: string[] = [];

    for (const src of toRefresh) {
      try {
        const res = await refreshSingleGoogleSource(src, ctx, {
          force: true,
          ...(options?.columnMap && src.kind === 'google_sheets'
            ? { columnMap: options.columnMap }
            : {}),
        });
        if (res.updated) updatedSources += 1;
        importedNotes += res.notesTouched;
        importedPages += res.pagesTouched;
        warningsCount += res.warnings.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        src.lastStatus = 'error';
        src.lastError = msg;
        errors.push(`${src.name}: ${msg}`);
      }
    }

    await saveSourcesRegistry(ctx.platform, registry);
    return {
      registry,
      updatedSources,
      importedNotes,
      importedPages,
      inboxImported: 0,
      warningsCount,
      pendingReconciliations: [],
      errors,
      skipped: [],
    };
  });
}

/**
 * Creates a new Google Sheet from a built-in Note Type template, links it, and runs the first pull.
 */
export async function createAndLinkGoogleSheetTemplate(
  options: { title: string; noteTypeId: string; language: string },
  ctx: SourceRunContext,
): Promise<{ source: LinkedGoogleSource; registry: SourcesRegistry; error?: string }> {
  return withSourcesLock(async () => {
    const state = ctx.getState();
    const noteType = resolveNoteType(state, options.noteTypeId);
    const headers = [...noteType.fields.map((f) => f.label), 'Tags', 'Card ID'];
    const sampleRow = [
      ...noteType.fields.map((_, idx) => (idx === 0 ? 'Example' : '')),
      'sample',
      '',
    ];

    const client = await ctx.platform.getGoogleSourcesClient();
    const created = await client.createSheetFromTemplate({
      title: options.title.trim() || 'Flashcards Deck',
      headers,
      sampleRows: [sampleRow],
    });

    const registry = await loadSourcesRegistry(ctx.platform, state);
    const source: LinkedGoogleSource = {
      id: `gsheet:${created.fileId}`,
      kind: 'google_sheets',
      fileId: created.fileId,
      name: created.title,
      uri: created.uri,
      sheetTab: created.sheetTitle,
      noteTypeId: noteType.id,
      language: options.language,
      readOnly: false,
      lastStatus: 'idle',
    };
    registry.googleSources.push(source);

    // The Sheet now exists in Drive: keep it linked even when the first pull fails, so the user
    // can refresh it later instead of finding an orphan Sheet there (C20).
    let error: string | undefined;
    try {
      await refreshSingleGoogleSource(source, ctx, { force: true });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      source.lastStatus = 'error';
      source.lastError = error;
    }
    await saveSourcesRegistry(ctx.platform, registry);
    return error === undefined ? { source, registry } : { source, registry, error };
  });
}

/**
 * A Sheet whose deck is archived is not refreshed (like a linked OneDrive file): the pull would
 * add and edit cards in a deck the user put away. The row says so until the deck is restored.
 */
function skipArchivedGoogleSheet(source: LinkedGoogleSource, state: CollectionState): boolean {
  if (source.kind !== 'google_sheets') return false;
  const deck = state.decks.get(
    source.deckId ?? uuidv5(FLASH_NAMESPACE_UUID, `gsheet:${source.fileId}`),
  );
  if (!deck?.archived) return false;
  source.lastStatus = 'idle';
  source.lastError = archivedDeckRefreshMessage(deck.name);
  source.skipReason = 'archived';
  return true;
}

/**
 * "Refresh all" while Google is disconnected: like the Drive file rows, each Sheet and Doc row
 * says why it was not refreshed, and the `name: why` lines go in the summary. A Sheet whose deck
 * is archived keeps saying so. A build without Google marks nothing.
 */
function markGoogleSourcesDisconnected(
  sources: readonly LinkedGoogleSource[],
  ctx: SourceRunContext,
): string[] {
  if (!ctx.platform.googleOAuthConfigured) return [];
  const state = ctx.getState();
  return sources.map((src) => {
    if (!skipArchivedGoogleSheet(src, state)) {
      src.lastStatus = 'permission_required';
      src.lastError = GOOGLE_RECONNECT_MESSAGE;
      delete src.skipReason;
    }
    return `${src.name}: ${src.lastError ?? GOOGLE_RECONNECT_MESSAGE}`;
  });
}

/**
 * Refreshes a single Google Sheet or Google Doc with cheap `modifiedTime` short-circuiting
 * and race-safe `Card ID` `batchUpdate` write-back (§3.1). A Sheet whose deck is archived is left
 * alone (`skipReason`).
 */
export async function refreshSingleGoogleSource(
  source: LinkedGoogleSource,
  ctx: SourceRunContext,
  opts?: {
    force?: boolean;
    /** A mapping just chosen for this Sheet: it replaces the one saved on the deck. */
    columnMap?: SourceColumnMapping[];
  },
): Promise<{
  updated: boolean;
  notesTouched: number;
  pagesTouched: number;
  warnings: SourceWarning[];
}> {
  if (!isOnline()) {
    source.lastStatus = 'offline';
    return { updated: false, notesTouched: 0, pagesTouched: 0, warnings: source.warnings ?? [] };
  }

  if (skipArchivedGoogleSheet(source, ctx.getState())) {
    return { updated: false, notesTouched: 0, pagesTouched: 0, warnings: source.warnings ?? [] };
  }

  const client = await ctx.platform.getGoogleSourcesClient();
  const nowMs = Date.now();

  // Cheap Drive `modifiedTime` check on open/refresh (§3.1)
  if (!opts?.force && source.lastModifiedTime && (source.deckId || source.pageId)) {
    const meta = await client.getFileMetadata(source.fileId);
    if (meta.modifiedTime && meta.modifiedTime === source.lastModifiedTime) {
      source.lastSyncedAt = nowMs;
      source.lastStatus = 'synced';
      delete source.lastError;
      delete source.skipReason;
      return { updated: false, notesTouched: 0, pagesTouched: 0, warnings: source.warnings ?? [] };
    }
  }

  const state = ctx.getState();
  const factory = ctx.getEventFactory();

  if (source.kind === 'google_docs') {
    const exported = await client.exportDocAsMarkdown(source.fileId);
    const docImageUrls = extractHttpsImageUrlsFromMarkdown(exported.markdown);
    const localized = await preLocalizeHttpsImageUrls(docImageUrls, source, ctx, nowMs);
    const pageRes = normalizeMarkdownPage({
      sourceKey: `gdoc:${source.fileId}`,
      fallbackTitle: exported.title || source.name,
      rawMarkdown: exported.markdown,
      source: {
        kind: 'google_docs',
        uri: source.uri,
        external_id: source.fileId,
        last_synced_at: nowMs,
      },
      state,
      eventFactory: factory,
      mediaPathMap: localized.mediaPathMap,
      nowMs,
    });

    const allPageEvents = [...localized.mediaEvents, ...pageRes.events];
    if (allPageEvents.length > 0) {
      ctx.emitEvents(allPageEvents);
    }

    source.name = exported.title || source.name;
    source.pageId = pageRes.pageId;
    if (exported.modifiedTime) source.lastModifiedTime = exported.modifiedTime;
    source.lastSyncedAt = nowMs;
    source.lastStatus = 'synced';
    delete source.lastError;
    source.warnings = [
      ...pageRes.warnings.map((w) => ({ code: w.code, message: w.message })),
      ...localized.warnings,
    ];

    return {
      updated: pageRes.changed,
      notesTouched: 0,
      pagesTouched: pageRes.changed ? 1 : 0,
      warnings: source.warnings,
    };
  }

  // Google Sheets pull
  const grid = await client.readSheet(source.fileId, source.sheetTab);
  const deckId = source.deckId ?? uuidv5(FLASH_NAMESPACE_UUID, `gsheet:${source.fileId}`);
  const existingDeck = state.decks.get(deckId);
  const inferred = inferPresetNoteTypeId(
    grid.values[0] ?? [],
    source.noteTypeId ?? BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
    grid.values.slice(1),
  );
  const noteType = resolveNoteType(
    state,
    existingDeck?.note_type_id ?? source.noteTypeId ?? inferred.noteTypeId,
  );
  const language = existingDeck?.language ?? source.language ?? inferred.language;
  // A mapping chosen now, else the deck's synced one, else the copy kept when it was linked.
  const columnMap = opts?.columnMap ?? existingDeck?.source?.column_map ?? source.columnMap;

  // Option 1: pre-localize remote https: images & audio BEFORE diffing so MediaAdded has strictly ascending seq
  // and unchanged rows reuse cached media:<sha256> without re-fetching or emitting redundant diffs.
  const sheetImageUrls = extractHttpsImageUrlsFromSheetGrid(grid.values, noteType, columnMap);
  const localizedSheetImages = await preLocalizeHttpsImageUrls(sheetImageUrls, source, ctx, nowMs);
  const sheetAudioUrls = extractHttpsAudioUrlsFromSheetGrid(grid.values, noteType, columnMap);
  const localizedSheetAudio = await preLocalizeHttpsAudioUrls(sheetAudioUrls, source, ctx, nowMs);

  const mergedSheetMediaPathMap: Record<string, string> = {
    ...localizedSheetImages.mediaPathMap,
    ...localizedSheetAudio.mediaPathMap,
  };
  const localizedSheetMediaEvents: KnownEvent[] = [
    ...localizedSheetImages.mediaEvents,
    ...localizedSheetAudio.mediaEvents,
  ];
  const localizedSheetMediaWarnings: SourceWarning[] = [
    ...localizedSheetImages.warnings,
    ...localizedSheetAudio.warnings,
  ];

  const canWriteBack = !grid.readOnly;
  let diff = diffTabularSource({
    deckId,
    noteType,
    state,
    eventFactory: factory,
    grid: grid.values,
    identityMode: 'card_id',
    canWriteBack,
    mediaPathMap: mergedSheetMediaPathMap,
    embeddedImageRows: grid.embeddedImageRows,
    ...(columnMap ? { columnMap } : {}),
    nowMs,
  });

  const extraWarnings: SourceWarning[] = [...localizedSheetMediaWarnings];
  let droppedRacedNoteIds = new Set<string>();

  // Race-safe `Card ID` write-back (§3.1): re-read range right before `values:batchUpdate`
  if (canWriteBack && diff.writeBackPlan.cells.length > 0) {
    try {
      const freshGrid = await client.readSheet(source.fileId, grid.sheetTitle);
      const guarded = filterSafeWriteBackCells(
        diff.writeBackPlan,
        freshGrid.values,
        noteType,
        columnMap,
      );

      if (guarded.skippedCells.length > 0) {
        // Drop raced rows from this pull so the Sheet's winning Card ID is adopted on the next pull
        droppedRacedNoteIds = new Set(
          guarded.skippedCells
            .map((s) => diff.rowToNoteId[s.cell.rowNumber])
            .filter((id): id is string => Boolean(id)),
        );
        extraWarnings.push({
          code: 'writeback_raced',
          message: `Skipped ${guarded.skippedCells.length} Card ID write-back cell(s) because the Sheet changed concurrently; refresh again to adopt the Sheet's IDs.`,
        });
      }

      const updates: Array<{ a1: string; value: string }> = [];
      if (guarded.headerUpdate) {
        updates.push(guarded.headerUpdate);
      }
      for (const cell of guarded.safeCells) {
        updates.push({ a1: cell.a1, value: cell.newCardId });
      }
      if (updates.length > 0) {
        // Keep the first read's `modifiedTime` (D9). A post-write time would also cover Sheet
        // edits made after that read, and the next refresh would short-circuit past them. The
        // cost is one extra full pull after our own Card ID write.
        await client.writeSheetCells(source.fileId, grid.sheetTitle, updates);
      }
    } catch (writeErr) {
      if (isSyncTransportError(writeErr) && writeErr.code === 'PERMISSION_DENIED') {
        // Shared view-only sheet: gracefully switch to read-only diff. Nothing was written, so
        // the race check's dropped rows and warning belong to the discarded diff (C20).
        grid.readOnly = true;
        droppedRacedNoteIds = new Set();
        const raced = extraWarnings.findIndex((w) => w.code === 'writeback_raced');
        if (raced !== -1) extraWarnings.splice(raced, 1);
        diff = diffTabularSource({
          deckId,
          noteType,
          state,
          eventFactory: factory,
          grid: grid.values,
          identityMode: 'card_id',
          canWriteBack: false,
          mediaPathMap: mergedSheetMediaPathMap,
          embeddedImageRows: grid.embeddedImageRows,
          ...(columnMap ? { columnMap } : {}),
          nowMs,
        });
      } else {
        throw writeErr;
      }
    }
  }

  const events: KnownEvent[] = [...localizedSheetMediaEvents];
  const sourceRef = {
    kind: 'google_sheets' as const,
    uri: source.uri,
    external_id: source.fileId,
    sheet_tab: grid.sheetTitle,
    read_only: grid.readOnly,
    last_synced_at: nowMs,
    ...(columnMap ? { column_map: [...columnMap] } : {}),
  };

  if (!existingDeck) {
    events.push(
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: grid.title || source.name,
          note_type_id: noteType.id,
          language,
          source: sourceRef,
          created_at: nowMs,
        },
        nowMs,
      ),
    );
  } else {
    events.push(
      factory.create(
        'SourceLinked',
        {
          target_kind: 'deck',
          target_id: deckId,
          source: sourceRef,
        },
        nowMs,
      ),
    );
  }

  for (const ev of diff.events) {
    if (
      droppedRacedNoteIds.size > 0 &&
      ev.type === 'NoteUpserted' &&
      droppedRacedNoteIds.has(ev.payload.note_id)
    ) {
      continue;
    }
    events.push(ev);
  }

  if (events.length > 0) {
    ctx.emitEvents(events);
  }

  source.name = grid.title || source.name;
  source.deckId = deckId;
  source.noteTypeId = noteType.id;
  source.language = language;
  source.sheetTab = grid.sheetTitle;
  if (columnMap) source.columnMap = [...columnMap];
  source.readOnly = grid.readOnly;
  if (grid.modifiedTime) source.lastModifiedTime = grid.modifiedTime;
  source.lastSyncedAt = nowMs;
  source.lastStatus = 'synced';
  delete source.lastError;
  delete source.skipReason;
  source.warnings = [
    ...diff.warnings.map((w) => ({
      code: w.code,
      message: w.message,
      ...(w.row !== undefined ? { row: w.row } : {}),
      ...(w.header !== undefined ? { header: w.header } : {}),
    })),
    ...extraWarnings,
  ];

  const notesTouched =
    diff.stats.added + diff.stats.updated + diff.stats.archived + diff.stats.restored;
  return {
    updated: !existingDeck || notesTouched > 0,
    notesTouched,
    pagesTouched: 0,
    warnings: source.warnings,
  };
}

/**
 * Links a new PC local folder via File System Access API and immediately scans it (§3.2).
 */
export async function linkAndScanLocalFolder(
  ctx: SourceRunContext,
): Promise<{ folder: LinkedLocalFolder | null; summary?: SourceRefreshSummary }> {
  return withSourcesLock(async () => {
    const adapter = await ctx.platform.getLocalFolderSources();
    const picked = await adapter.pickFolder();
    if (!picked) return { folder: null };

    const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
    const folder: LinkedLocalFolder = {
      id: picked.id,
      name: picked.name,
      addedAt: Date.now(),
      writeCardIds: true,
      lastStatus: 'idle',
      files: {},
      inboxImported: {},
    };
    registry.localFolders.push(folder);

    const scanRes = await scanSingleLocalFolder(folder, ctx, { requestPermission: true });
    await saveSourcesRegistry(ctx.platform, registry);

    return {
      folder,
      summary: {
        registry,
        updatedSources: scanRes.updated ? 1 : 0,
        importedNotes: scanRes.notesTouched,
        importedPages: scanRes.pagesTouched,
        inboxImported: scanRes.inboxImported,
        warningsCount: (folder.warnings ?? []).length,
        pendingReconciliations: scanRes.pendingReconciliations,
        errors: scanRes.error ? [scanRes.error] : [],
        skipped: [],
      },
    };
  });
}

/**
 * Scans a linked PC local folder (.csv/.tsv, .xlsx via lazy read-excel-file, .md, .flashpkg,
 * relative media, and `Inbox/` auto-import) using `lastModified`/content-hash caching (§3.2, §10.3).
 */
export async function scanSingleLocalFolder(
  folder: LinkedLocalFolder,
  ctx: SourceRunContext,
  opts?: {
    requestPermission?: boolean;
    force?: boolean;
    xlsxRenameMaps?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  },
): Promise<{
  updated: boolean;
  notesTouched: number;
  pagesTouched: number;
  inboxImported: number;
  pendingReconciliations: PendingXlsxReconciliation[];
  error?: string;
}> {
  const adapter = await ctx.platform.getLocalFolderSources();
  const nowMs = Date.now();
  const pendingReconciliations: PendingXlsxReconciliation[] = [];
  const warnings: SourceWarning[] = [];

  try {
    const canRead = await adapter.ensurePermission(
      folder.id,
      'read',
      Boolean(opts?.requestPermission),
    );
    if (!canRead) {
      folder.lastStatus = 'permission_required';
      folder.lastError = `Permission needed to access "${folder.name}". Click Reconnect Folder.`;
      return {
        updated: false,
        notesTouched: 0,
        pagesTouched: 0,
        inboxImported: 0,
        pendingReconciliations,
        error: folder.lastError,
      };
    }

    const canWrite = await adapter.ensurePermission(
      folder.id,
      'readwrite',
      Boolean(opts?.requestPermission && folder.writeCardIds),
    );

    const files = await adapter.listFolderFiles(folder.id);
    // Decks this scan created; `ctx.getState()` may not show them yet (C14).
    const scanDecks = new Set<string>();
    const overDeckLimit = (state: CollectionState, ids: readonly string[], file: string) => {
      const reason = deckLimitReason(ctx.entitlement, state, ids, scanDecks);
      if (reason) warnings.push({ code: 'deck_limit', message: reason, file });
      else for (const id of ids) scanDecks.add(id);
      return reason !== undefined;
    };
    let notesTouched = 0;
    let pagesTouched = 0;
    let inboxImported = 0;
    let updated = false;

    for (const file of files) {
      const state = ctx.getState();
      const factory = ctx.getEventFactory();

      // 1. Inbox/*.flashpkg auto-import (§10.3)
      if (file.isInbox) {
        const bytes = await adapter.readFileBytes(folder.id, file.relativePath);
        const contentHash = sha256Hex(bytes);
        const already = folder.inboxImported[file.name];
        if (already && already.contentHash === contentHash && !opts?.force) {
          continue;
        }

        const pkgRes = importFlashpkg(bytes, state, factory, {
          nowMs,
          sourceOverride: {
            kind: 'package',
            external_id: `${folder.id}:${file.relativePath}`,
          },
        });
        // Left in Inbox (and not recorded) so it imports once there's room.
        if (overDeckLimit(state, newDeckIds(state, pkgRes.events, scanDecks), file.relativePath)) {
          continue;
        }
        // Files one at a time: each package checks the deck limit against the state so far.
        await putMediaListTracked(ctx.platform.storage, pkgRes.extractedMedia); // NOSONAR (S9382)
        if (pkgRes.events.length > 0) {
          ctx.emitEvents(pkgRes.events);
        }
        for (const w of pkgRes.warnings) {
          warnings.push({ code: w.code, message: w.message, file: file.relativePath });
        }

        const moved = canWrite
          ? await adapter.moveInboxFileToImported(folder.id, file.name)
          : false;
        folder.inboxImported[file.name] = {
          fileName: file.name,
          contentHash,
          importedAt: nowMs,
          movedToImported: moved,
        };
        inboxImported += 1;
        notesTouched += pkgRes.notesImported;
        pagesTouched += pkgRes.pagesImported;
        updated = true;
        continue;
      }

      const cached = folder.files[file.relativePath];
      const hasRenameMap = Boolean(opts?.xlsxRenameMaps?.[file.relativePath]);

      // Skip unchanged file by (lastModified, size) unless forced or reconciling .xlsx renames
      if (
        !opts?.force &&
        !hasRenameMap &&
        cached &&
        cached.lastModified === file.lastModified &&
        cached.size === file.size
      ) {
        continue;
      }

      // An `.xlsx` this device can't read is left alone before reading it, like a linked cloud
      // file. It isn't cached, so a later scan tries again.
      if (file.kind === 'xlsx' && adapter.canParseXlsx?.() === false) {
        warnings.push({
          code: 'xlsx_unreadable',
          message: excelUnreadableMessage(file.name),
          file: file.relativePath,
        });
        continue;
      }

      const bytes = await adapter.readFileBytes(folder.id, file.relativePath);
      const contentHash = sha256Hex(bytes);

      if (!opts?.force && !hasRenameMap && cached && cached.contentHash === contentHash) {
        cached.lastModified = file.lastModified;
        cached.size = file.size;
        continue;
      }

      // 2. .flashpkg package in folder
      if (file.kind === 'flashpkg') {
        const pkgRes = importFlashpkg(bytes, state, factory, {
          nowMs,
          sourceOverride: {
            kind: 'package',
            external_id: `${folder.id}:${file.relativePath}`,
          },
          archiveRemovedOnUpgrade: true,
        });
        // Not cached, so the next scan tries again.
        if (overDeckLimit(state, newDeckIds(state, pkgRes.events, scanDecks), file.relativePath)) {
          continue;
        }
        // Files one at a time: each package checks the deck limit against the state so far.
        await putMediaListTracked(ctx.platform.storage, pkgRes.extractedMedia); // NOSONAR (S9382)
        if (pkgRes.events.length > 0) {
          ctx.emitEvents(pkgRes.events);
        }
        for (const w of pkgRes.warnings) {
          warnings.push({ code: w.code, message: w.message, file: file.relativePath });
        }
        folder.files[file.relativePath] = {
          relativePath: file.relativePath,
          kind: 'flashpkg',
          lastModified: file.lastModified,
          size: file.size,
          contentHash,
          packageId: pkgRes.manifest.package_id,
        };
        notesTouched += pkgRes.notesImported;
        pagesTouched += pkgRes.pagesImported;
        updated = true;
        continue;
      }

      // 3. .md Markdown Page
      if (file.kind === 'md') {
        const rawMd = decodeUtf8(bytes);
        const fallbackTitle = file.name.replace(/\.md$/i, '');
        const probe = normalizeMarkdownPage({
          sourceKey: `local:${folder.id}:${file.relativePath}`,
          fallbackTitle,
          rawMarkdown: rawMd,
          source: {
            kind: 'local_file',
            external_id: `${folder.id}:${file.relativePath}`,
          },
          state,
          eventFactory: factory,
          allowRelativeMediaPaths: true,
          nowMs,
        });

        // Ingest referenced relative media
        const mediaPathMap: Record<string, string> = {};
        const mediaEvents: KnownEvent[] = [];
        for (const relMedia of probe.referencedRelativeMediaPaths) {
          const loaded = await adapter.readRelativeMedia(folder.id, file.relativePath, relMedia);
          if (!loaded) continue;
          const mHash = sha256Hex(loaded.bytes);
          const blob = { hash: mHash, mime: loaded.mime, bytes: loaded.bytes };
          // One file at a time, right after it is fetched or read.
          await putMediaTracked(ctx.platform.storage, blob); // NOSONAR (S9382)
          mediaPathMap[relMedia] = `media:${mHash}`;
          if (!state.media.has(mHash)) {
            mediaEvents.push(
              factory.create(
                'MediaAdded',
                {
                  media: {
                    hash: mHash,
                    ext: loaded.ext,
                    mime: loaded.mime,
                    size: loaded.bytes.byteLength,
                  },
                },
                nowMs,
              ),
            );
          }
        }

        const finalPage =
          Object.keys(mediaPathMap).length > 0
            ? normalizeMarkdownPage({
                sourceKey: `local:${folder.id}:${file.relativePath}`,
                fallbackTitle,
                rawMarkdown: rawMd,
                source: {
                  kind: 'local_file',
                  external_id: `${folder.id}:${file.relativePath}`,
                },
                state,
                eventFactory: factory,
                allowRelativeMediaPaths: true,
                mediaPathMap,
                nowMs,
              })
            : probe;

        const pageEvents = [...mediaEvents, ...finalPage.events];
        if (pageEvents.length > 0) {
          ctx.emitEvents(pageEvents);
        }
        for (const w of finalPage.warnings) {
          warnings.push({ code: w.code, message: w.message, file: file.relativePath });
        }

        folder.files[file.relativePath] = {
          relativePath: file.relativePath,
          kind: 'md',
          lastModified: file.lastModified,
          size: file.size,
          contentHash,
          pageId: finalPage.pageId,
        };
        if (finalPage.changed) {
          pagesTouched += 1;
          updated = true;
        }
        continue;
      }

      // 4. Tabular files: .csv, .tsv, or read-only .xlsx
      // A file whose deck is archived is left alone, like linked Sheets and OneDrive files. The
      // cache isn't updated, so the file is read again once the deck is restored.
      const tabularDeck = state.decks.get(
        cached?.deckId ?? uuidv5(FLASH_NAMESPACE_UUID, `local:${folder.id}:${file.relativePath}`),
      );
      if (tabularDeck?.archived) {
        warnings.push({
          code: 'deck_archived',
          message: archivedDeckRefreshMessage(tabularDeck.name),
          file: file.relativePath,
        });
        continue;
      }
      const isXlsx = file.kind === 'xlsx';
      let grid: string[][];
      let delimiter: ',' | '\t' = file.kind === 'tsv' ? '\t' : ',';

      if (isXlsx) {
        grid = await adapter.parseXlsxBytes(bytes);
      } else {
        const parsed = parseDelimitedText(decodeUtf8(bytes), { delimiter });
        delimiter = parsed.delimiter;
        grid = parsed.headers.length > 0 ? [parsed.headers, ...parsed.rows] : [];
      }

      if (grid.length === 0) continue;

      const deckName = file.name.replace(/\.(csv|tsv|xlsx)$/i, '');
      const deckId =
        cached?.deckId ?? uuidv5(FLASH_NAMESPACE_UUID, `local:${folder.id}:${file.relativePath}`);
      const existingDeck = state.decks.get(deckId);
      // A new file's deck: checked before any Card ID write-back touches the file.
      if (!existingDeck && !scanDecks.has(deckId)) {
        if (overDeckLimit(state, [deckId], file.relativePath)) continue;
      }
      const inferred = inferPresetNoteTypeId(
        grid[0] ?? [],
        cached?.noteTypeId ?? BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        grid.slice(1),
      );
      const noteType = resolveNoteType(
        state,
        existingDeck?.note_type_id ?? cached?.noteTypeId ?? inferred.noteTypeId,
      );
      const language = existingDeck?.language ?? cached?.language ?? inferred.language;
      const renameMap = opts?.xlsxRenameMaps?.[file.relativePath];

      // First pass to discover any relative media paths
      const allowCsvWriteBack = !isXlsx && folder.writeCardIds && canWrite;
      let diff = diffTabularSource({
        deckId,
        noteType,
        state,
        eventFactory: factory,
        grid,
        identityMode: isXlsx ? 'sort_key' : 'card_id',
        canWriteBack: allowCsvWriteBack,
        allowRelativeMediaPaths: true,
        ...(renameMap !== undefined ? { renameMap } : {}),
        nowMs,
      });

      const mediaEvents: KnownEvent[] = [];
      if (diff.referencedRelativeMediaPaths.length > 0) {
        const mediaPathMap: Record<string, string> = {};
        for (const relMedia of diff.referencedRelativeMediaPaths) {
          const loaded = await adapter.readRelativeMedia(folder.id, file.relativePath, relMedia);
          if (!loaded) continue;
          const mHash = sha256Hex(loaded.bytes);
          const blob = { hash: mHash, mime: loaded.mime, bytes: loaded.bytes };
          // One file at a time, right after it is fetched or read.
          await putMediaTracked(ctx.platform.storage, blob); // NOSONAR (S9382)
          mediaPathMap[relMedia] = `media:${mHash}`;
          if (!state.media.has(mHash)) {
            mediaEvents.push(
              factory.create(
                'MediaAdded',
                {
                  media: {
                    hash: mHash,
                    ext: loaded.ext,
                    mime: loaded.mime,
                    size: loaded.bytes.byteLength,
                  },
                },
                nowMs,
              ),
            );
          }
        }
        if (Object.keys(mediaPathMap).length > 0) {
          diff = diffTabularSource({
            deckId,
            noteType,
            state,
            eventFactory: factory,
            grid,
            identityMode: isXlsx ? 'sort_key' : 'card_id',
            canWriteBack: allowCsvWriteBack,
            allowRelativeMediaPaths: true,
            mediaPathMap,
            ...(renameMap !== undefined ? { renameMap } : {}),
            nowMs,
          });
        }
      }

      // If `.xlsx` has potential renames and user hasn't reconciled yet, defer applying until user resolves
      if (isXlsx && diff.reconciliationCandidates && !renameMap) {
        pendingReconciliations.push({
          folderId: folder.id,
          relativePath: file.relativePath,
          deckId,
          deckName: existingDeck?.name ?? deckName,
          missingNotes: diff.reconciliationCandidates.missingNotes,
          addedRows: diff.reconciliationCandidates.addedRows,
        });
        continue;
      }

      // Optional `.csv`/`.tsv` Card ID write-back when folder has write permission
      let finalHash = contentHash;
      let finalSize = file.size;
      let finalMtime = file.lastModified;
      if (allowCsvWriteBack && diff.writeBackPlan.cells.length > 0) {
        const guarded = filterSafeWriteBackCells(diff.writeBackPlan, grid, noteType);
        if (guarded.safeCells.length > 0) {
          const nextText = applyCardIdsToGridAndSerialize(
            grid,
            delimiter,
            guarded,
            diff.writeBackPlan,
          );
          await adapter.writeFileText(folder.id, file.relativePath, nextText);
          finalHash = sha256String(nextText);
          finalSize = new TextEncoder().encode(nextText).byteLength;
          finalMtime = Date.now();
        }
      }

      const events: KnownEvent[] = [...mediaEvents];
      const sourceRef = {
        kind: 'local_file' as const,
        external_id: `${folder.id}:${file.relativePath}`,
        read_only: isXlsx || !allowCsvWriteBack,
        content_hash: finalHash,
        last_synced_at: nowMs,
      };
      if (!existingDeck) {
        events.push(
          factory.create(
            'DeckCreated',
            {
              deck_id: deckId,
              name: deckName,
              note_type_id: noteType.id,
              language,
              source: sourceRef,
              created_at: nowMs,
            },
            nowMs,
          ),
        );
      } else {
        events.push(
          factory.create(
            'SourceLinked',
            {
              target_kind: 'deck',
              target_id: deckId,
              source: sourceRef,
            },
            nowMs,
          ),
        );
      }
      events.push(...diff.events);

      if (events.length > 0) {
        ctx.emitEvents(events);
      }
      for (const w of diff.warnings) {
        warnings.push({
          code: w.code,
          message: w.message,
          file: file.relativePath,
          ...(w.row !== undefined ? { row: w.row } : {}),
          ...(w.header !== undefined ? { header: w.header } : {}),
        });
      }

      const fileEntry: CachedLocalFileEntry = {
        relativePath: file.relativePath,
        kind: file.kind,
        lastModified: finalMtime,
        size: finalSize,
        contentHash: finalHash,
        deckId,
        noteTypeId: noteType.id,
        language,
      };
      folder.files[file.relativePath] = fileEntry;
      notesTouched +=
        diff.stats.added + diff.stats.updated + diff.stats.archived + diff.stats.restored;
      updated = true;
    }

    folder.lastScannedAt = nowMs;
    folder.lastStatus = 'synced';
    delete folder.lastError;
    folder.warnings = warnings;

    return {
      updated,
      notesTouched,
      pagesTouched,
      inboxImported,
      pendingReconciliations,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    folder.lastStatus =
      isSyncTransportError(err) && err.code === 'PERMISSION_DENIED'
        ? 'permission_required'
        : 'error';
    folder.lastError = msg;
    return {
      updated: false,
      notesTouched: 0,
      pagesTouched: 0,
      inboxImported: 0,
      pendingReconciliations,
      error: msg,
    };
  }
}

/**
 * Subscribes to a `.flashpkg` HTTPS URL and immediately downloads & imports it (§3.4).
 */
export async function subscribeToPackageUrl(
  rawUrl: string,
  ctx: SourceRunContext,
  meta?: { title?: string; packageId?: string; expectedSha256?: string; catalogUrl?: string },
): Promise<{ subscription: PackageSubscription; registry: SourcesRegistry }> {
  return withSourcesLock(async () => {
    const safeUrl = assertSafeHttpsUrl(rawUrl);
    const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
    let sub = registry.packageSubscriptions.find((s) => s.url === safeUrl);
    if (!sub) {
      sub = {
        id: `pkgurl:${uuidv5(FLASH_NAMESPACE_UUID, safeUrl)}`,
        url: safeUrl,
        title: meta?.title || safeUrl.split('/').pop() || 'Subscribed Package',
        ...(meta?.packageId !== undefined ? { packageId: meta.packageId } : {}),
        ...(meta?.expectedSha256 !== undefined ? { expectedSha256: meta.expectedSha256 } : {}),
        ...(meta?.catalogUrl !== undefined ? { catalogUrl: meta.catalogUrl } : {}),
        lastStatus: 'idle',
      };
      registry.packageSubscriptions.push(sub);
    } else if (meta?.expectedSha256) {
      sub.expectedSha256 = meta.expectedSha256;
    }

    await refreshSinglePackageSubscription(sub, ctx, { force: true });
    await saveSourcesRegistry(ctx.platform, registry);
    return { subscription: sub, registry };
  });
}

/**
 * Checks a subscribed `.flashpkg` HTTPS URL via ETag/Last-Modified and imports upgrades preserving reviews (§3.4).
 */
export async function refreshSinglePackageSubscription(
  sub: PackageSubscription,
  ctx: SourceRunContext,
  opts?: { force?: boolean },
): Promise<{ updated: boolean; notesTouched: number; pagesTouched: number }> {
  if (!isOnline()) {
    sub.lastStatus = 'offline';
    return { updated: false, notesTouched: 0, pagesTouched: 0 };
  }

  const fetcher = await ctx.platform.getPackageFetcher();
  const fetched = await fetcher.fetchPackage(sub.url, {
    ...(!opts?.force && sub.etag ? { etag: sub.etag } : {}),
    ...(!opts?.force && sub.lastModified ? { lastModified: sub.lastModified } : {}),
  });

  const nowMs = Date.now();
  if (fetched.notModified) {
    sub.lastSyncedAt = nowMs;
    sub.lastStatus = 'synced';
    delete sub.lastError;
    return { updated: false, notesTouched: 0, pagesTouched: 0 };
  }

  if (sub.expectedSha256) {
    const actualSha = sha256Hex(fetched.bytes);
    if (actualSha.toLowerCase() !== sub.expectedSha256.toLowerCase()) {
      throw new Error(
        `Package SHA-256 mismatch for "${sub.title}": expected ${sub.expectedSha256}, got ${actualSha}.`,
      );
    }
  }

  const state = ctx.getState();
  const pkgRes = importFlashpkg(fetched.bytes, state, ctx.getEventFactory(), {
    nowMs,
    sourceOverride: {
      kind: 'package_url',
      uri: sub.url,
    },
    archiveRemovedOnUpgrade: true,
  });
  const overLimit = deckLimitReason(ctx.entitlement, state, newDeckIds(state, pkgRes.events));
  if (overLimit) throw new Error(overLimit);

  await putMediaListTracked(ctx.platform.storage, pkgRes.extractedMedia);
  if (pkgRes.events.length > 0) {
    ctx.emitEvents(pkgRes.events);
  }

  sub.title = pkgRes.manifest.name;
  sub.packageId = pkgRes.manifest.package_id;
  sub.version = pkgRes.manifest.version;
  if (fetched.etag) sub.etag = fetched.etag;
  if (fetched.lastModified) sub.lastModified = fetched.lastModified;
  sub.lastSyncedAt = nowMs;
  sub.lastStatus = 'synced';
  delete sub.lastError;
  sub.warnings = pkgRes.warnings.map((w) => ({ code: w.code, message: w.message }));

  return {
    updated: true,
    notesTouched: pkgRes.notesImported,
    pagesTouched: pkgRes.pagesImported,
  };
}

/**
 * Subscribes to or refreshes a Family Library `index.json` catalog URL (§3.4).
 */
export async function subscribeToFamilyCatalog(
  rawUrl: string,
  ctx: SourceRunContext,
): Promise<{ catalog: FamilyCatalogSubscription; registry: SourcesRegistry }> {
  return withSourcesLock(async () => {
    const safeUrl = assertSafeHttpsUrl(rawUrl);
    const fetcher = await ctx.platform.getPackageFetcher();
    const fetched = await fetcher.fetchCatalog(safeUrl);
    if (fetched.notModified) {
      const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
      const existing = registry.catalogs.find((c) => c.url === safeUrl);
      if (existing) return { catalog: existing, registry };
      throw new Error('Catalog returned 304 Not Modified without cached copy.');
    }

    const validated = parseAndValidateFamilyCatalog(fetched.rawJson);
    const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
    const nowMs = Date.now();
    const packages: CatalogPackageInfo[] = validated.packages.map((p) => ({
      package_id: p.package_id,
      title: p.title,
      url: p.url,
      version: p.version,
      languages: [...p.languages],
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.updated_at !== undefined ? { updated_at: p.updated_at } : {}),
      ...(p.author !== undefined ? { author: p.author } : {}),
      ...(p.sha256 !== undefined ? { sha256: p.sha256 } : {}),
    }));

    const existingIdx = registry.catalogs.findIndex((c) => c.url === safeUrl);
    const catalog: FamilyCatalogSubscription = {
      id: `catalog:${uuidv5(FLASH_NAMESPACE_UUID, safeUrl)}`,
      url: safeUrl,
      name: validated.name,
      ...(validated.description !== undefined ? { description: validated.description } : {}),
      ...(validated.updated_at !== undefined ? { updatedAt: validated.updated_at } : {}),
      ...(fetched.etag !== undefined ? { etag: fetched.etag } : {}),
      lastFetchedAt: nowMs,
      packages,
    };

    if (existingIdx >= 0) {
      registry.catalogs[existingIdx] = catalog;
    } else {
      registry.catalogs.push(catalog);
    }

    await saveSourcesRegistry(ctx.platform, registry);
    return { catalog, registry };
  });
}

/**
 * Refreshes all linked sources (Google Sheets/Docs when online & signed in, Local Folders offline/online,
 * Family Catalogs, and subscribed `.flashpkg` URLs).
 */
export async function refreshAllSources(
  ctx: SourceRunContext,
  opts?: { requestFolderPermission?: boolean; force?: boolean },
): Promise<SourceRefreshSummary> {
  return withSourcesLock(async () => {
    const registry = await loadSourcesRegistry(ctx.platform, ctx.getState());
    let updatedSources = 0;
    let importedNotes = 0;
    let importedPages = 0;
    let inboxImported = 0;
    let warningsCount = 0;
    const pendingReconciliations: PendingXlsxReconciliation[] = [];
    const errors: string[] = [];
    const skipped: string[] = [];

    // 1. Local Folders (works fully offline!)
    for (const folder of registry.localFolders) {
      const res = await scanSingleLocalFolder(folder, ctx, {
        ...(opts?.requestFolderPermission !== undefined
          ? { requestPermission: opts.requestFolderPermission }
          : {}),
        ...(opts?.force !== undefined ? { force: opts.force } : {}),
      });
      if (res.updated) updatedSources += 1;
      importedNotes += res.notesTouched;
      importedPages += res.pagesTouched;
      inboxImported += res.inboxImported;
      warningsCount += (folder.warnings ?? []).length;
      pendingReconciliations.push(...res.pendingReconciliations);
      if (res.error) errors.push(`${folder.name}: ${res.error}`);
    }

    // 2. Google Sheets & Docs, and linked Google Drive files (online + connected)
    const driveFiles = registry.googleDriveFiles ?? [];
    if (isOnline() && (registry.googleSources.length > 0 || driveFiles.length > 0)) {
      let googleConnected: boolean;
      try {
        const auth = await ctx.platform.getGoogleAuth();
        googleConnected = await auth.isConnected();
      } catch {
        googleConnected = false;
      }

      if (googleConnected) {
        for (const src of registry.googleSources) {
          try {
            const res = await refreshSingleGoogleSource(src, ctx, {
              ...(opts?.force !== undefined ? { force: opts.force } : {}),
            });
            if (res.updated) updatedSources += 1;
            importedNotes += res.notesTouched;
            importedPages += res.pagesTouched;
            warningsCount += res.warnings.length;
            if (src.skipReason) skipped.push(`${src.name}: ${src.lastError ?? 'not refreshed'}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            src.lastStatus = 'error';
            src.lastError = msg;
            errors.push(`${src.name}: ${msg}`);
          }
        }
        if (driveFiles.length > 0) {
          const gd = await refreshLinkedGoogleDriveFiles(driveFiles, ctx, opts?.force);
          updatedSources += gd.updatedSources;
          importedNotes += gd.importedNotes;
          warningsCount += gd.warningsCount;
          pendingReconciliations.push(...gd.pendingReconciliations);
          errors.push(...gd.errors);
          skipped.push(...gd.skipped);
        }
      } else {
        // Each Sheet, Doc and Drive file row says it was not refreshed and why.
        skipped.push(
          ...markGoogleSourcesDisconnected(registry.googleSources, ctx),
          ...markGoogleDriveFilesDisconnected(driveFiles, ctx),
        );
      }
    }

    // 3. Linked OneDrive files (online; skipped until the user has allowed OneDrive file access)
    if (isOnline() && ctx.platform.oneDriveConfigured) {
      const od = await refreshCloudFiles(
        ONEDRIVE_FILES,
        registry.oneDriveSources ?? [],
        ctx,
        opts?.force,
      );
      updatedSources += od.updatedSources;
      importedNotes += od.importedNotes;
      warningsCount += od.warningsCount;
      pendingReconciliations.push(...od.pendingReconciliations);
      errors.push(...od.errors);
      skipped.push(...od.skipped);
    }

    // 3b. Linked Dropbox App Folder files (online; skipped until Dropbox is connected)
    if (isOnline() && ctx.platform.dropboxConfigured) {
      const dbx = await refreshCloudFiles(
        DROPBOX_FILES,
        registry.dropboxSources ?? [],
        ctx,
        opts?.force,
      );
      updatedSources += dbx.updatedSources;
      importedNotes += dbx.importedNotes;
      warningsCount += dbx.warningsCount;
      pendingReconciliations.push(...dbx.pendingReconciliations);
      errors.push(...dbx.errors);
      skipped.push(...dbx.skipped);
    }

    // 4. Family Library Catalogs & Subscribed .flashpkg URLs (online)
    if (isOnline()) {
      const fetcher =
        registry.catalogs.length > 0 || registry.packageSubscriptions.length > 0
          ? await ctx.platform.getPackageFetcher()
          : null;

      if (fetcher) {
        for (const cat of registry.catalogs) {
          try {
            const fetched = await fetcher.fetchCatalog(cat.url, {
              ...(cat.etag ? { etag: cat.etag } : {}),
            });
            if (!fetched.notModified) {
              const validated = parseAndValidateFamilyCatalog(fetched.rawJson);
              cat.name = validated.name;
              if (validated.description !== undefined) cat.description = validated.description;
              if (validated.updated_at !== undefined) cat.updatedAt = validated.updated_at;
              if (fetched.etag) cat.etag = fetched.etag;
              cat.packages = validated.packages.map((p) => ({
                package_id: p.package_id,
                title: p.title,
                url: p.url,
                version: p.version,
                languages: [...p.languages],
                ...(p.description !== undefined ? { description: p.description } : {}),
                ...(p.updated_at !== undefined ? { updated_at: p.updated_at } : {}),
                ...(p.author !== undefined ? { author: p.author } : {}),
                ...(p.sha256 !== undefined ? { sha256: p.sha256 } : {}),
              }));
            }
            cat.lastFetchedAt = Date.now();
            delete cat.lastError;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            cat.lastError = msg;
            errors.push(`${cat.name}: ${msg}`);
          }
        }

        for (const sub of registry.packageSubscriptions) {
          try {
            // If this subscription came from a catalog, pick up any updated expectedSha256
            if (sub.catalogUrl && sub.packageId) {
              const parentCat = registry.catalogs.find((c) => c.url === sub.catalogUrl);
              const catPkg = parentCat?.packages.find((p) => p.package_id === sub.packageId);
              if (catPkg?.sha256) sub.expectedSha256 = catPkg.sha256;
            }
            const res = await refreshSinglePackageSubscription(sub, ctx, {
              ...(opts?.force !== undefined ? { force: opts.force } : {}),
            });
            if (res.updated) updatedSources += 1;
            importedNotes += res.notesTouched;
            importedPages += res.pagesTouched;
            warningsCount += (sub.warnings ?? []).length;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sub.lastStatus = 'error';
            sub.lastError = msg;
            errors.push(`${sub.title}: ${msg}`);
          }
        }
      }
    }

    await saveSourcesRegistry(ctx.platform, registry);
    return {
      registry,
      updatedSources,
      importedNotes,
      importedPages,
      inboxImported,
      warningsCount,
      pendingReconciliations,
      errors,
      skipped,
    };
  });
}

/** A linked cloud file row in the Sources panel. */
export type CloudFileRowKind = 'onedrive' | 'dropbox' | 'gdrive_file';

/** The panel's Refresh button for one linked OneDrive, Dropbox or Drive file row. */
export function refreshLinkedFileRow(
  kind: CloudFileRowKind,
  id: string,
  ctx: SourceRunContext,
): Promise<{ registry: SourcesRegistry; outcome: CloudFileRowOutcome } | null> {
  if (kind === 'onedrive') return refreshCloudFileRow(ONEDRIVE_FILES, id, ctx);
  if (kind === 'dropbox') return refreshCloudFileRow(DROPBOX_FILES, id, ctx);
  return refreshCloudFileRow(GOOGLE_DRIVE_FILES, id, ctx);
}

/**
 * Applies a held linked-file pull with the user's matches. `undefined` when `rec` is not from a
 * linked cloud file (a local folder's), `null` when its row is gone.
 */
export async function applyLinkedFileReconciliation(
  rec: PendingXlsxReconciliation,
  renameMap: Record<string, string>,
  ctx: SourceRunContext,
): Promise<{ registry: SourcesRegistry; applied: boolean; message: string } | null | undefined> {
  if (rec.folderId.startsWith(ONEDRIVE_FILES.prefix)) {
    return applyCloudFileReconciliation(ONEDRIVE_FILES, rec, renameMap, ctx);
  }
  if (rec.folderId.startsWith(DROPBOX_FILES.prefix)) {
    return applyCloudFileReconciliation(DROPBOX_FILES, rec, renameMap, ctx);
  }
  if (rec.folderId.startsWith(GOOGLE_DRIVE_FILES.prefix)) {
    return applyCloudFileReconciliation(GOOGLE_DRIVE_FILES, rec, renameMap, ctx);
  }
  return undefined;
}
