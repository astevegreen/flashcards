import {
  BUILTIN_NOTE_TYPE_IDS,
  decodeUtf8,
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
  type SourceKind,
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
  LinkedOneDriveSource,
  OneDriveFileInfo,
  OneDriveFilePicker,
  PackageSubscription,
  PendingXlsxReconciliation,
  PickedFile,
  PlatformServices,
  SourcesRegistry,
  SourceWarning,
} from '@flash/platform';

export const LINKED_SOURCES_KV_KEY = 'linked_sources_v1';

const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

export interface SourceRunContext {
  platform: PlatformServices;
  getState: () => CollectionState;
  getEventFactory: () => EventFactory;
  emitEvents: (events: readonly KnownEvent[]) => void;
}

export interface SourceRefreshSummary {
  registry: SourcesRegistry;
  updatedSources: number;
  importedNotes: number;
  importedPages: number;
  inboxImported: number;
  warningsCount: number;
  pendingReconciliations: PendingXlsxReconciliation[];
  errors: string[];
  /**
   * Linked sources left alone on purpose, as `name: why` (an archived deck, an `.xlsx` this
   * device can't read). Not errors: nothing failed, but the user should know.
   */
  skipped: string[];
}

export function createEmptySourcesRegistry(): SourcesRegistry {
  return {
    googleSources: [],
    oneDriveSources: [],
    localFolders: [],
    packageSubscriptions: [],
    catalogs: [],
  };
}

/**
 * Loads the device-local source registry and merges any synced `google_sheets`, `google_docs`,
 * or `package_url` decks/pages from `CollectionState` so sources linked on Device A also surface on Device B.
 */
export async function loadSourcesRegistry(
  platform: PlatformServices,
  state?: CollectionState,
): Promise<SourcesRegistry> {
  const saved = await platform.storage.getKv<SourcesRegistry>(LINKED_SOURCES_KV_KEY);
  const registry: SourcesRegistry = {
    googleSources: saved?.googleSources
      ? saved.googleSources.map((s) => ({
          ...s,
          ...(s.localizedImages ? { localizedImages: { ...s.localizedImages } } : {}),
          ...(s.localizedAudio ? { localizedAudio: { ...s.localizedAudio } } : {}),
        }))
      : [],
    ...(saved?.unlinkedOneDriveIds?.length
      ? { unlinkedOneDriveIds: [...saved.unlinkedOneDriveIds] }
      : {}),
    oneDriveSources: saved?.oneDriveSources
      ? saved.oneDriveSources.map((o) => ({
          ...o,
          ...(o.columnMap ? { columnMap: [...o.columnMap] } : {}),
        }))
      : [],
    localFolders: saved?.localFolders
      ? saved.localFolders.map((f) => ({
          ...f,
          files: { ...f.files },
          inboxImported: { ...f.inboxImported },
        }))
      : [],
    packageSubscriptions: saved?.packageSubscriptions
      ? saved.packageSubscriptions.map((p) => ({ ...p }))
      : [],
    catalogs: saved?.catalogs
      ? saved.catalogs.map((c) => ({ ...c, packages: [...c.packages] }))
      : [],
  };

  if (state) {
    dropSourcesUnlinkedElsewhere(registry, state);
    // Merge synced Google Sheet & package_url decks not yet in local registry
    const knownGoogleIds = new Set(registry.googleSources.map((s) => s.fileId));
    const knownPkgUrls = new Set(registry.packageSubscriptions.map((p) => p.url));
    // Files unlinked on this device by a PR #19 build (before SourceUnlinked) stay unlinked even
    // though their decks still say so.
    const knownOneDriveIds = new Set([
      ...(registry.oneDriveSources ?? []).map((o) => o.itemId),
      ...(registry.unlinkedOneDriveIds ?? []),
    ]);

    for (const deck of state.decks.values()) {
      if (deck.archived || !deck.source) continue;
      if (deck.source.kind === 'google_sheets' && deck.source.external_id) {
        if (!knownGoogleIds.has(deck.source.external_id)) {
          knownGoogleIds.add(deck.source.external_id);
          registry.googleSources.push({
            id: `gsheet:${deck.source.external_id}`,
            kind: 'google_sheets',
            fileId: deck.source.external_id,
            name: deck.name,
            uri:
              deck.source.uri ??
              `https://docs.google.com/spreadsheets/d/${deck.source.external_id}/edit`,
            deckId: deck.id,
            noteTypeId: deck.note_type_id,
            language: deck.language,
            ...(deck.source.sheet_tab !== undefined ? { sheetTab: deck.source.sheet_tab } : {}),
            ...(deck.source.read_only !== undefined ? { readOnly: deck.source.read_only } : {}),
            ...(deck.source.last_synced_at !== undefined
              ? { lastSyncedAt: deck.source.last_synced_at }
              : {}),
            lastStatus: 'idle',
          });
        }
      } else if (deck.source.kind === 'onedrive_file' && deck.source.external_id) {
        if (!knownOneDriveIds.has(deck.source.external_id)) {
          knownOneDriveIds.add(deck.source.external_id);
          registry.oneDriveSources ??= [];
          registry.oneDriveSources.push({
            id: `onedrive:${deck.source.external_id}`,
            itemId: deck.source.external_id,
            name: deck.name,
            ...(deck.source.uri !== undefined ? { uri: deck.source.uri } : {}),
            deckId: deck.id,
            noteTypeId: deck.note_type_id,
            language: deck.language,
            ...(deck.source.last_synced_at !== undefined
              ? { lastSyncedAt: deck.source.last_synced_at }
              : {}),
            lastStatus: 'idle',
          });
        }
      } else if (deck.source.kind === 'package_url' && deck.source.uri) {
        if (!knownPkgUrls.has(deck.source.uri)) {
          knownPkgUrls.add(deck.source.uri);
          registry.packageSubscriptions.push({
            id: `pkgurl:${uuidv5(FLASH_NAMESPACE_UUID, deck.source.uri)}`,
            url: deck.source.uri,
            title: deck.name,
            ...(deck.source.package_id !== undefined ? { packageId: deck.source.package_id } : {}),
            ...(deck.source.package_version !== undefined
              ? { version: deck.source.package_version }
              : {}),
            ...(deck.source.last_synced_at !== undefined
              ? { lastSyncedAt: deck.source.last_synced_at }
              : {}),
            lastStatus: 'idle',
          });
        }
      }
    }

    for (const page of state.pages.values()) {
      if (page.source?.kind === 'google_docs' && page.source.external_id) {
        if (!knownGoogleIds.has(page.source.external_id)) {
          knownGoogleIds.add(page.source.external_id);
          registry.googleSources.push({
            id: `gdoc:${page.source.external_id}`,
            kind: 'google_docs',
            fileId: page.source.external_id,
            name: page.title,
            uri:
              page.source.uri ??
              `https://docs.google.com/document/d/${page.source.external_id}/edit`,
            pageId: page.id,
            ...(page.source.last_synced_at !== undefined
              ? { lastSyncedAt: page.source.last_synced_at }
              : {}),
            lastStatus: 'idle',
          });
        }
      }
    }
  }

  return registry;
}

function carriesSource(
  source: SourceRef | undefined,
  kind: SourceKind,
  externalId: string,
): boolean {
  return source?.kind === kind && source.external_id === externalId;
}

/**
 * Drops saved Google / OneDrive rows whose deck or page no longer carries their source: it was
 * unlinked (`SourceUnlinked`), maybe on another device. Without this, the saved row would keep
 * refreshing and its next `SourceLinked` would link the deck again. Rows whose deck or page this
 * device hasn't seen yet are kept.
 */
function dropSourcesUnlinkedElsewhere(registry: SourcesRegistry, state: CollectionState): void {
  registry.googleSources = registry.googleSources.filter((s) => {
    if (s.kind === 'google_docs') {
      const page = s.pageId ? state.pages.get(s.pageId) : undefined;
      return !page || carriesSource(page.source, 'google_docs', s.fileId);
    }
    const deck = s.deckId ? state.decks.get(s.deckId) : undefined;
    return !deck || carriesSource(deck.source, 'google_sheets', s.fileId);
  });
  if (registry.oneDriveSources) {
    registry.oneDriveSources = registry.oneDriveSources.filter((s) => {
      const deck = s.deckId ? state.decks.get(s.deckId) : undefined;
      return !deck || carriesSource(deck.source, 'onedrive_file', s.itemId);
    });
  }
}

/** A linked-source row that Unlink removes. */
export type UnlinkSourceKind = 'google' | 'onedrive' | 'folder' | 'package' | 'catalog';

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
  if (kind === 'package') {
    const row = registry.packageSubscriptions.find((p) => p.id === id);
    return row ? (src) => src.kind === 'package_url' && src.uri === row.url : null;
  }
  // Local folders are linked per device, and catalogs only list packages.
  return null;
}

/** One `SourceUnlinked` per deck and page whose source `matches`. */
export function planSourceUnlinkEvents(
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
}

export async function saveSourcesRegistry(
  platform: PlatformServices,
  registry: SourcesRegistry,
): Promise<void> {
  await platform.storage.setKv(LINKED_SOURCES_KV_KEY, registry);
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
    ? true
    : navigator.onLine;
}

/**
 * Option 1 (§13 + R7): Pre-localizes remote `https:` image URLs BEFORE diffing Google Sheets / Docs
 * so:
 * 1. `MediaAdded` events are emitted FIRST with strictly ascending `seq` (before `NoteUpserted`/`PageUpserted`).
 * 2. Already-cached URLs (`source.localizedImages`) are reused with zero redundant network fetches
 *    and zero spurious `NoteUpserted`/`PageUpserted` diffs on subsequent pulls.
 * 3. CORS failures emit a clear non-blocking warning without failing the pull.
 */
async function preLocalizeHttpsImageUrls(
  urls: Iterable<string>,
  source: LinkedGoogleSource,
  ctx: SourceRunContext,
  nowMs: number,
): Promise<{
  mediaPathMap: Record<string, string>;
  mediaEvents: KnownEvent[];
  warnings: SourceWarning[];
}> {
  const fetcher = ctx.platform.fetchAndCacheHttpsImage;
  const mediaPathMap: Record<string, string> = {};
  const mediaEvents: KnownEvent[] = [];
  const warnings: SourceWarning[] = [];

  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 0) {
    return { mediaPathMap, mediaEvents, warnings };
  }

  const state = ctx.getState();
  const factory = ctx.getEventFactory();
  const emittedHashes = new Set<string>(state.media.keys());
  const cachedMap = source.localizedImages ?? {};
  const nextCache: Record<string, string> = { ...cachedMap };
  let cacheMutated = false;

  for (const url of uniqueUrls) {
    // 1. Reuse previously localized `media:<sha256>` if still present in local media storage & state
    const cachedUri = nextCache[url];
    const cachedMatch = cachedUri ? /^media:([0-9a-f]{64})$/i.exec(cachedUri) : null;
    if (cachedMatch?.[1]) {
      const hash = cachedMatch[1].toLowerCase();
      if (state.media.has(hash)) {
        const localBlob = await ctx.platform.storage.getMedia(hash);
        if (localBlob) {
          mediaPathMap[url] = `media:${hash}`;
          continue;
        }
      }
    }

    if (!fetcher) continue;

    try {
      const processed = await fetcher(url);
      await ctx.platform.storage.putMedia({
        hash: processed.hash,
        mime: processed.mime,
        bytes: processed.bytes,
      });
      if (!emittedHashes.has(processed.hash)) {
        emittedHashes.add(processed.hash);
        mediaEvents.push(
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
      mediaPathMap[url] = mediaUri;
      nextCache[url] = mediaUri;
      cacheMutated = true;
    } catch (err) {
      warnings.push({
        code: 'remote_image_cors_blocked',
        message: `Could not cache remote image "${url}" (${err instanceof Error ? err.message : String(err)}). Upload the image directly or bundle it in .flashpkg / a linked local folder for offline display.`,
      });
    }
  }

  if (cacheMutated) {
    source.localizedImages = nextCache;
  }

  return { mediaPathMap, mediaEvents, warnings };
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

/**
 * Pre-localizes remote `https:` audio URLs from Google Sheets `Audio` / `Sound 1` columns
 * BEFORE diffing so `MediaAdded` events precede `NoteUpserted` and unchanged rows reuse cache.
 */
async function preLocalizeHttpsAudioUrls(
  urls: Iterable<string>,
  source: LinkedGoogleSource,
  ctx: SourceRunContext,
  nowMs: number,
): Promise<{
  mediaPathMap: Record<string, string>;
  mediaEvents: KnownEvent[];
  warnings: SourceWarning[];
}> {
  const fetcher = ctx.platform.fetchAndCacheHttpsAudio;
  const mediaPathMap: Record<string, string> = {};
  const mediaEvents: KnownEvent[] = [];
  const warnings: SourceWarning[] = [];

  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 0) {
    return { mediaPathMap, mediaEvents, warnings };
  }

  const state = ctx.getState();
  const factory = ctx.getEventFactory();
  const emittedHashes = new Set<string>(state.media.keys());
  const cachedMap = source.localizedAudio ?? {};
  const nextCache: Record<string, string> = { ...cachedMap };
  let cacheMutated = false;

  for (const url of uniqueUrls) {
    const cachedUri = nextCache[url];
    const cachedMatch = cachedUri ? /^media:([0-9a-f]{64})$/i.exec(cachedUri) : null;
    if (cachedMatch?.[1]) {
      const hash = cachedMatch[1].toLowerCase();
      if (state.media.has(hash)) {
        const localBlob = await ctx.platform.storage.getMedia(hash);
        if (localBlob) {
          mediaPathMap[url] = `media:${hash}`;
          continue;
        }
      }
    }

    if (!fetcher) continue;

    try {
      const processed = await fetcher(url);
      await ctx.platform.storage.putMedia({
        hash: processed.hash,
        mime: processed.mime,
        bytes: processed.bytes,
      });
      if (!emittedHashes.has(processed.hash)) {
        emittedHashes.add(processed.hash);
        mediaEvents.push(
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
      mediaPathMap[url] = mediaUri;
      nextCache[url] = mediaUri;
      cacheMutated = true;
    } catch (err) {
      warnings.push({
        code: 'remote_audio_cors_blocked',
        message: `Could not cache remote audio "${url}" (${err instanceof Error ? err.message : String(err)}). Upload the audio clip directly or bundle it in .flashpkg / a linked local folder for offline playback.`,
      });
    }
  }

  if (cacheMutated) {
    source.localizedAudio = nextCache;
  }

  return { mediaPathMap, mediaEvents, warnings };
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

function resolveNoteType(state: CollectionState, noteTypeId?: string): NoteType {
  if (noteTypeId) {
    const found = state.noteTypes.get(noteTypeId);
    if (found) return found;
  }
  const fallback =
    state.noteTypes.get(BUILTIN_NOTE_TYPE_IDS.VOCAB_KO) ?? [...state.noteTypes.values()][0];
  if (!fallback) {
    throw new Error('No note types available in collection state.');
  }
  return fallback;
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
          ...(options?.defaultLanguage !== undefined ? { language: options.defaultLanguage } : {}),
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
}

/**
 * Creates a new Google Sheet from a built-in Note Type template, links it, and runs the first pull.
 */
export async function createAndLinkGoogleSheetTemplate(
  options: { title: string; noteTypeId: string; language: string },
  ctx: SourceRunContext,
): Promise<{ source: LinkedGoogleSource; registry: SourcesRegistry }> {
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

  await refreshSingleGoogleSource(source, ctx, { force: true });
  await saveSourcesRegistry(ctx.platform, registry);
  return { source, registry };
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
        await client.writeSheetCells(source.fileId, grid.sheetTitle, updates);
        // Capture post-write modifiedTime so our own Card ID write doesn't trigger a redundant pull
        try {
          const postMeta = await client.getFileMetadata(source.fileId);
          if (postMeta.modifiedTime) {
            grid.modifiedTime = postMeta.modifiedTime;
          }
        } catch {
          // Ignore post-write metadata failure
        }
      }
    } catch (writeErr) {
      if (isSyncTransportError(writeErr) && writeErr.code === 'PERMISSION_DENIED') {
        // Shared view-only sheet: gracefully switch to read-only diff
        grid.readOnly = true;
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

const ONEDRIVE_TABLE_EXTENSION = /\.(csv|tsv|xlsx)$/i;

/** Prefix of `PendingXlsxReconciliation.folderId` for a linked OneDrive file (then the item id). */
export const ONEDRIVE_RECONCILE_PREFIX = 'onedrive:';

/** Options for {@link linkOneDriveFile}: the choices made in the column-mapping step. */
interface OneDriveLinkOptions {
  noteTypeId?: string;
  language?: string;
  columnMap?: SourceColumnMapping[];
}

function oneDriveDeckId(source: Pick<LinkedOneDriveSource, 'itemId' | 'deckId'>): string {
  return source.deckId ?? uuidv5(FLASH_NAMESPACE_UUID, `onedrive:${source.itemId}`);
}

function addOneDriveSource(
  registry: SourcesRegistry,
  file: { id: string; name: string },
  options: OneDriveLinkOptions | undefined,
): LinkedOneDriveSource {
  const source: LinkedOneDriveSource = {
    id: `onedrive:${file.id}`,
    itemId: file.id,
    name: file.name.replace(ONEDRIVE_TABLE_EXTENSION, ''),
    ...(options?.noteTypeId !== undefined ? { noteTypeId: options.noteTypeId } : {}),
    ...(options?.language !== undefined ? { language: options.language } : {}),
    lastStatus: 'idle',
  };
  registry.oneDriveSources ??= [];
  registry.oneDriveSources.push(source);
  return source;
}

/** A first pull that failed leaves nothing to refresh, so don't keep a source without a deck. */
function recordFailedOneDriveLink(
  registry: SourcesRegistry,
  source: LinkedOneDriveSource,
  err: unknown,
  chosenColumnMap: boolean,
): void {
  if (!source.deckId) {
    registry.oneDriveSources = (registry.oneDriveSources ?? []).filter((s) => s !== source);
    return;
  }
  source.lastStatus = 'error';
  source.lastError = err instanceof Error ? err.message : String(err);
  // The chosen mapping was already written to this device's copy: keep it winning.
  if (chosenColumnMap) source.columnMapUnsaved = true;
}

/**
 * Links one OneDrive `.csv` / `.tsv` / `.xlsx` file as a source and runs the first pull. The file
 * is read-only (the app never writes to the user's OneDrive), so rows are matched by their first
 * field, like a linked `.xlsx` in a local folder. If the pull finds rows that may have been
 * renamed (a changed first field), nothing is applied and `pending` asks the user to match them.
 */
export async function linkOneDriveFile(
  file: { id: string; name: string },
  ctx: SourceRunContext,
  options?: OneDriveLinkOptions,
): Promise<{
  source: LinkedOneDriveSource;
  registry: SourcesRegistry;
  notesTouched: number;
  pending?: PendingXlsxReconciliation;
}> {
  if (!ONEDRIVE_TABLE_EXTENSION.test(file.name)) {
    throw new Error(`"${file.name}" is not a .csv, .tsv or .xlsx file.`);
  }
  const state = ctx.getState();
  const registry = await loadSourcesRegistry(ctx.platform, state);
  const existing = registry.oneDriveSources?.find((s) => s.itemId === file.id);
  const archived = state.decks.get(oneDriveDeckId(existing ?? { itemId: file.id }));
  if (archived?.archived) {
    throw new Error(
      `The deck "${archived.name}" from this file is archived. Restore it in the Library first.`,
    );
  }
  // Linking again after an unlink is deliberate: stop hiding the file's synced deck.
  registry.unlinkedOneDriveIds = (registry.unlinkedOneDriveIds ?? []).filter(
    (id) => id !== file.id,
  );
  const source = existing ?? addOneDriveSource(registry, file, options);
  if (options?.columnMap) source.columnMap = [...options.columnMap];
  try {
    const res = await refreshSingleOneDriveSource(source, ctx, {
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
    recordFailedOneDriveLink(registry, source, err, Boolean(options?.columnMap));
    await saveSourcesRegistry(ctx.platform, registry);
    throw err;
  }
}

function excelUnreadableMessage(name: string): string {
  return `Excel files can't be read on this device. Save "${name}" as CSV in Excel and link that instead.`;
}

/** True when this device can read `.xlsx` (the web and PC shells; not the phone shells yet). */
async function canReadExcel(platform: PlatformServices): Promise<boolean> {
  try {
    const adapter = await platform.getLocalFolderSources();
    return adapter.canParseXlsx ? adapter.canParseXlsx() : true;
  } catch {
    return false;
  }
}

/** Reads a downloaded OneDrive `.csv` / `.tsv` / `.xlsx` into a grid whose first row is the headers. */
export async function readOneDriveTable(
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

interface OneDriveRefreshOptions {
  force?: boolean;
  columnMap?: SourceColumnMapping[];
  /** existing note id -> new first-field value, from the reconciliation prompt. */
  renameMap?: Readonly<Record<string, string>>;
}

interface OneDriveRefreshResult {
  updated: boolean;
  notesTouched: number;
  warnings: SourceWarning[];
  pending?: PendingXlsxReconciliation;
  /** An `.xlsx` this device cannot read: nothing was downloaded or changed. */
  unreadable?: true;
}

function archivedDeckRefreshMessage(deckName: string): string {
  return `The deck "${deckName}" is archived. Restore it to refresh this source.`;
}

/** Leaves the file alone on this refresh, and says why on its row. */
function markOneDriveSkipped(
  source: LinkedOneDriveSource,
  reason: NonNullable<LinkedOneDriveSource['skipReason']>,
  message: string,
): void {
  source.lastStatus = 'idle';
  source.lastError = message;
  source.skipReason = reason;
}

function markOneDriveSynced(source: LinkedOneDriveSource, nowMs: number): void {
  source.lastSyncedAt = nowMs;
  source.lastStatus = 'synced';
  delete source.lastError;
  delete source.skipReason;
}

/**
 * Everything a refresh decides before downloading: an archived deck, offline, no file access, an
 * unchanged content tag, or an `.xlsx` this device can't read end it with `result`.
 */
async function prepareOneDrivePull(
  source: LinkedOneDriveSource,
  ctx: SourceRunContext,
  opts: OneDriveRefreshOptions | undefined,
): Promise<
  | { result: OneDriveRefreshResult }
  | { picker: OneDriveFilePicker; info: OneDriveFileInfo; nowMs: number }
> {
  const unchanged = { updated: false, notesTouched: 0, warnings: source.warnings ?? [] };
  // Before any network call, so the row keeps saying why even when the file is unchanged.
  const deck = ctx.getState().decks.get(oneDriveDeckId(source));
  if (deck?.archived) {
    markOneDriveSkipped(source, 'archived', archivedDeckRefreshMessage(deck.name));
    return { result: unchanged };
  }
  if (!isOnline()) {
    source.lastStatus = 'offline';
    return { result: unchanged };
  }
  if (!ctx.platform.getOneDrivePicker) throw new Error('OneDrive is not available in this build.');
  const picker = await ctx.platform.getOneDrivePicker();
  if (!(await picker.hasFileAccess())) {
    source.lastStatus = 'permission_required';
    source.lastError = 'Allow OneDrive file access to refresh this source.';
    return { result: unchanged };
  }

  const nowMs = Date.now();
  const info = await picker.getFileInfo(source.itemId);
  const tagUnchanged =
    !opts?.force &&
    source.deckId &&
    source.contentTag &&
    !source.columnMapUnsaved &&
    info.contentTag === source.contentTag;
  if (tagUnchanged) {
    markOneDriveSynced(source, nowMs);
    return { result: unchanged };
  }
  // Decide from the name before fetching up to 50 MB this device could not read anyway.
  if (info.name.toLowerCase().endsWith('.xlsx') && !(await canReadExcel(ctx.platform))) {
    markOneDriveSkipped(source, 'unreadable', excelUnreadableMessage(info.name));
    return { result: { ...unchanged, unreadable: true } };
  }
  return { picker, info, nowMs };
}

/**
 * The mapping for this pull: one chosen now, else one chosen here that hasn't reached the deck
 * yet, else the deck's synced one, else the copy kept when it was linked.
 */
function resolveOneDriveColumnMap(
  source: LinkedOneDriveSource,
  opts: OneDriveRefreshOptions | undefined,
  deckSource: SourceRef | undefined,
): SourceColumnMapping[] | undefined {
  return (
    opts?.columnMap ??
    (source.columnMapUnsaved ? source.columnMap : undefined) ??
    deckSource?.column_map ??
    source.columnMap
  );
}

/** `DeckCreated` for a new deck, else `SourceLinked` when the deck's source changed. */
function oneDriveDeckEvent(
  factory: EventFactory,
  existingDeck: Deck | undefined,
  created: DeckCreatedPayload & { source: SourceRef },
  nowMs: number,
): KnownEvent | null {
  if (!existingDeck) return factory.create('DeckCreated', created, nowMs);
  const prev = existingDeck.source;
  const next = created.source;
  const sameRef =
    prev?.kind === 'onedrive_file' &&
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

/** The deck's note type and language, else the ones chosen when linking, else guessed. */
function resolveOneDriveDeckShape(
  state: CollectionState,
  source: LinkedOneDriveSource,
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

/**
 * Applying a likely rename now would archive the old note (and its review history) and add a new
 * one. Holds the pull; the content tag stays old, so the next refresh asks again. A mapping chosen
 * for this pull is kept on the source until it lands on the deck.
 */
function holdOneDriveRename(
  source: LinkedOneDriveSource,
  opts: OneDriveRefreshOptions | undefined,
  pending: PendingXlsxReconciliation,
): OneDriveRefreshResult {
  if (opts?.columnMap) {
    source.columnMap = [...opts.columnMap];
    source.columnMapUnsaved = true;
  }
  return { updated: false, notesTouched: 0, warnings: source.warnings ?? [], pending };
}

function oneDriveSourceRef(
  itemId: string,
  uri: string | undefined,
  contentHash: string,
  columnMap: SourceColumnMapping[] | undefined,
  nowMs: number,
): SourceRef {
  return {
    kind: 'onedrive_file',
    ...(uri ? { uri } : {}),
    external_id: itemId,
    read_only: true,
    content_hash: contentHash,
    last_synced_at: nowMs,
    ...(columnMap ? { column_map: [...columnMap] } : {}),
  };
}

/** Records a pull that landed on this device's row. */
function recordOneDrivePull(
  source: LinkedOneDriveSource,
  pull: {
    deckId: string;
    noteTypeId: string;
    language: string;
    columnMap: SourceColumnMapping[] | undefined;
    uri: string | undefined;
    contentTag: string | undefined;
    nowMs: number;
    warnings: ReturnType<typeof diffTabularSource>['warnings'];
  },
): void {
  source.deckId = pull.deckId;
  source.noteTypeId = pull.noteTypeId;
  source.language = pull.language;
  if (pull.columnMap) source.columnMap = [...pull.columnMap];
  delete source.columnMapUnsaved;
  if (pull.uri) source.uri = pull.uri;
  if (pull.contentTag) source.contentTag = pull.contentTag;
  markOneDriveSynced(source, pull.nowMs);
  source.warnings = pull.warnings.map((w) => ({
    code: w.code,
    message: w.message,
    ...(w.row !== undefined ? { row: w.row } : {}),
    ...(w.header !== undefined ? { header: w.header } : {}),
  }));
}

/**
 * Refreshes one linked OneDrive file. A cheap metadata call compares the content tag first; the
 * file is downloaded and diffed only when it changed (or `force`). Rows are matched by their first
 * field. When some rows went missing and new ones appeared (a likely rename), nothing is applied
 * and `pending` carries the same reconciliation prompt a linked local `.xlsx` uses; pass its
 * answer back as `renameMap` to apply the pull. A file whose deck is archived, or an `.xlsx` this
 * device cannot read, is left alone and its row says why (`skipReason`, `lastError`).
 */
export async function refreshSingleOneDriveSource(
  source: LinkedOneDriveSource,
  ctx: SourceRunContext,
  opts?: OneDriveRefreshOptions,
): Promise<OneDriveRefreshResult> {
  const ready = await prepareOneDrivePull(source, ctx, opts);
  if ('result' in ready) return ready.result;
  const { picker, info, nowMs } = ready;

  const picked = await picker.downloadById(source.itemId);
  const grid = await readOneDriveTable(ctx.platform, picked);

  const state = ctx.getState();
  const factory = ctx.getEventFactory();
  const deckId = oneDriveDeckId(source);
  const existingDeck = state.decks.get(deckId);
  const { noteType, language } = resolveOneDriveDeckShape(state, source, existingDeck, grid[0]);
  const columnMap = resolveOneDriveColumnMap(source, opts, existingDeck?.source);

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
    return holdOneDriveRename(source, opts, {
      folderId: `${ONEDRIVE_RECONCILE_PREFIX}${source.itemId}`,
      relativePath: picked.name,
      deckId,
      deckName: existingDeck.name,
      missingNotes: diff.reconciliationCandidates.missingNotes,
      addedRows: diff.reconciliationCandidates.addedRows,
    });
  }

  const uri = info.webUrl ?? source.uri;
  const deckEvent = oneDriveDeckEvent(
    factory,
    existingDeck,
    {
      deck_id: deckId,
      name: source.name,
      note_type_id: noteType.id,
      language,
      source: oneDriveSourceRef(source.itemId, uri, sha256Hex(picked.bytes), columnMap, nowMs),
      created_at: nowMs,
    },
    nowMs,
  );
  const events: KnownEvent[] = deckEvent ? [deckEvent, ...diff.events] : [...diff.events];
  if (events.length > 0) ctx.emitEvents(events);

  recordOneDrivePull(source, {
    deckId,
    noteTypeId: noteType.id,
    language,
    columnMap,
    uri,
    contentTag: info.contentTag,
    nowMs,
    warnings: diff.warnings,
  });

  const notesTouched =
    diff.stats.added + diff.stats.updated + diff.stats.archived + diff.stats.restored;
  return {
    updated: !existingDeck || notesTouched > 0,
    notesTouched,
    warnings: source.warnings ?? [],
  };
}

/**
 * Links a new PC local folder via File System Access API and immediately scans it (§3.2).
 */
export async function linkAndScanLocalFolder(
  ctx: SourceRunContext,
): Promise<{ folder: LinkedLocalFolder | null; summary?: SourceRefreshSummary }> {
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
        for (const media of pkgRes.extractedMedia) {
          await ctx.platform.storage.putMedia({
            hash: media.hash,
            mime: media.mime,
            bytes: media.bytes,
          });
        }
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
        for (const media of pkgRes.extractedMedia) {
          await ctx.platform.storage.putMedia({
            hash: media.hash,
            mime: media.mime,
            bytes: media.bytes,
          });
        }
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
          await ctx.platform.storage.putMedia({
            hash: mHash,
            mime: loaded.mime,
            bytes: loaded.bytes,
          });
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
      const inferred = inferPresetNoteTypeId(
        grid[0] ?? [],
        cached?.noteTypeId ?? BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
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
          await ctx.platform.storage.putMedia({
            hash: mHash,
            mime: loaded.mime,
            bytes: loaded.bytes,
          });
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

  const pkgRes = importFlashpkg(fetched.bytes, ctx.getState(), ctx.getEventFactory(), {
    nowMs,
    sourceOverride: {
      kind: 'package_url',
      uri: sub.url,
    },
    archiveRemovedOnUpgrade: true,
  });

  for (const media of pkgRes.extractedMedia) {
    await ctx.platform.storage.putMedia({
      hash: media.hash,
      mime: media.mime,
      bytes: media.bytes,
    });
  }
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
}

type OneDriveRefreshTally = Pick<
  SourceRefreshSummary,
  | 'updatedSources'
  | 'importedNotes'
  | 'warningsCount'
  | 'pendingReconciliations'
  | 'errors'
  | 'skipped'
>;

/** The OneDrive part of {@link refreshAllSources}: one row's failure never stops the others. */
async function refreshLinkedOneDriveFiles(
  sources: readonly LinkedOneDriveSource[],
  ctx: SourceRunContext,
  force: boolean | undefined,
): Promise<OneDriveRefreshTally> {
  const tally: OneDriveRefreshTally = {
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
      // on a phone), and Graph throttles bursts of requests from one app.
      const res = await refreshSingleOneDriveSource(src, ctx, refreshOpts); // NOSONAR (S9382)
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

/**
 * Refreshes all linked sources (Google Sheets/Docs when online & signed in, Local Folders offline/online,
 * Family Catalogs, and subscribed `.flashpkg` URLs).
 */
export async function refreshAllSources(
  ctx: SourceRunContext,
  opts?: { requestFolderPermission?: boolean; force?: boolean },
): Promise<SourceRefreshSummary> {
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

  // 2. Google Sheets & Docs (online + connected)
  if (isOnline() && registry.googleSources.length > 0) {
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
    }
  }

  // 3. Linked OneDrive files (online; skipped until the user has allowed OneDrive file access)
  if (isOnline() && ctx.platform.oneDriveConfigured) {
    const od = await refreshLinkedOneDriveFiles(registry.oneDriveSources ?? [], ctx, opts?.force);
    updatedSources += od.updatedSources;
    importedNotes += od.importedNotes;
    warningsCount += od.warningsCount;
    pendingReconciliations.push(...od.pendingReconciliations);
    errors.push(...od.errors);
    skipped.push(...od.skipped);
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
}
