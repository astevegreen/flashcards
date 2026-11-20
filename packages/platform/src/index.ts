import type { CardScheduleState, FlashEvent, HlcState } from '@flash/core';

export interface DeviceMeta {
  deviceId: string;
  seq: number;
  hlc: HlcState;
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

export interface Storage {
  appendEvents(events: readonly FlashEvent[]): Promise<void>;
  getEvents(sinceHlc?: string): Promise<FlashEvent[]>;
  getEventsForCard(cardId: string): Promise<FlashEvent[]>;
  getAllEvents(): Promise<FlashEvent[]>;
  getDeviceMeta(): Promise<DeviceMeta | undefined>;
  setDeviceMeta(meta: DeviceMeta): Promise<void>;
  saveMaterializedCards(cards: readonly MaterializedCardRow[]): Promise<void>;
  loadMaterializedCards(): Promise<MaterializedCardRow[]>;
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

/** Minimal interface stubs for Phases 2-8. */
export interface AuthSession {
  provider: string;
  accessToken: string;
  expiresAt: number;
}

export interface Auth {
  getSession(): Promise<AuthSession | null>;
  signIn(): Promise<AuthSession>;
  signOut(): Promise<void>;
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
  readonly storage: Storage;
  readonly files: Files;
  readonly syncTransport: SyncTransport;
}
