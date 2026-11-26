import {
  BUILTIN_NOTE_TYPE_IDS,
  FLASH_NAMESPACE_UUID,
  uuidv5,
  type CollectionState,
  type Deck,
  type EventFactory,
  type KnownEvent,
  type NoteType,
  type SourceKind,
  type SourceRef,
} from '@flash/core';
import type { EntitlementState } from '@flash/core/license';
import type { PendingXlsxReconciliation, PlatformServices, SourcesRegistry } from '@flash/platform';

/**
 * The device-local registry of linked sources, the lock around it, and the helpers every runner
 * shares (sourceRunner, cloudFileSource, googleDriveFileSource). A leaf module: it imports no
 * runner, so the runners never import each other in a circle.
 */

export const LINKED_SOURCES_KV_KEY = 'linked_sources_v1';

/**
 * One queue for every load → mutate → save of the device-local sources registry and for every
 * refresh (D8). Without it, the launch `refreshAllSources` (which can run for minutes) saved its
 * stale copy over a folder or catalog the user linked meanwhile, and a manual refresh of the same
 * Sheet ran alongside it and emitted duplicate events.
 *
 * Not reentrant: a task must never call another locked function, or it waits on itself.
 */
let lockTail: Promise<unknown> = Promise.resolve();

export function withSourcesLock<T>(task: () => Promise<T>): Promise<T> {
  const run = lockTail.then(task, task);
  lockTail = run.catch(() => undefined);
  return run;
}

export interface SourceRunContext {
  platform: PlatformServices;
  getState: () => CollectionState;
  getEventFactory: () => EventFactory;
  emitEvents: (events: readonly KnownEvent[]) => void;
  /**
   * Free tier: checked whenever a run would add decks (folder files, Inbox and folder packages,
   * package refreshes); a run that would pass the limit skips that file or package (C14).
   */
  entitlement?: EntitlementState;
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
    dropboxSources: [],
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
    ...(saved?.googleDriveFiles
      ? {
          googleDriveFiles: saved.googleDriveFiles.map((g) => ({
            ...g,
            ...(g.columnMap ? { columnMap: [...g.columnMap] } : {}),
          })),
        }
      : {}),
    dropboxSources: saved?.dropboxSources
      ? saved.dropboxSources.map((d) => ({
          ...d,
          ...(d.columnMap ? { columnMap: [...d.columnMap] } : {}),
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
    const knownDropboxIds = new Set((registry.dropboxSources ?? []).map((d) => d.fileId));
    const knownDriveFileIds = new Set((registry.googleDriveFiles ?? []).map((g) => g.fileId));

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
      } else if (deck.source.kind === 'google_drive_file' && deck.source.external_id) {
        mergeSyncedGoogleDriveFile(registry, knownDriveFileIds, deck, {
          ...deck.source,
          external_id: deck.source.external_id,
        });
      } else if (deck.source.kind === 'dropbox_file' && deck.source.external_id) {
        if (!knownDropboxIds.has(deck.source.external_id)) {
          knownDropboxIds.add(deck.source.external_id);
          registry.dropboxSources ??= [];
          registry.dropboxSources.push({
            id: `dropbox:${deck.source.external_id}`,
            fileId: deck.source.external_id,
            name: deck.name,
            ...(deck.source.uri !== undefined ? { pathDisplay: deck.source.uri } : {}),
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

export function carriesSource(
  source: SourceRef | undefined,
  kind: SourceKind,
  externalId: string,
): boolean {
  return source?.kind === kind && source.external_id === externalId;
}

/**
 * Drops saved rows whose deck or page no longer carries their source: it was unlinked
 * (`SourceUnlinked`), maybe on another device. Without this, the saved row would keep refreshing
 * and its next `SourceLinked` would link the deck again. Rows whose deck or page this device
 * hasn't seen yet are kept.
 */
function dropSourcesUnlinkedElsewhere(registry: SourcesRegistry, state: CollectionState): void {
  registry.googleSources = registry.googleSources.filter((s) => {
    if (s.kind === 'google_docs') {
      const page = s.pageId ? state.pages.get(s.pageId) : undefined;
      return !page || carriesSource(page.source, 'google_docs', s.fileId);
    }
    return stillCarries(state, s.deckId, 'google_sheets', s.fileId);
  });
  if (registry.oneDriveSources) {
    registry.oneDriveSources = registry.oneDriveSources.filter((s) =>
      stillCarries(state, s.deckId, 'onedrive_file', s.itemId),
    );
  }
  if (registry.dropboxSources) {
    registry.dropboxSources = registry.dropboxSources.filter((s) =>
      stillCarries(state, s.deckId, 'dropbox_file', s.fileId),
    );
  }
  if (registry.googleDriveFiles) {
    registry.googleDriveFiles = registry.googleDriveFiles.filter((s) =>
      stillCarries(state, s.deckId, 'google_drive_file', s.fileId),
    );
  }
}

function stillCarries(
  state: CollectionState,
  deckId: string | undefined,
  kind: SourceKind,
  externalId: string,
): boolean {
  const deck = deckId ? state.decks.get(deckId) : undefined;
  return !deck || carriesSource(deck.source, kind, externalId);
}

/** Adds Drive files linked on another device (their decks synced here) to this registry. */
function mergeSyncedGoogleDriveFile(
  registry: SourcesRegistry,
  known: Set<string>,
  deck: Deck,
  src: SourceRef & { external_id: string },
): void {
  if (known.has(src.external_id)) return;
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

export async function saveSourcesRegistry(
  platform: PlatformServices,
  registry: SourcesRegistry,
): Promise<void> {
  await platform.storage.setKv(LINKED_SOURCES_KV_KEY, registry);
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
    ? true
    : navigator.onLine;
}

export function resolveNoteType(state: CollectionState, noteTypeId?: string): NoteType {
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
