import type { CollectionState, EventFactory, KnownEvent } from '@flash/core';
import {
  buildBackup,
  chooseBackupKind,
  isAutoBackupDue,
  packBackup,
  parseSyncFolderBackupPath,
  planBackupRestore,
  readBackupArchive,
  restoreStepsToEvents,
  selectBackupsToPrune,
  SYNC_FOLDER_BACKUP_PREFIX,
  syncFolderBackupPath,
  verifyBackupMedia,
  type BackupKind,
  type BackupReason,
  type ReadBackupResult,
  type RestorePlan,
} from '@flash/core/backup';
import { uuidv7 } from '@flash/core';
import type {
  DeviceMeta,
  BackupStore,
  PlatformServices,
  Storage,
  StoredBackupInfo,
  SyncProviderKind,
  SyncTransport,
} from '@flash/platform';

/**
 * Rolling backups on this device (`@flash/core/backup`): the automatic daily snapshot, the
 * optional copy in the sync folder, and restores. Lazy chunk: never on the initial bundle (§8).
 */

export interface BackupContext {
  platform: PlatformServices;
  getState: () => CollectionState;
  getMeta: () => DeviceMeta;
  /** The connected sync provider (`none` when not syncing). */
  getSyncProvider: () => SyncProviderKind;
}

export interface RestoreContext extends BackupContext {
  emitEvents: (events: readonly KnownEvent[]) => void;
  getEventFactory: () => EventFactory;
}

const stores = new WeakMap<Storage, Promise<BackupStore | null>>();

/** This device's backup store, opened once; `null` when the storage keeps no backups. */
export function openBackupStore(storage: Storage): Promise<BackupStore | null> {
  let store = stores.get(storage);
  if (!store) {
    store = storage.openBackupStore ? storage.openBackupStore() : Promise.resolve(null);
    stores.set(storage, store);
  }
  return store;
}

export const BACKUP_SETTINGS_KV_KEY = 'backup_settings_v1';

export interface BackupSettings {
  /** Also write each snapshot (without media) to the sync folder. Default off. */
  syncFolderCopy: boolean;
}

export async function loadBackupSettings(storage: Storage): Promise<BackupSettings> {
  const saved = await storage.getKv<Partial<BackupSettings>>(BACKUP_SETTINGS_KV_KEY);
  return { syncFolderCopy: saved?.syncFolderCopy === true };
}

export async function saveBackupSettings(
  storage: Storage,
  settings: BackupSettings,
): Promise<void> {
  await storage.setKv(BACKUP_SETTINGS_KV_KEY, settings);
}

/** The transport of the connected sync provider, without any sign-in or permission prompt. */
export async function resolveSyncFolderTransport(
  platform: PlatformServices,
  provider: SyncProviderKind,
): Promise<SyncTransport | null> {
  switch (provider) {
    case 'dev_channel':
      return platform.syncTransport;
    case 'google_drive':
      return platform.createGoogleDriveTransport();
    case 'dropbox':
      return (await platform.createDropboxTransport?.()) ?? null;
    case 'onedrive':
      return (await platform.createOneDriveTransport?.()) ?? null;
    case 'icloud':
      return (await platform.createICloudTransport?.()) ?? null;
    case 'local_folder':
      return (
        (await platform.restoreLocalSyncFolder({ requestPermission: false }))?.transport ?? null
      );
    default:
      return null;
  }
}

function totalMediaBytes(state: CollectionState): number {
  let total = 0;
  for (const m of state.media.values()) total += Math.max(0, m.size);
  return total;
}

async function loadMediaBlobs(
  storage: Storage,
  hashes: Iterable<string>,
): Promise<Map<string, Uint8Array>> {
  const blobs = new Map<string, Uint8Array>();
  for (const hash of hashes) {
    const blob = await storage.getMedia(hash);
    if (blob) blobs.set(hash.toLowerCase(), blob.bytes);
  }
  return blobs;
}

/** A full backup file (media included) for the user to save off the device; not stored here. */
export async function buildFullBackupFile(
  storage: Storage,
  state: CollectionState,
  opts: { deviceId: string; collectionId?: string },
): Promise<Uint8Array> {
  const nowMs = Date.now();
  const built = buildBackup(state, {
    backupId: uuidv7(nowMs),
    kind: 'full',
    reason: 'manual',
    nowMs,
    deviceId: opts.deviceId,
    ...(opts.collectionId !== undefined ? { collectionId: opts.collectionId } : {}),
    mediaBlobs: await loadMediaBlobs(storage, state.media.keys()),
  });
  return packBackup(built, { withMedia: true }).bytes;
}

export interface TakeBackupResult {
  info: StoredBackupInfo;
  /** Set when the sync-folder copy was wanted but could not be written. */
  syncCopyError?: string;
  syncCopyWritten?: boolean;
}

let inFlight: Promise<TakeBackupResult | null> | null = null;

/** Takes one snapshot now, keeps it, prunes past the rolling window and copies it if asked. */
export async function takeBackup(
  ctx: BackupContext,
  reason: BackupReason,
  opts: { kind?: BackupKind } = {},
): Promise<TakeBackupResult | null> {
  const storage = ctx.platform.storage;
  const store = await openBackupStore(storage);
  if (!store) return null;
  const run = async (): Promise<TakeBackupResult> => {
    const nowMs = Date.now();
    const state = ctx.getState();
    const meta = ctx.getMeta();
    const existing = await store.list();
    const kind = opts.kind ?? chooseBackupKind(existing, totalMediaBytes(state), nowMs);
    const built = buildBackup(state, {
      backupId: uuidv7(nowMs),
      kind,
      reason,
      nowMs,
      deviceId: meta.deviceId,
      ...(meta.collectionId !== undefined ? { collectionId: meta.collectionId } : {}),
      ...(kind === 'full' ? { mediaBlobs: await loadMediaBlobs(storage, state.media.keys()) } : {}),
    });
    const packed = packBackup(built, { withMedia: true });
    const info: StoredBackupInfo = { ...packed.manifest, size_bytes: packed.bytes.byteLength };
    await store.put(info, packed.bytes);
    for (const id of selectBackupsToPrune([...existing, info])) {
      await store.delete(id);
    }
    const result: TakeBackupResult = { info };
    const settings = await loadBackupSettings(storage);
    const provider = ctx.getSyncProvider();
    if (settings.syncFolderCopy && provider !== 'none') {
      try {
        const transport = await resolveSyncFolderTransport(ctx.platform, provider);
        if (!transport) throw new Error('The sync folder is not available right now.');
        const copy = info.media_included
          ? packBackup(built, { withMedia: false }).bytes
          : packed.bytes;
        await transport.write(syncFolderBackupPath(meta.deviceId, nowMs), copy);
        result.syncCopyWritten = true;
      } catch (err) {
        result.syncCopyError = err instanceof Error ? err.message : String(err);
      }
    }
    return result;
  };
  const previous = inFlight ?? Promise.resolve(null);
  const next = previous.catch(() => null).then(run);
  inFlight = next;
  try {
    return await next;
  } finally {
    if (inFlight === next) inFlight = null;
  }
}

/** Takes the automatic snapshot when one is due; `null` when nothing was taken. */
export async function runAutoBackupIfDue(ctx: BackupContext): Promise<TakeBackupResult | null> {
  const storage = ctx.platform.storage;
  const store = await openBackupStore(storage);
  if (!store || inFlight) return null;
  const existing = await store.list();
  if (!isAutoBackupDue(existing, ctx.getState(), Date.now(), ctx.getMeta().collectionId)) {
    return null;
  }
  return takeBackup(ctx, 'auto');
}

const AUTO_BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Checks now, every hour while the app runs, and when the app comes back to the foreground. */
export function startAutoBackups(ctx: BackupContext): () => void {
  // Persistent storage keeps the browser from evicting the collection and its backups (§4.4).
  ctx.platform.storage.requestPersistence().catch(() => false);
  const check = (): void => {
    runAutoBackupIfDue(ctx).catch((err: unknown) => {
      console.warn('Automatic backup failed', err);
    });
  };
  check();
  const timer = window.setInterval(check, AUTO_BACKUP_CHECK_INTERVAL_MS);
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') check();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

export interface SyncFolderBackupEntry {
  path: string;
  deviceId: string;
  updatedAt?: number;
  size: number;
}

/** Snapshot copies in the sync folder, every device's, newest first. */
export async function listSyncFolderBackups(ctx: BackupContext): Promise<SyncFolderBackupEntry[]> {
  const transport = await resolveSyncFolderTransport(ctx.platform, ctx.getSyncProvider());
  if (!transport) return [];
  const files = await transport.list(SYNC_FOLDER_BACKUP_PREFIX);
  const out: SyncFolderBackupEntry[] = [];
  for (const f of files) {
    const parsed = parseSyncFolderBackupPath(f.path);
    if (!parsed) continue;
    out.push({
      path: f.path,
      deviceId: parsed.deviceId,
      size: f.size,
      ...(f.updatedAt !== undefined ? { updatedAt: f.updatedAt } : {}),
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function readSyncFolderBackup(ctx: BackupContext, path: string): Promise<Uint8Array> {
  const transport = await resolveSyncFolderTransport(ctx.platform, ctx.getSyncProvider());
  if (!transport) throw new Error('The sync folder is not available right now.');
  return transport.read(path);
}

export interface PreparedRestore {
  read: ReadBackupResult;
  plan: RestorePlan;
}

/** Reads a backup archive and plans its restore against the current collection (no changes). */
export function prepareRestore(
  ctx: BackupContext,
  bytes: Uint8Array,
  opts: { undoNewerReviews?: boolean } = {},
): PreparedRestore {
  const read = readBackupArchive(bytes);
  const plan = planBackupRestore(ctx.getState(), read.state, opts);
  return { read, plan };
}

export interface RestoreResult {
  eventCount: number;
  /** Media the backup lists that neither the backup file nor this device has. */
  mediaMissing: number;
  preRestoreBackup?: StoredBackupInfo;
}

/**
 * Applies a restore the user confirmed: saves a `pre-restore` snapshot first (so the restore can
 * be reverted), stores the backup's media this device lacks, then appends the planned events.
 * The plan is computed again on the current collection, which may have changed since the preview.
 */
export async function applyRestore(
  ctx: RestoreContext,
  read: ReadBackupResult,
  opts: { undoNewerReviews?: boolean } = {},
): Promise<RestoreResult> {
  const storage = ctx.platform.storage;
  const result: RestoreResult = { eventCount: 0, mediaMissing: 0 };
  const current = ctx.getState();
  if (current.decks.size > 0 || current.notes.size > 0) {
    const pre = await takeBackup(ctx, 'pre-restore', { kind: 'daily' });
    if (pre) result.preRestoreBackup = pre.info;
  }
  for (const hash of read.state.media.keys()) {
    if (await storage.getMedia(hash)) continue;
    const file = read.media.get(hash);
    if (file && verifyBackupMedia(file)) {
      await storage.putMedia({ hash: file.hash, mime: file.mime, bytes: file.bytes });
    } else {
      // A synced device can still pull it from the sync folder's media store.
      result.mediaMissing += 1;
    }
  }
  const plan = planBackupRestore(ctx.getState(), read.state, opts);
  const events = restoreStepsToEvents(plan.steps, ctx.getEventFactory(), Date.now());
  ctx.emitEvents(events);
  result.eventCount = events.length;
  return result;
}
