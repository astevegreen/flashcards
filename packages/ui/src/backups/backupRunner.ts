import type { CollectionState, EventFactory, KnownEvent } from '@flash/core';
import {
  buildBackupAsync,
  chooseBackupKind,
  isAutoBackupDue,
  packBackupAsync,
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
  const built = await buildBackupAsync(
    state,
    {
      backupId: uuidv7(nowMs),
      kind: 'full',
      reason: 'manual',
      nowMs,
      deviceId: opts.deviceId,
      ...(opts.collectionId !== undefined ? { collectionId: opts.collectionId } : {}),
      mediaBlobs: await loadMediaBlobs(storage, state.media.keys()),
    },
    yieldToHost,
  );
  return (await packBackupAsync(built, { withMedia: true }, yieldToHost)).bytes;
}

export interface TakeBackupResult {
  info: StoredBackupInfo;
  /** Set when the sync-folder copy was wanted but could not be written. */
  syncCopyError?: string;
  syncCopyWritten?: boolean;
}

/** A snapshot that was not saved (low storage, or the write failed). Event writes are unaffected. */
export class BackupNotSavedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BackupNotSavedError';
  }
}

export const BACKUP_STATUS_KV_KEY = 'backup_status_v1';

export interface BackupStatus {
  /** Why the last snapshot was not saved; absent after a successful one. */
  lastError?: string;
  at: number;
}

export async function loadBackupStatus(storage: Storage): Promise<BackupStatus | undefined> {
  return storage.getKv<BackupStatus>(BACKUP_STATUS_KV_KEY);
}

/** Free space a snapshot must leave: twice its size plus a margin, so event writes never run out. */
const QUOTA_MARGIN_BYTES = 50 * 1024 * 1024;

/** `navigator.storage.estimate()` where the platform has it; `null` elsewhere (native shells). */
async function freeStorageBytes(): Promise<number | null> {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    if (!estimate || typeof estimate.quota !== 'number' || typeof estimate.usage !== 'number') {
      return null;
    }
    return estimate.quota - estimate.usage;
  } catch {
    return null;
  }
}

/** Yields to the browser between the heavy steps of a snapshot (§8). */
function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let inFlight: Promise<TakeBackupResult | null> | null = null;

/** A snapshot that hasn't finished by then is given up on, so `inFlight` always clears. */
export const BACKUP_TIMEOUT_MS = 10 * 60 * 1000;

function settleWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BackupNotSavedError('The backup took too long and was stopped.')),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function writeSnapshot(
  ctx: BackupContext,
  store: BackupStore,
  reason: BackupReason,
  opts: { kind?: BackupKind; protect?: readonly string[] },
): Promise<TakeBackupResult> {
  const storage = ctx.platform.storage;
  const nowMs = Date.now();
  const state = ctx.getState();
  const meta = ctx.getMeta();
  const existing = await store.list();
  // Native stores have no reliable free-space figure: after a failed write, skip the big
  // (media) snapshots until one succeeds again, so backups can't crowd out event writes.
  const lastFailed = Boolean((await loadBackupStatus(storage))?.lastError);
  const kind =
    opts.kind ??
    (lastFailed && !store.measuredByStorageEstimate
      ? 'daily'
      : chooseBackupKind(existing, totalMediaBytes(state), nowMs));
  const mediaBlobs =
    kind === 'full' ? await loadMediaBlobs(storage, state.media.keys()) : undefined;
  const built = await buildBackupAsync(
    state,
    {
      backupId: uuidv7(nowMs),
      kind,
      reason,
      nowMs,
      deviceId: meta.deviceId,
      ...(meta.collectionId !== undefined ? { collectionId: meta.collectionId } : {}),
      ...(mediaBlobs ? { mediaBlobs } : {}),
    },
    yieldToHost,
  );
  const packed = await packBackupAsync(built, { withMedia: true }, yieldToHost);
  const info: StoredBackupInfo = { ...packed.manifest, size_bytes: packed.bytes.byteLength };

  const free = store.measuredByStorageEstimate ? await freeStorageBytes() : null;
  if (free !== null && free < info.size_bytes * 2 + QUOTA_MARGIN_BYTES) {
    throw new BackupNotSavedError(
      'Not enough free storage on this device for a backup. Download one, or free up space.',
    );
  }
  try {
    await store.put(info, packed.bytes);
  } catch (err) {
    throw new BackupNotSavedError(
      `The backup could not be saved: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  // Pruned only once the new snapshot is safely stored.
  const prune = selectBackupsToPrune([...existing, info], {
    nowMs,
    protect: [info.backup_id, ...(opts.protect ?? [])],
  });
  for (const id of prune) await store.delete(id);

  const result: TakeBackupResult = { info };
  const settings = await loadBackupSettings(storage);
  const provider = ctx.getSyncProvider();
  if (settings.syncFolderCopy && provider !== 'none') {
    try {
      const transport = await resolveSyncFolderTransport(ctx.platform, provider);
      if (!transport) throw new Error('The sync folder is not available right now.');
      const copy = info.media_included
        ? (await packBackupAsync(built, { withMedia: false }, yieldToHost)).bytes
        : packed.bytes;
      await transport.write(syncFolderBackupPath(meta.deviceId, nowMs), copy);
      result.syncCopyWritten = true;
    } catch (err) {
      result.syncCopyError = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
}

/**
 * Takes one snapshot now, keeps it, prunes past the rolling window and copies it if asked. A
 * snapshot that can't be saved throws {@link BackupNotSavedError} and is recorded for Settings;
 * it never touches the event log, so a quota error here can't break normal edits.
 */
export async function takeBackup(
  ctx: BackupContext,
  reason: BackupReason,
  opts: { kind?: BackupKind; protect?: readonly string[]; timeoutMs?: number } = {},
): Promise<TakeBackupResult | null> {
  const storage = ctx.platform.storage;
  const store = await openBackupStore(storage);
  if (!store) return null;
  const run = async (): Promise<TakeBackupResult> => {
    try {
      const result = await settleWithin(
        writeSnapshot(ctx, store, reason, opts),
        opts.timeoutMs ?? BACKUP_TIMEOUT_MS,
      );
      await storage.setKv(BACKUP_STATUS_KV_KEY, { at: Date.now() } satisfies BackupStatus);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await storage
        .setKv(BACKUP_STATUS_KV_KEY, { lastError: message, at: Date.now() } satisfies BackupStatus)
        .catch(() => undefined);
      throw err;
    }
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

/**
 * Checks now, every hour while the app runs, and when the app comes back to the foreground.
 * `onPersistence` gets the answer to the persistent-storage request.
 */
export function startAutoBackups(
  ctx: BackupContext,
  onPersistence?: (granted: boolean) => void,
): () => void {
  // Persistent storage keeps the browser from evicting the collection and its backups (§4.4).
  ctx.platform.storage
    .requestPersistence()
    .catch(() => false)
    .then((granted) => onPersistence?.(granted))
    .catch(() => undefined);
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
export function prepareRestore(ctx: BackupContext, bytes: Uint8Array): PreparedRestore {
  const read = readBackupArchive(bytes);
  const plan = planBackupRestore(ctx.getState(), read.state);
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
): Promise<RestoreResult> {
  const storage = ctx.platform.storage;
  const result: RestoreResult = { eventCount: 0, mediaMissing: 0 };
  const current = ctx.getState();
  if (current.decks.size > 0 || current.notes.size > 0) {
    // Kept apart from the rolling snapshots; the backup being restored is never pruned for it.
    const pre = await takeBackup(ctx, 'pre-restore', {
      kind: 'daily',
      protect: [read.manifest.backup_id],
    });
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
  const plan = planBackupRestore(ctx.getState(), read.state);
  const events = restoreStepsToEvents(plan.steps, ctx.getEventFactory(), Date.now());
  ctx.emitEvents(events);
  result.eventCount = events.length;
  return result;
}
