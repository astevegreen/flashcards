import type {
  CardScheduleState,
  CollectionStatePatch,
  FlashEvent,
  HlcState,
  SerializedCollectionState,
  SyncCursorState,
} from '@flash/core';

export interface DeviceMeta {
  deviceId: string;
  seq: number;
  hlc: HlcState;
  collectionId?: string;
  lastBackupAt?: number;
  backupReminderDismissedAt?: number;
  seeded?: boolean;
}

export interface MaterializedCardRow {
  id: string;
  deck_id: string;
  note_id: string;
  layout_id: string;
  due: number;
  schedule: CardScheduleState;
}

export interface MediaBlob {
  hash: string;
  mime: string;
  bytes: Uint8Array;
}

export type SyncProviderKind = 'none' | 'dev_channel' | 'google_drive' | 'local_folder';

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
  appendEvents(events: readonly FlashEvent[]): Promise<void>;
  getEvents(sinceHlc?: string): Promise<FlashEvent[]>;
  getEventsForCard(cardId: string): Promise<FlashEvent[]>;
  getAllEvents(): Promise<FlashEvent[]>;
  getDeviceEventsAfterSeq(deviceId: string, afterSeq: number): Promise<FlashEvent[]>;
  getEventsAfterLocalSeq(
    afterLocalSeq: number,
  ): Promise<{ events: FlashEvent[]; maxLocalSeq: number }>;
  getMaxLocalSeq(): Promise<number>;
  getDeviceMeta(): Promise<DeviceMeta | undefined>;
  setDeviceMeta(meta: DeviceMeta): Promise<void>;
  saveMaterializedCards(cards: readonly MaterializedCardRow[]): Promise<void>;
  upsertMaterializedCards(cards: readonly MaterializedCardRow[]): Promise<void>;
  deleteMaterializedCards(cardIds: readonly string[]): Promise<void>;
  loadMaterializedCards(): Promise<MaterializedCardRow[]>;
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
  requestPersistence(): Promise<boolean>;
  clearAll(): Promise<void>;
}

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

export interface Files {
  pickFile(options?: { accept?: string }): Promise<PickedFile | null>;
  downloadFile(filename: string, data: Uint8Array, mimeType: string): Promise<void>;
  /** Optional PC local folder picker (Phase 3). */
  pickDirectory?(): Promise<unknown>;
}

export interface SyncFileInfo {
  path: string;
  size: number;
  updatedAt?: number;
}

/** Exact §4.3 SyncTransport contract. */
export interface SyncTransport {
  list(prefix: string): Promise<SyncFileInfo[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void>;
}

export interface AuthSession {
  provider: string;
  accessToken: string;
  expiresAt: number;
  scope?: string;
}

export interface Auth {
  isConfigured(): boolean;
  isConnected(): Promise<boolean>;
  getSession(): Promise<AuthSession | null>;
  getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string>;
  signIn(): Promise<AuthSession | null>;
  handleRedirectCallback(): Promise<AuthSession | null>;
  signOut(): Promise<void>;
}

/** Off-main-thread Web Worker replay client (§4.1 & §8). */
export interface ReplayWorkerClient {
  hydrate(snapshot: SerializedCollectionState): Promise<void>;
  apply(events: readonly FlashEvent[]): Promise<CollectionStatePatch>;
  terminate(): void;
}

export interface TtsProvider {
  readonly id: string;
  synthesize(text: string, lang: string): Promise<Uint8Array>;
}

export interface AudioPlayer {
  unlock(): void;
  play(bytes: Uint8Array, mime: string, rate?: number): Promise<void>;
  stop(): void;
}

export interface Purchase {
  isUnlocked(): Promise<boolean>;
  restore(): Promise<boolean>;
}

export interface PlatformServices {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly isDevMode: boolean;
  readonly hasDeviceSlug: boolean;
  readonly storage: Storage;
  readonly files: Files;
  readonly syncTransport: SyncTransport;
  readonly googleOAuthConfigured: boolean;
  readonly supportsLocalFolderSync: boolean;
  getGoogleAuth(): Promise<Auth>;
  createGoogleDriveTransport(): Promise<SyncTransport>;
  pickLocalSyncFolder(): Promise<{ name: string; transport: SyncTransport } | null>;
  restoreLocalSyncFolder(opts?: {
    requestPermission?: boolean;
  }): Promise<{ name: string; transport: SyncTransport } | null>;
  disconnectLocalSyncFolder(): Promise<void>;
  onDevSyncNotification?: (listener: (path: string) => void) => () => void;
  createReplayWorker?: () => Promise<ReplayWorkerClient | null>;
}
