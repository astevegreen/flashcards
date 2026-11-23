import type { FlashEvent, SyncCursorState } from '@flash/core';
import type {
  DeviceMeta,
  LocalSnapshotRecord,
  MaterializedCardRow,
  BackupStore,
  MediaBlob,
  StoredBackupInfo,
  Storage,
  SyncConfig,
} from '@flash/platform';

export interface SqliteDriver {
  execute(sql: string, params?: readonly unknown[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS events (
    local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    device TEXT NOT NULL,
    seq INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    type TEXT NOT NULL,
    v INTEGER NOT NULL,
    card_id TEXT,
    payload_json TEXT NOT NULL,
    extra_fields_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_device_seq ON events(device, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_events_hlc ON events(hlc)`,
  `CREATE INDEX IF NOT EXISTS idx_events_card_id ON events(card_id)`,
  `CREATE TABLE IF NOT EXISTS cards_cache (
    id TEXT PRIMARY KEY,
    deck_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    layout_id TEXT NOT NULL,
    due INTEGER NOT NULL,
    schedule_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cards_deck_due ON cards_cache(deck_id, due)`,
  `CREATE TABLE IF NOT EXISTS media (
    hash TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    bytes_b64 TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS backups (
    backup_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    info_json TEXT NOT NULL,
    bytes_b64 TEXT NOT NULL
  )`,
] as const;

const KNOWN_ENVELOPE_KEYS = new Set(['id', 'device', 'seq', 'hlc', 'type', 'v', 'payload']);
const META_KV_KEY = '__device_meta';
const SYNC_CURSOR_KV_KEY = 'sync_cursor';
const SYNC_CONFIG_KV_KEY = 'sync_config';
const SNAPSHOT_KV_KEY = '__local_snapshot';

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function extractCardId(event: FlashEvent): string | null {
  if (
    event.payload &&
    typeof event.payload === 'object' &&
    'card_id' in event.payload &&
    typeof (event.payload as { card_id?: unknown }).card_id === 'string'
  ) {
    return (event.payload as { card_id: string }).card_id;
  }
  return null;
}

function extractExtraFields(event: FlashEvent): Record<string, unknown> | null {
  let extras: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(event as unknown as Record<string, unknown>)) {
    if (!KNOWN_ENVELOPE_KEYS.has(k)) {
      if (!extras) extras = {};
      extras[k] = v;
    }
  }
  return extras;
}

interface StoredEventDbRow {
  local_seq: number;
  id: string;
  device: string;
  seq: number;
  hlc: string;
  type: string;
  v: number;
  card_id: string | null;
  payload_json: string;
  extra_fields_json: string | null;
}

function rowToEvent(row: StoredEventDbRow): FlashEvent {
  const base: Record<string, unknown> = {
    ...(row.extra_fields_json
      ? (JSON.parse(row.extra_fields_json) as Record<string, unknown>)
      : {}),
    id: row.id,
    device: row.device,
    seq: row.seq,
    hlc: row.hlc,
    type: row.type,
    v: row.v,
    payload: JSON.parse(row.payload_json) as unknown,
  };
  return base as unknown as FlashEvent;
}

/**
 * Pure TypeScript in-memory SQLite-table emulator used for Node/Vitest tests and web fallback
 * when no native `@capacitor-community/sqlite` driver is injected.
 */
/** A bound SQL parameter as text (strings as they are, anything else `String`-ed). */
function paramText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  return String(value as number | boolean | bigint);
}

export class InMemorySqliteDriver implements SqliteDriver {
  private events: StoredEventDbRow[] = [];
  private nextLocalSeq = 1;
  private cards = new Map<
    string,
    {
      id: string;
      deck_id: string;
      note_id: string;
      layout_id: string;
      due: number;
      schedule_json: string;
    }
  >();
  private media = new Map<string, { hash: string; mime: string; bytes_b64: string }>();
  private kv = new Map<string, string>();
  private backups = new Map<
    string,
    { backup_id: string; created_at: number; info_json: string; bytes_b64: string }
  >();

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    const norm = sql.trim().replace(/\s+/g, ' ');
    if (norm.startsWith('CREATE TABLE') || norm.startsWith('CREATE INDEX')) return;

    if (norm.startsWith('INSERT OR IGNORE INTO events')) {
      const id = String(params[0] ?? '');
      if (this.events.some((e) => e.id === id)) return;
      this.events.push({
        local_seq: this.nextLocalSeq++,
        id,
        device: String(params[1] ?? ''),
        seq: Number(params[2] ?? 0),
        hlc: String(params[3] ?? ''),
        type: String(params[4] ?? ''),
        v: Number(params[5] ?? 1),
        card_id: params[6] !== null && params[6] !== undefined ? String(params[6]) : null,
        payload_json: String(params[7] ?? 'null'),
        extra_fields_json: params[8] !== null && params[8] !== undefined ? String(params[8]) : null,
      });
      return;
    }
    if (norm.startsWith('DELETE FROM cards_cache WHERE id =')) {
      this.cards.delete(String(params[0] ?? ''));
      return;
    }
    if (norm.startsWith('DELETE FROM cards_cache')) {
      this.cards.clear();
      return;
    }
    if (norm.startsWith('INSERT OR REPLACE INTO cards_cache')) {
      const id = String(params[0] ?? '');
      this.cards.set(id, {
        id,
        deck_id: String(params[1] ?? ''),
        note_id: String(params[2] ?? ''),
        layout_id: String(params[3] ?? ''),
        due: Number(params[4] ?? 0),
        schedule_json: String(params[5] ?? '{}'),
      });
      return;
    }
    if (norm.startsWith('INSERT OR REPLACE INTO media')) {
      const hash = String(params[0] ?? '');
      this.media.set(hash, {
        hash,
        mime: String(params[1] ?? ''),
        bytes_b64: String(params[2] ?? ''),
      });
      return;
    }
    if (norm.startsWith('INSERT OR REPLACE INTO kv')) {
      this.kv.set(String(params[0] ?? ''), String(params[1] ?? 'null'));
      return;
    }
    if (norm.startsWith('INSERT OR REPLACE INTO backups')) {
      const backupId = paramText(params[0], '');
      this.backups.set(backupId, {
        backup_id: backupId,
        created_at: Number(params[1] ?? 0),
        info_json: paramText(params[2], 'null'),
        bytes_b64: paramText(params[3], ''),
      });
      return;
    }
    if (norm.startsWith('DELETE FROM backups WHERE backup_id =')) {
      this.backups.delete(paramText(params[0], ''));
      return;
    }
    if (norm.startsWith('DELETE FROM kv WHERE key =')) {
      this.kv.delete(String(params[0] ?? ''));
      return;
    }
    if (norm.startsWith('DELETE FROM events')) {
      this.events = [];
      this.nextLocalSeq = 1;
      return;
    }
    if (norm.startsWith('DELETE FROM media')) {
      this.media.clear();
      return;
    }
    if (norm.startsWith('DELETE FROM kv')) {
      this.kv.clear();
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const norm = sql.trim().replace(/\s+/g, ' ');

    if (norm.startsWith('SELECT COALESCE(MAX(local_seq), 0) AS max_seq FROM events')) {
      const maxSeq =
        this.events.length > 0 ? (this.events[this.events.length - 1]?.local_seq ?? 0) : 0;
      return [{ max_seq: maxSeq } as T];
    }

    if (norm.includes('FROM events')) {
      let rows = [...this.events];
      if (norm.includes('WHERE hlc >= ?')) {
        const since = String(params[0] ?? '');
        rows = rows.filter((r) => r.hlc >= since);
      } else if (norm.includes('WHERE card_id = ?')) {
        const cardId = String(params[0] ?? '');
        rows = rows.filter((r) => r.card_id === cardId);
      } else if (norm.includes('WHERE device = ? AND seq > ?')) {
        const dev = String(params[0] ?? '');
        const afterSeq = Number(params[1] ?? 0);
        rows = rows.filter((r) => r.device === dev && r.seq > afterSeq);
        rows.sort((a, b) => a.seq - b.seq);
        return rows as T[];
      } else if (norm.includes('WHERE local_seq > ?')) {
        const afterLocal = Number(params[0] ?? 0);
        rows = rows.filter((r) => r.local_seq > afterLocal);
        rows.sort((a, b) => a.local_seq - b.local_seq);
        return rows as T[];
      }
      rows.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : 1));
      return rows as T[];
    }

    if (norm.includes('FROM cards_cache')) {
      return [...this.cards.values()] as T[];
    }
    if (norm.startsWith('SELECT hash, mime, bytes_b64 FROM media WHERE hash = ?')) {
      const row = this.media.get(String(params[0] ?? ''));
      return row ? ([row] as T[]) : [];
    }
    if (norm.startsWith('SELECT hash FROM media')) {
      return [...this.media.keys()].map((hash) => ({ hash }) as T);
    }
    if (norm.startsWith('SELECT info_json FROM backups')) {
      return [...this.backups.values()]
        .sort((a, b) => b.created_at - a.created_at)
        .map((r) => ({ info_json: r.info_json }) as T);
    }
    if (norm.startsWith('SELECT bytes_b64 FROM backups WHERE backup_id = ?')) {
      const row = this.backups.get(paramText(params[0], ''));
      return row ? ([{ bytes_b64: row.bytes_b64 }] as T[]) : [];
    }
    if (norm.startsWith('SELECT value_json FROM kv WHERE key = ?')) {
      const raw = this.kv.get(String(params[0] ?? ''));
      return raw !== undefined ? ([{ value_json: raw }] as T[]) : [];
    }
    return [];
  }
}

/**
 * Native SQLite `Storage` adapter for Capacitor Android & iOS shells (§11, §14, §15 Phase 8).
 */
export class CapacitorSqliteStorage implements Storage {
  private readonly driver: SqliteDriver;
  private initializedPromise: Promise<void> | null = null;

  constructor(driver?: SqliteDriver) {
    this.driver = driver ?? new InMemorySqliteDriver();
  }

  private async ensureReady(): Promise<void> {
    if (!this.initializedPromise) {
      this.initializedPromise = (async () => {
        for (const stmt of SCHEMA_STATEMENTS) {
          await this.driver.execute(stmt);
        }
      })();
    }
    await this.initializedPromise;
  }

  async appendEvents(events: readonly FlashEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureReady();
    for (const ev of events) {
      const extras = extractExtraFields(ev);
      await this.driver.execute(
        `INSERT OR IGNORE INTO events (id, device, seq, hlc, type, v, card_id, payload_json, extra_fields_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ev.id,
          ev.device,
          ev.seq,
          ev.hlc,
          ev.type,
          ev.v,
          extractCardId(ev),
          JSON.stringify(ev.payload ?? null),
          extras ? JSON.stringify(extras) : null,
        ],
      );
    }
  }

  async getEvents(sinceHlc?: string): Promise<FlashEvent[]> {
    await this.ensureReady();
    const rows = sinceHlc
      ? await this.driver.query<StoredEventDbRow>(
          `SELECT * FROM events WHERE hlc >= ? ORDER BY hlc ASC, id ASC`,
          [sinceHlc],
        )
      : await this.driver.query<StoredEventDbRow>(`SELECT * FROM events ORDER BY hlc ASC, id ASC`);
    return rows.map(rowToEvent);
  }

  async getEventsForCard(cardId: string): Promise<FlashEvent[]> {
    await this.ensureReady();
    const rows = await this.driver.query<StoredEventDbRow>(
      `SELECT * FROM events WHERE card_id = ? ORDER BY hlc ASC, id ASC`,
      [cardId],
    );
    return rows.map(rowToEvent);
  }

  async getAllEvents(): Promise<FlashEvent[]> {
    return this.getEvents();
  }

  async getDeviceEventsAfterSeq(deviceId: string, afterSeq: number): Promise<FlashEvent[]> {
    await this.ensureReady();
    const rows = await this.driver.query<StoredEventDbRow>(
      `SELECT * FROM events WHERE device = ? AND seq > ? ORDER BY seq ASC`,
      [deviceId, afterSeq],
    );
    return rows.map(rowToEvent);
  }

  async getEventsAfterLocalSeq(
    afterLocalSeq: number,
  ): Promise<{ events: FlashEvent[]; maxLocalSeq: number }> {
    await this.ensureReady();
    const rows = await this.driver.query<StoredEventDbRow>(
      `SELECT * FROM events WHERE local_seq > ? ORDER BY local_seq ASC`,
      [afterLocalSeq],
    );
    const maxLocalSeq =
      rows.length > 0 ? (rows[rows.length - 1]?.local_seq ?? afterLocalSeq) : afterLocalSeq;
    return { events: rows.map(rowToEvent), maxLocalSeq };
  }

  async getMaxLocalSeq(): Promise<number> {
    await this.ensureReady();
    const rows = await this.driver.query<{ max_seq: number }>(
      `SELECT COALESCE(MAX(local_seq), 0) AS max_seq FROM events`,
    );
    return rows[0]?.max_seq ?? 0;
  }

  async getDeviceMeta(): Promise<DeviceMeta | undefined> {
    return this.getKv<DeviceMeta>(META_KV_KEY);
  }

  async setDeviceMeta(meta: DeviceMeta): Promise<void> {
    await this.setKv(META_KV_KEY, meta);
  }

  async saveMaterializedCards(cards: readonly MaterializedCardRow[]): Promise<void> {
    await this.ensureReady();
    await this.driver.execute(`DELETE FROM cards_cache`);
    await this.upsertMaterializedCards(cards);
  }

  async upsertMaterializedCards(cards: readonly MaterializedCardRow[]): Promise<void> {
    if (cards.length === 0) return;
    await this.ensureReady();
    for (const c of cards) {
      await this.driver.execute(
        `INSERT OR REPLACE INTO cards_cache (id, deck_id, note_id, layout_id, due, schedule_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [c.id, c.deck_id, c.note_id, c.layout_id, c.due, JSON.stringify(c.schedule)],
      );
    }
  }

  async deleteMaterializedCards(cardIds: readonly string[]): Promise<void> {
    if (cardIds.length === 0) return;
    await this.ensureReady();
    for (const id of cardIds) {
      await this.driver.execute(`DELETE FROM cards_cache WHERE id = ?`, [id]);
    }
  }

  async loadMaterializedCards(): Promise<MaterializedCardRow[]> {
    await this.ensureReady();
    const rows = await this.driver.query<{
      id: string;
      deck_id: string;
      note_id: string;
      layout_id: string;
      due: number;
      schedule_json: string;
    }>(`SELECT id, deck_id, note_id, layout_id, due, schedule_json FROM cards_cache`);
    return rows.map((r) => ({
      id: r.id,
      deck_id: r.deck_id,
      note_id: r.note_id,
      layout_id: r.layout_id,
      due: r.due,
      schedule: JSON.parse(r.schedule_json) as MaterializedCardRow['schedule'],
    }));
  }

  async getSyncCursor(): Promise<SyncCursorState | undefined> {
    return this.getKv<SyncCursorState>(SYNC_CURSOR_KV_KEY);
  }

  async setSyncCursor(cursor: SyncCursorState): Promise<void> {
    await this.setKv(SYNC_CURSOR_KV_KEY, cursor);
  }

  async getSyncConfig(): Promise<SyncConfig | undefined> {
    return this.getKv<SyncConfig>(SYNC_CONFIG_KV_KEY);
  }

  async setSyncConfig(config: SyncConfig): Promise<void> {
    await this.setKv(SYNC_CONFIG_KV_KEY, config);
  }

  async getLocalSnapshot(): Promise<LocalSnapshotRecord | undefined> {
    return this.getKv<LocalSnapshotRecord>(SNAPSHOT_KV_KEY);
  }

  async setLocalSnapshot(record: LocalSnapshotRecord): Promise<void> {
    await this.setKv(SNAPSHOT_KV_KEY, record);
  }

  async getKv<T = unknown>(key: string): Promise<T | undefined> {
    await this.ensureReady();
    const rows = await this.driver.query<{ value_json: string }>(
      `SELECT value_json FROM kv WHERE key = ?`,
      [key],
    );
    const raw = rows[0]?.value_json;
    return raw !== undefined ? (JSON.parse(raw) as T) : undefined;
  }

  async setKv(key: string, value: unknown): Promise<void> {
    await this.ensureReady();
    await this.driver.execute(`INSERT OR REPLACE INTO kv (key, value_json) VALUES (?, ?)`, [
      key,
      JSON.stringify(value),
    ]);
  }

  async deleteKv(key: string): Promise<void> {
    await this.ensureReady();
    await this.driver.execute(`DELETE FROM kv WHERE key = ?`, [key]);
  }

  async putMedia(media: MediaBlob): Promise<void> {
    await this.ensureReady();
    await this.driver.execute(
      `INSERT OR REPLACE INTO media (hash, mime, bytes_b64) VALUES (?, ?, ?)`,
      [media.hash.toLowerCase(), media.mime, bytesToBase64(media.bytes)],
    );
  }

  async getMedia(hash: string): Promise<MediaBlob | undefined> {
    await this.ensureReady();
    const rows = await this.driver.query<{ hash: string; mime: string; bytes_b64: string }>(
      `SELECT hash, mime, bytes_b64 FROM media WHERE hash = ?`,
      [hash.toLowerCase()],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      hash: row.hash,
      mime: row.mime,
      bytes: base64ToBytes(row.bytes_b64),
    };
  }

  async listMediaHashes(): Promise<string[]> {
    await this.ensureReady();
    const rows = await this.driver.query<{ hash: string }>(`SELECT hash FROM media`);
    return rows.map((r) => r.hash);
  }

  /** Rolling backups in the `backups` table (manifest JSON beside the archive). */
  async openBackupStore(): Promise<BackupStore> {
    await this.ensureReady();
    const driver = this.driver;
    return {
      list: async () => {
        const rows = await driver.query<{ info_json: string }>(
          `SELECT info_json FROM backups ORDER BY created_at DESC`,
        );
        return rows.map((r) => JSON.parse(r.info_json) as StoredBackupInfo);
      },
      put: async (info, bytes) => {
        await driver.execute(
          `INSERT OR REPLACE INTO backups (backup_id, created_at, info_json, bytes_b64) VALUES (?, ?, ?, ?)`,
          [info.backup_id, info.created_at, JSON.stringify(info), bytesToBase64(bytes)],
        );
      },
      getBytes: async (backupId) => {
        const rows = await driver.query<{ bytes_b64: string }>(
          `SELECT bytes_b64 FROM backups WHERE backup_id = ?`,
          [backupId],
        );
        const raw = rows[0]?.bytes_b64;
        return raw !== undefined ? base64ToBytes(raw) : undefined;
      },
      delete: async (backupId) => {
        await driver.execute(`DELETE FROM backups WHERE backup_id = ?`, [backupId]);
      },
    };
  }

  async requestPersistence(): Promise<boolean> {
    // Native SQLite on-device storage is inherently persistent (exempt from browser eviction).
    return true;
  }

  /**
   * Rebuilds the database file (`VACUUM`), so free pages keep nothing an older build deleted
   * before `secure_delete` was on (e.g. tokens moved to the Keychain / Keystore). Slow on a large
   * collection: run it once, not on every launch.
   */
  async scrubFreePages(): Promise<void> {
    await this.ensureReady();
    await this.driver.execute('VACUUM');
  }

  async clearAll(): Promise<void> {
    await this.ensureReady();
    await this.driver.execute(`DELETE FROM events`);
    await this.driver.execute(`DELETE FROM cards_cache`);
    await this.driver.execute(`DELETE FROM media`);
    await this.driver.execute(`DELETE FROM kv`);
  }
}
