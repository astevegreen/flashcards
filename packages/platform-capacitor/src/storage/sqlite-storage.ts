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
import { base64ToBytes, bytesToBase64 } from '@flash/platform-web/base64';

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
  // Keyset pagination in `getEvents` seeks on (hlc, id).
  `CREATE INDEX IF NOT EXISTS idx_events_hlc_id ON events(hlc, id)`,
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
  // Archives in chunks, so no single SQL parameter or row carries a whole (up to 100 MB) backup
  // across the native bridge. `backups.bytes_b64` stays empty for chunked rows.
  `CREATE TABLE IF NOT EXISTS backup_chunks (
    backup_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    b64 TEXT NOT NULL,
    PRIMARY KEY (backup_id, idx)
  )`,
  // Serialized local snapshots for large collections (25k+ notes) also exceed Android's bridge
  // JSON string budget as a single row, so store them in bounded text chunks too. Each write uses
  // a new `gen`; the `__local_snapshot_meta` kv row names the generation that is current.
  `CREATE TABLE IF NOT EXISTS local_snapshot_chunks (
    gen TEXT NOT NULL,
    idx INTEGER NOT NULL,
    chunk TEXT NOT NULL,
    PRIMARY KEY (gen, idx)
  )`,
  // An earlier development build's single-generation chunk table.
  `DROP TABLE IF EXISTS snapshot_chunks`,
] as const;

interface SnapshotMeta {
  gen: string;
  chunks: number;
  localSeq: number;
  savedAt: number;
}

const KNOWN_ENVELOPE_KEYS = new Set(['id', 'device', 'seq', 'hlc', 'type', 'v', 'payload']);
const META_KV_KEY = '__device_meta';
const SYNC_CURSOR_KV_KEY = 'sync_cursor';
const SYNC_CONFIG_KV_KEY = 'sync_config';
const SNAPSHOT_KV_KEY = '__local_snapshot';
const SNAPSHOT_META_KV_KEY = '__local_snapshot_meta';
const SNAPSHOT_CHUNK_CHARS = 512 * 1024;
const EVENT_QUERY_PAGE = 500;
const CARD_CACHE_QUERY_PAGE = 2000;

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

export interface StoredEventDbRow {
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

/** Raw archive bytes per `backup_chunks` row (base64 makes each row about 1.4 MB). */
const BACKUP_CHUNK_BYTES = 1024 * 1024;

/** Media hashes the kept backups list (`StoredBackupInfo.media_hashes`), from their JSON rows. */
function mediaKeptByBackups(infoJson: readonly string[]): Set<string> {
  const keep = new Set<string>();
  for (const raw of infoJson) {
    try {
      const info = JSON.parse(raw) as { media_hashes?: unknown };
      if (!Array.isArray(info.media_hashes)) continue;
      for (const h of info.media_hashes) if (typeof h === 'string') keep.add(h.toLowerCase());
    } catch {
      // A damaged row keeps nothing.
    }
  }
  return keep;
}

/**
 * Native SQLite `Storage` adapter for Capacitor Android & iOS shells (§11, §14, §15 Phase 8).
 */
export class CapacitorSqliteStorage implements Storage {
  private readonly driver: SqliteDriver;
  private initializedPromise: Promise<void> | null = null;
  /** Tail of the queued snapshot writes; it never rejects. */
  private snapshotWrites: Promise<void> = Promise.resolve();

  /**
   * `driver` is required (N9): a build that forgot to wire the native SQLite driver used to fall
   * back to an in-memory emulator and lose every review on restart, without an error.
   */
  constructor(driver: SqliteDriver) {
    if (!driver) {
      throw new Error('CapacitorSqliteStorage needs a SQLite driver; none was passed.');
    }
    this.driver = driver;
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

  async getAllEvents(): Promise<FlashEvent[]> {
    await this.ensureReady();
    const out: FlashEvent[] = [];
    // Keyset pages on (hlc, id): each page starts from an index seek, not an OFFSET scan. The
    // first page's empty `afterHlc` and `afterId` take every row (ids are never empty).
    let afterHlc = '';
    let afterId = '';
    for (;;) {
      const rows = await this.driver.query<StoredEventDbRow>(
        `SELECT * FROM events WHERE hlc >= ? AND (hlc > ? OR id > ?) ORDER BY hlc ASC, id ASC LIMIT ?`,
        [afterHlc, afterHlc, afterId, EVENT_QUERY_PAGE],
      );
      for (const row of rows) out.push(rowToEvent(row));
      const last = rows.at(-1);
      if (!last || rows.length < EVENT_QUERY_PAGE) break;
      afterHlc = last.hlc;
      afterId = last.id;
    }
    return out;
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
    const events: FlashEvent[] = [];
    let maxLocalSeq = afterLocalSeq;
    for (;;) {
      const rows = await this.driver.query<StoredEventDbRow>(
        `SELECT * FROM events WHERE local_seq > ? ORDER BY local_seq ASC LIMIT ?`,
        [maxLocalSeq, EVENT_QUERY_PAGE],
      );
      for (const row of rows) {
        events.push(rowToEvent(row));
        if (row.local_seq > maxLocalSeq) maxLocalSeq = row.local_seq;
      }
      if (rows.length < EVENT_QUERY_PAGE) break;
    }
    return { events, maxLocalSeq };
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
    const out: MaterializedCardRow[] = [];
    let afterId = '';
    for (;;) {
      const rows = await this.driver.query<{
        id: string;
        deck_id: string;
        note_id: string;
        layout_id: string;
        due: number;
        schedule_json: string;
      }>(
        `SELECT id, deck_id, note_id, layout_id, due, schedule_json FROM cards_cache WHERE id > ? ORDER BY id ASC LIMIT ?`,
        [afterId, CARD_CACHE_QUERY_PAGE],
      );
      afterId = rows.at(-1)?.id ?? afterId;
      for (const r of rows) {
        out.push({
          id: r.id,
          deck_id: r.deck_id,
          note_id: r.note_id,
          layout_id: r.layout_id,
          due: r.due,
          schedule: JSON.parse(r.schedule_json) as MaterializedCardRow['schedule'],
        });
      }
      if (rows.length < CARD_CACHE_QUERY_PAGE) break;
    }
    return out;
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

  private readSnapshotChunk(gen: string, idx: number): Promise<{ chunk: string }[]> {
    return this.driver.query<{ chunk: string }>(
      `SELECT chunk FROM local_snapshot_chunks WHERE gen = ? AND idx = ?`,
      [gen, idx],
    );
  }

  async getLocalSnapshot(): Promise<LocalSnapshotRecord | undefined> {
    await this.snapshotWrites;
    const meta = await this.getKv<SnapshotMeta>(SNAPSHOT_META_KV_KEY);
    if (meta && typeof meta.gen === 'string' && Number.isInteger(meta.chunks) && meta.chunks > 0) {
      const parts: string[] = [];
      for (let idx = 0; idx < meta.chunks; idx++) {
        // One chunk per call, so no bridge response carries more than one chunk.
        const rows = await this.readSnapshotChunk(meta.gen, idx); // NOSONAR
        const part = rows[0]?.chunk;
        if (part === undefined) return undefined;
        parts.push(part);
      }
      try {
        const snapshot = JSON.parse(parts.join('')) as LocalSnapshotRecord['snapshot'];
        return { snapshot, localSeq: meta.localSeq, savedAt: meta.savedAt };
      } catch {
        return undefined;
      }
    }
    try {
      return await this.getKv<LocalSnapshotRecord>(SNAPSHOT_KV_KEY);
    } catch {
      // A legacy single-row snapshot can be too big to read back across the bridge (the reason
      // for chunking). Boot then replays the log instead, and the next save replaces the row.
      return undefined;
    }
  }

  /**
   * Writes the chunks under a new generation and switches the meta row to it last, so a failed
   * or interrupted write leaves the previous snapshot whole. Writes run one at a time.
   */
  async setLocalSnapshot(record: LocalSnapshotRecord): Promise<void> {
    const run = this.snapshotWrites.then(() => this.writeLocalSnapshot(record));
    this.snapshotWrites = run.catch(() => undefined);
    return run;
  }

  private async writeLocalSnapshot(record: LocalSnapshotRecord): Promise<void> {
    await this.ensureReady();
    const raw = JSON.stringify(record.snapshot);
    const gen = globalThis.crypto.randomUUID();
    let chunks = 0;
    try {
      let start = 0;
      do {
        let end = Math.min(raw.length, start + SNAPSHOT_CHUNK_CHARS);
        // Never split a surrogate pair (a code point above U+FFFF starting at the last unit): a lone
        // half does not survive the UTF-8 conversion on the way into SQLite.
        if (end < raw.length && (raw.codePointAt(end - 1) ?? 0) > 0xffff) end--;
        await this.driver.execute(
          `INSERT INTO local_snapshot_chunks (gen, idx, chunk) VALUES (?, ?, ?)`,
          [gen, chunks, raw.slice(start, end)],
        );
        chunks++;
        start = end;
      } while (start < raw.length);
    } catch (err) {
      await this.driver
        .execute(`DELETE FROM local_snapshot_chunks WHERE gen = ?`, [gen])
        .catch(() => undefined);
      throw err;
    }
    const meta: SnapshotMeta = {
      gen,
      chunks,
      localSeq: record.localSeq,
      savedAt: record.savedAt,
    };
    await this.setKv(SNAPSHOT_META_KV_KEY, meta);
    await this.driver.execute(`DELETE FROM local_snapshot_chunks WHERE gen <> ?`, [gen]);
    await this.deleteKv(SNAPSHOT_KV_KEY);
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

  async deleteMedia(hash: string): Promise<void> {
    await this.ensureReady();
    await this.driver.execute(`DELETE FROM media WHERE hash = ?`, [hash.toLowerCase()]);
  }

  /** Rolling backups in the `backups` table (manifest JSON beside the archive). */
  private orphanSweep: Promise<void> | null = null;

  async openBackupStore(): Promise<BackupStore> {
    await this.ensureReady();
    const driver = this.driver;
    // Chunks a failed or interrupted write left behind (no `backups` row): once per launch.
    this.orphanSweep ??= driver
      .execute(`DELETE FROM backup_chunks WHERE backup_id NOT IN (SELECT backup_id FROM backups)`)
      .catch(() => undefined);
    await this.orphanSweep;
    return {
      // The row is written last, so a backup is listed only once all its chunks are in. A failed
      // write (a full disk) removes what it wrote; an interrupted one is swept at the next launch.
      list: async () => {
        const rows = await driver.query<{ info_json: string }>(
          `SELECT info_json FROM backups ORDER BY created_at DESC`,
        );
        return rows.map((r) => JSON.parse(r.info_json) as StoredBackupInfo);
      },
      put: async (info, bytes) => {
        const id = info.backup_id;
        try {
          await driver.execute(`DELETE FROM backups WHERE backup_id = ?`, [id]);
          await driver.execute(`DELETE FROM backup_chunks WHERE backup_id = ?`, [id]);
          for (let idx = 0; idx * BACKUP_CHUNK_BYTES < bytes.byteLength; idx++) {
            const chunk = bytes.subarray(idx * BACKUP_CHUNK_BYTES, (idx + 1) * BACKUP_CHUNK_BYTES);
            await driver.execute(
              `INSERT INTO backup_chunks (backup_id, idx, b64) VALUES (?, ?, ?)`,
              [id, idx, bytesToBase64(chunk)],
            );
          }
          await driver.execute(
            `INSERT OR REPLACE INTO backups (backup_id, created_at, info_json, bytes_b64) VALUES (?, ?, ?, ?)`,
            [id, info.created_at, JSON.stringify(info), ''],
          );
        } catch (err) {
          await driver
            .execute(`DELETE FROM backup_chunks WHERE backup_id = ?`, [id])
            .catch(() => undefined);
          throw err;
        }
      },
      getBytes: async (backupId) => {
        const rows = await driver.query<{ bytes_b64: string }>(
          `SELECT bytes_b64 FROM backups WHERE backup_id = ?`,
          [backupId],
        );
        const row = rows[0];
        if (!row) return undefined;
        if (row.bytes_b64) return base64ToBytes(row.bytes_b64);
        const parts: Uint8Array[] = [];
        for (let idx = 0; ; idx++) {
          const chunk = await driver.query<{ b64: string }>(
            `SELECT b64 FROM backup_chunks WHERE backup_id = ? AND idx = ?`,
            [backupId, idx],
          );
          if (!chunk[0]) break;
          parts.push(base64ToBytes(chunk[0].b64));
        }
        const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
        let offset = 0;
        for (const part of parts) {
          out.set(part, offset);
          offset += part.byteLength;
        }
        return out;
      },
      delete: async (backupId) => {
        await driver.execute(`DELETE FROM backup_chunks WHERE backup_id = ?`, [backupId]);
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

  /** Clears the collection. Backups stay, and so does the media a kept backup lists. */
  async clearAll(): Promise<void> {
    await this.ensureReady();
    // A snapshot write still queued would otherwise land after the clear.
    await this.snapshotWrites;
    await this.driver.execute(`DELETE FROM events`);
    await this.driver.execute(`DELETE FROM cards_cache`);
    const backupRows = await this.driver.query<{ info_json: string }>(
      `SELECT info_json FROM backups`,
    );
    const keep = mediaKeptByBackups(backupRows.map((r) => r.info_json));
    if (keep.size === 0) {
      await this.driver.execute(`DELETE FROM media`);
    } else {
      const rows = await this.driver.query<{ hash: string }>(`SELECT hash FROM media`);
      for (const { hash } of rows) {
        if (!keep.has(hash.toLowerCase())) {
          await this.driver.execute(`DELETE FROM media WHERE hash = ?`, [hash]);
        }
      }
    }
    await this.driver.execute(`DELETE FROM local_snapshot_chunks`);
    await this.driver.execute(`DELETE FROM kv`);
  }
}
