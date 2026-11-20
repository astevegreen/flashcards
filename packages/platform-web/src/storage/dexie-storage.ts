import { createHlcState, uuidv7, type FlashEvent } from '@flash/core';
import type { DeviceMeta, MaterializedCardRow, MediaBlob, Storage } from '@flash/platform';
import Dexie, { type Table } from 'dexie';

interface StoredEventRow {
  id: string;
  device: string;
  seq: number;
  hlc: string;
  type: string;
  v: number;
  card_id?: string;
  payload: unknown;
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

class FlashcardsDexieDb extends Dexie {
  events!: Table<StoredEventRow, string>;
  cards_cache!: Table<MaterializedCardRow, string>;
  meta!: Table<StoredMetaRow, string>;
  media!: Table<StoredMediaRow, string>;

  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      events: 'id, [device+seq], hlc, type, card_id',
      cards_cache: 'id, deck_id, due',
      meta: 'key',
      media: 'hash',
    });
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

export class DexieStorage implements Storage {
  private readonly db: FlashcardsDexieDb;
  readonly dbName: string;

  constructor(deviceSlug?: string) {
    this.dbName = deviceSlug ? `flashcards-db-${deviceSlug}` : 'flashcards-db';
    this.db = new FlashcardsDexieDb(this.dbName);
  }

  async appendEvents(events: readonly FlashEvent[]): Promise<void> {
    if (events.length === 0) return;
    const rows: StoredEventRow[] = events.map((ev) => {
      const cardId = extractCardId(ev);
      return {
        id: ev.id,
        device: ev.device,
        seq: ev.seq,
        hlc: ev.hlc,
        type: ev.type,
        v: ev.v,
        payload: ev.payload,
        ...(cardId !== undefined ? { card_id: cardId } : {}),
      };
    });
    await this.db.events.bulkPut(rows);
  }

  async getEvents(sinceHlc?: string): Promise<FlashEvent[]> {
    const rows = sinceHlc
      ? await this.db.events.where('hlc').above(sinceHlc).sortBy('hlc')
      : await this.db.events.orderBy('hlc').toArray();
    return rows.map((r) => ({
      id: r.id,
      device: r.device,
      seq: r.seq,
      hlc: r.hlc,
      type: r.type,
      v: r.v,
      payload: r.payload,
    }));
  }

  async getEventsForCard(cardId: string): Promise<FlashEvent[]> {
    const rows = await this.db.events.where('card_id').equals(cardId).sortBy('hlc');
    return rows.map((r) => ({
      id: r.id,
      device: r.device,
      seq: r.seq,
      hlc: r.hlc,
      type: r.type,
      v: r.v,
      payload: r.payload,
    }));
  }

  async getAllEvents(): Promise<FlashEvent[]> {
    return this.getEvents();
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
      hlc: createHlcState(deviceId, Date.now()),
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

  async loadMaterializedCards(): Promise<MaterializedCardRow[]> {
    return this.db.cards_cache.toArray();
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

  async clearAll(): Promise<void> {
    await this.db.transaction(
      'rw',
      this.db.events,
      this.db.cards_cache,
      this.db.meta,
      this.db.media,
      async () => {
        await this.db.events.clear();
        await this.db.cards_cache.clear();
        await this.db.meta.clear();
        await this.db.media.clear();
      },
    );
  }
}
