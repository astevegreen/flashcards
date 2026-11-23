import { createHlcState, uuidv7, type FlashEvent, type SyncCursorState } from '@flash/core';
import type {
  DeviceMeta,
  LocalSnapshotRecord,
  MaterializedCardRow,
  BackupStore,
  MediaBlob,
  Storage,
  SyncConfig,
} from '@flash/platform';
import Dexie, { type Table } from 'dexie';

interface StoredEventRow {
  id: string;
  device: string;
  seq: number;
  hlc: string;
  type: string;
  v: number;
  card_id?: string;
  local_seq?: number;
  payload: unknown;
  /** Any extra unknown top-level envelope fields preserved verbatim for forward compatibility (§4.2). */
  extra_fields?: Record<string, unknown>;
}

interface StoredMetaRow {
  key: string;
  value: DeviceMeta;
}

interface StoredMediaRow {
  hash: string;
  mime: string;
  bytes: Uint8Array;
}

interface StoredSnapshotRow {
  key: string;
  value: LocalSnapshotRecord;
}

interface StoredKvRow {
  key: string;
  value: unknown;
}

const KNOWN_ENVELOPE_KEYS = new Set(['id', 'device', 'seq', 'hlc', 'type', 'v', 'payload']);
const LOCAL_SEQ_COUNTER_KEY = '__local_seq_counter';
const SYNC_CURSOR_KEY = 'sync_cursor';
const SYNC_CONFIG_KEY = 'sync_config';
const LATEST_SNAPSHOT_KEY = 'latest';

export class FlashcardsDexieDb extends Dexie {
  events!: Table<StoredEventRow, string>;
  cards_cache!: Table<MaterializedCardRow, string>;
  meta!: Table<StoredMetaRow, string>;
  media!: Table<StoredMediaRow, string>;
  snapshots!: Table<StoredSnapshotRow, string>;
  kv!: Table<StoredKvRow, string>;

  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      events: 'id, [device+seq], hlc, type, card_id',
      cards_cache: 'id, deck_id, due',
      meta: 'key',
      media: 'hash',
    });
    this.version(2)
      .stores({
        events: 'id, [device+seq], hlc, type, card_id, local_seq',
        cards_cache: 'id, deck_id, due',
        meta: 'key',
        media: 'hash',
        snapshots: 'key',
        kv: 'key',
      })
      .upgrade(async (tx) => {
        const eventsTable = tx.table<StoredEventRow, string>('events');
        const kvTable = tx.table<StoredKvRow, string>('kv');
        const all = await eventsTable.orderBy('hlc').toArray();
        let counter = 0;
        const updated: StoredEventRow[] = [];
        for (const row of all) {
          if (typeof row.local_seq === 'number' && row.local_seq > counter) {
            counter = row.local_seq;
          }
        }
        for (const row of all) {
          if (typeof row.local_seq !== 'number') {
            counter += 1;
            updated.push({ ...row, local_seq: counter });
          }
        }
        if (updated.length > 0) {
          await eventsTable.bulkPut(updated);
        }
        await kvTable.put({ key: LOCAL_SEQ_COUNTER_KEY, value: counter });
      });
    // Rolling backups (lazy: ./dexie-backup-store.ts).
    this.version(3).stores({ backups: 'backup_id, created_at', backup_blobs: 'id' });
  }
}

function extractCardId(event: FlashEvent): string | undefined {
  if (
    event.payload &&
    typeof event.payload === 'object' &&
    'card_id' in event.payload &&
    typeof (event.payload as { card_id?: unknown }).card_id === 'string'
  ) {
    return (event.payload as { card_id: string }).card_id;
  }
  return undefined;
}

function extractExtraFields(event: FlashEvent): Record<string, unknown> | undefined {
  let extras: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(event as unknown as Record<string, unknown>)) {
    if (!KNOWN_ENVELOPE_KEYS.has(k)) {
      if (!extras) extras = {};
      extras[k] = v;
    }
  }
  return extras;
}

function rowToFlashEvent(r: StoredEventRow): FlashEvent {
  const base: Record<string, unknown> = {
    ...(r.extra_fields ?? {}),
    id: r.id,
    device: r.device,
    seq: r.seq,
    hlc: r.hlc,
    type: r.type,
    v: r.v,
    payload: r.payload,
  };
  return base as unknown as FlashEvent;
}

export class DexieStorage implements Storage {
  private readonly db: FlashcardsDexieDb;
  readonly dbName: string;

  constructor(deviceSlug?: string) {
    this.dbName = deviceSlug ? `flashcards-db-${deviceSlug}` : 'flashcards-db';
    this.db = new FlashcardsDexieDb(this.dbName);
  }

  async appendEvents(events: readonly FlashEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Deduplicate within the incoming batch first
    const unique: FlashEvent[] = [];
    const seen = new Set<string>();
    for (const ev of events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      unique.push(ev);
    }

    await this.db.transaction('rw', this.db.events, this.db.kv, async () => {
      const [existing, counterRow] = await Promise.all([
        this.db.events.bulkGet(unique.map((ev) => ev.id)),
        this.db.kv.get(LOCAL_SEQ_COUNTER_KEY),
      ]);
      const toInsert: FlashEvent[] = [];
      for (let i = 0; i < unique.length; i++) {
        const ev = unique[i];
        if (ev && existing[i] === undefined) {
          toInsert.push(ev);
        }
      }
      if (toInsert.length === 0) return;

      let counter = typeof counterRow?.value === 'number' ? counterRow.value : 0;
      if (counter === 0) {
        const lastByLocalSeq = await this.db.events.orderBy('local_seq').last();
        if (typeof lastByLocalSeq?.local_seq === 'number') {
          counter = lastByLocalSeq.local_seq;
        }
      }

      const rows: StoredEventRow[] = toInsert.map((ev) => {
        counter += 1;
        const cardId = extractCardId(ev);
        const extras = extractExtraFields(ev);
        return {
          id: ev.id,
          device: ev.device,
          seq: ev.seq,
          hlc: ev.hlc,
          type: ev.type,
          v: ev.v,
          payload: ev.payload,
          local_seq: counter,
          ...(cardId !== undefined ? { card_id: cardId } : {}),
          ...(extras !== undefined ? { extra_fields: extras } : {}),
        };
      });

      await Promise.all([
        this.db.events.bulkPut(rows),
        this.db.kv.put({ key: LOCAL_SEQ_COUNTER_KEY, value: counter }),
      ]);
    });
  }

  async getEvents(sinceHlc?: string): Promise<FlashEvent[]> {
    const rows = sinceHlc
      ? await this.db.events.where('hlc').above(sinceHlc).sortBy('hlc')
      : await this.db.events.orderBy('hlc').toArray();
    return rows.map(rowToFlashEvent);
  }

  async getEventsForCard(cardId: string): Promise<FlashEvent[]> {
    const rows = await this.db.events.where('card_id').equals(cardId).sortBy('hlc');
    return rows.map(rowToFlashEvent);
  }

  async getAllEvents(): Promise<FlashEvent[]> {
    return this.getEvents();
  }

  async getDeviceEventsAfterSeq(deviceId: string, afterSeq: number): Promise<FlashEvent[]> {
    const rows = await this.db.events
      .where('[device+seq]')
      .between([deviceId, afterSeq], [deviceId, Number.MAX_SAFE_INTEGER], false, true)
      .toArray();
    rows.sort((a, b) => a.seq - b.seq);
    return rows.map(rowToFlashEvent);
  }

  async getEventsAfterLocalSeq(
    afterLocalSeq: number,
  ): Promise<{ events: FlashEvent[]; maxLocalSeq: number }> {
    const rows = await this.db.events.where('local_seq').above(afterLocalSeq).sortBy('local_seq');
    let maxLocalSeq = afterLocalSeq;
    for (const r of rows) {
      if (typeof r.local_seq === 'number' && r.local_seq > maxLocalSeq) {
        maxLocalSeq = r.local_seq;
      }
    }
    return {
      events: rows.map(rowToFlashEvent),
      maxLocalSeq,
    };
  }

  async getMaxLocalSeq(): Promise<number> {
    const counterRow = await this.db.kv.get(LOCAL_SEQ_COUNTER_KEY);
    if (typeof counterRow?.value === 'number') {
      return counterRow.value;
    }
    const last = await this.db.events.orderBy('local_seq').last();
    return typeof last?.local_seq === 'number' ? last.local_seq : 0;
  }

  async getDeviceMeta(): Promise<DeviceMeta | undefined> {
    const row = await this.db.meta.get('device');
    return row?.value;
  }

  async setDeviceMeta(meta: DeviceMeta): Promise<void> {
    await this.db.meta.put({ key: 'device', value: meta });
  }

  async ensureDeviceMeta(defaultDeviceId?: string): Promise<DeviceMeta> {
    const existing = await this.getDeviceMeta();
    if (existing) return existing;
    const deviceId = defaultDeviceId ?? `web-${uuidv7().slice(0, 12)}`;
    const meta: DeviceMeta = {
      deviceId,
      seq: 0,
      hlc: createHlcState(deviceId, 0),
    };
    await this.setDeviceMeta(meta);
    return meta;
  }

  async saveMaterializedCards(cards: readonly MaterializedCardRow[]): Promise<void> {
    await this.db.transaction('rw', this.db.cards_cache, async () => {
      await this.db.cards_cache.clear();
      if (cards.length > 0) {
        await this.db.cards_cache.bulkPut([...cards]);
      }
    });
  }

  async upsertMaterializedCards(cards: readonly MaterializedCardRow[]): Promise<void> {
    if (cards.length === 0) return;
    await this.db.cards_cache.bulkPut([...cards]);
  }

  async deleteMaterializedCards(cardIds: readonly string[]): Promise<void> {
    if (cardIds.length === 0) return;
    await this.db.cards_cache.bulkDelete([...cardIds]);
  }

  async loadMaterializedCards(): Promise<MaterializedCardRow[]> {
    return this.db.cards_cache.toArray();
  }

  async getSyncCursor(): Promise<SyncCursorState | undefined> {
    return this.getKv<SyncCursorState>(SYNC_CURSOR_KEY);
  }

  async setSyncCursor(cursor: SyncCursorState): Promise<void> {
    await this.setKv(SYNC_CURSOR_KEY, cursor);
  }

  async getSyncConfig(): Promise<SyncConfig | undefined> {
    return this.getKv<SyncConfig>(SYNC_CONFIG_KEY);
  }

  async setSyncConfig(config: SyncConfig): Promise<void> {
    await this.setKv(SYNC_CONFIG_KEY, config);
  }

  async getLocalSnapshot(): Promise<LocalSnapshotRecord | undefined> {
    const row = await this.db.snapshots.get(LATEST_SNAPSHOT_KEY);
    return row?.value;
  }

  async setLocalSnapshot(record: LocalSnapshotRecord): Promise<void> {
    await this.db.snapshots.put({ key: LATEST_SNAPSHOT_KEY, value: record });
  }

  async getKv<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.db.kv.get(key);
    return row?.value as T | undefined;
  }

  async setKv(key: string, value: unknown): Promise<void> {
    await this.db.kv.put({ key, value });
  }

  async deleteKv(key: string): Promise<void> {
    await this.db.kv.delete(key);
  }

  async putMedia(media: MediaBlob): Promise<void> {
    await this.db.media.put({
      hash: media.hash,
      mime: media.mime,
      bytes: media.bytes,
    });
  }

  async getMedia(hash: string): Promise<MediaBlob | undefined> {
    const row = await this.db.media.get(hash);
    if (!row) return undefined;
    return { hash: row.hash, mime: row.mime, bytes: row.bytes };
  }

  async listMediaHashes(): Promise<string[]> {
    return this.db.media.toCollection().primaryKeys();
  }

  async deleteMedia(hash: string): Promise<void> {
    await this.db.media.delete(hash);
  }

  openBackupStore(): Promise<BackupStore> {
    return import('./dexie-backup-store.ts').then((m) => m.createDexieBackupStore(this.db));
  }

  async requestPersistence(): Promise<boolean> {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
        return await navigator.storage.persist();
      }
    } catch {
      // Ignore storage persistence rejections in restricted contexts
    }
    return false;
  }

  /** Clears the collection. Backups stay, and so does the media a kept backup lists. */
  async clearAll(): Promise<void> {
    const backups = this.db.table<{ media_hashes?: unknown }, string>('backups');
    await this.db.transaction(
      'rw',
      [
        this.db.events,
        this.db.cards_cache,
        this.db.meta,
        this.db.media,
        this.db.snapshots,
        this.db.kv,
        backups,
      ],
      async () => {
        const keep = new Set<string>();
        for (const info of await backups.toArray()) {
          if (!Array.isArray(info.media_hashes)) continue;
          for (const h of info.media_hashes) if (typeof h === 'string') keep.add(h.toLowerCase());
        }
        await this.db.events.clear();
        await this.db.cards_cache.clear();
        await this.db.meta.clear();
        if (keep.size === 0) await this.db.media.clear();
        else await this.db.media.filter((m) => !keep.has(m.hash.toLowerCase())).delete();
        await this.db.snapshots.clear();
        await this.db.kv.clear();
      },
    );
  }

  close(): void {
    this.db.close();
  }
}
