import type {
  DictionaryEntry,
  DictionaryPackId,
  PackCatalog,
  PackId,
} from '@flash/core/dictionary';
import type { HanziStrokeData, StrokeLookupIndex, StrokeScript } from '@flash/core/drawing';
import type { InstalledPackInfo } from '@flash/platform';
import Dexie, { type Table } from 'dexie';

export interface StoredStrokeRow {
  script: StrokeScript;
  char: string;
  packId?: PackId;
  data: HanziStrokeData;
  updatedAt: number;
}

interface StoredStrokeIndexRow {
  id: StrokeScript;
  index: StrokeLookupIndex;
  updatedAt: number;
}

interface StoredPackMetaKvRow {
  key: string;
  value: unknown;
}

export interface CachedPackCatalogRecord {
  url: string;
  catalog: PackCatalog;
  etag?: string;
  fetchedAt: number;
}

const CUSTOM_CATALOG_URL_KEY = 'custom_pack_catalog_url';
const CACHED_CATALOG_KEY = 'cached_pack_catalog';

class FlashcardsPacksDexieDb extends Dexie {
  packs!: Table<InstalledPackInfo, PackId>;
  dict_entries!: Table<DictionaryEntry, string>;
  strokes!: Table<StoredStrokeRow, [StrokeScript, string]>;
  stroke_index!: Table<StoredStrokeIndexRow, StrokeScript>;
  kv!: Table<StoredPackMetaKvRow, string>;

  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      packs: 'id, kind, language',
      dict_entries: 'id, packId, headword, *altForms, *searchTokens',
      strokes: '[script+char], script, packId',
      stroke_index: 'id',
      kv: 'key',
    });
  }
}

/**
 * Dedicated lazy-loaded IndexedDB database for offline dictionaries, cached stroke data,
 * and quantized handwriting lookup indexes (§6.3, §6.4, §8).
 * Isolated from user sync events so initial study-screen JS pays 0 KB and collection resets
 * preserve installed reference packs.
 */
export class DexiePackStorage {
  private readonly db: FlashcardsPacksDexieDb;
  readonly dbName: string;

  constructor(deviceSlug?: string) {
    this.dbName = deviceSlug ? `flashcards-packs-db-${deviceSlug}` : 'flashcards-packs-db';
    this.db = new FlashcardsPacksDexieDb(this.dbName);
  }

  async listInstalledPacks(): Promise<InstalledPackInfo[]> {
    return this.db.packs.toArray();
  }

  async getInstalledPack(packId: PackId): Promise<InstalledPackInfo | undefined> {
    return this.db.packs.get(packId);
  }

  async putInstalledPack(info: InstalledPackInfo): Promise<void> {
    await this.db.packs.put(info);
  }

  async replaceDictionaryPackEntries(
    packId: DictionaryPackId,
    entries: readonly DictionaryEntry[],
    onChunk?: (done: number, total: number) => void,
  ): Promise<void> {
    await this.db.dict_entries.where('packId').equals(packId).delete();
    const CHUNK = 2000;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      await this.db.dict_entries.bulkPut(slice);
      onChunk?.(Math.min(i + slice.length, entries.length), entries.length);
    }
  }

  async replaceStrokePack(
    packId: PackId,
    script: StrokeScript,
    characters: Readonly<Record<string, HanziStrokeData>>,
    lookupIndex: StrokeLookupIndex,
    onChunk?: (done: number, total: number) => void,
  ): Promise<void> {
    const entries = Object.entries(characters);
    const now = Date.now();
    await this.db.strokes.where('packId').equals(packId).delete();
    const CHUNK = 1000;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK).map(([char, data]) => ({
        script,
        char,
        packId,
        data,
        updatedAt: now,
      }));
      await this.db.strokes.bulkPut(slice);
      onChunk?.(Math.min(i + slice.length, entries.length), entries.length);
    }
    await this.db.stroke_index.put({ id: script, index: lookupIndex, updatedAt: now });
  }

  async removePack(packId: PackId): Promise<void> {
    const existing = await this.db.packs.get(packId);
    await this.db.transaction(
      'rw',
      [this.db.packs, this.db.dict_entries, this.db.strokes, this.db.stroke_index],
      async () => {
        await this.db.packs.delete(packId);
        await this.db.dict_entries.where('packId').equals(packId).delete();
        await this.db.strokes.where('packId').equals(packId).delete();
        if (existing?.kind === 'strokes' && existing.script) {
          await this.db.stroke_index.delete(existing.script);
        }
      },
    );
  }

  async getStroke(script: StrokeScript, char: string): Promise<HanziStrokeData | undefined> {
    const row = await this.db.strokes.get([script, char]);
    return row?.data;
  }

  async hasStroke(script: StrokeScript, char: string): Promise<boolean> {
    const key = await this.db.strokes.where('[script+char]').equals([script, char]).primaryKeys();
    return key.length > 0;
  }

  async putSingleStroke(script: StrokeScript, char: string, data: HanziStrokeData): Promise<void> {
    await this.db.strokes.put({
      script,
      char,
      data,
      updatedAt: Date.now(),
    });
  }

  async listStrokesByScript(script: StrokeScript): Promise<StoredStrokeRow[]> {
    return this.db.strokes.where('script').equals(script).toArray();
  }

  async getStrokeIndex(script: StrokeScript): Promise<StrokeLookupIndex | undefined> {
    const row = await this.db.stroke_index.get(script);
    return row?.index;
  }

  async getAllStrokeIndexes(): Promise<StrokeLookupIndex[]> {
    const rows = await this.db.stroke_index.toArray();
    return rows.map((r) => r.index);
  }

  async lookupDictionaryByHeadword(
    charOrWord: string,
    packIds?: readonly DictionaryPackId[],
  ): Promise<DictionaryEntry[]> {
    const norm = charOrWord.normalize('NFC').trim();
    if (!norm) return [];
    const [byHw, byAlt] = await Promise.all([
      this.db.dict_entries.where('headword').equals(norm).toArray(),
      this.db.dict_entries.where('altForms').equals(norm).toArray(),
    ]);
    const allowed = packIds && packIds.length > 0 ? new Set(packIds) : null;
    const seen = new Set<string>();
    const out: DictionaryEntry[] = [];
    for (const row of [...byHw, ...byAlt]) {
      if (allowed && !allowed.has(row.packId)) continue;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
    return out;
  }

  async queryDictionaryCandidates(
    prefixTokens: readonly string[],
    packIds?: readonly DictionaryPackId[],
    maxCandidates = 400,
  ): Promise<DictionaryEntry[]> {
    const allowed = packIds && packIds.length > 0 ? new Set(packIds) : null;
    const seen = new Set<string>();
    const out: DictionaryEntry[] = [];

    for (const tok of prefixTokens) {
      if (!tok) continue;
      const matches = await this.db.dict_entries
        .where('searchTokens')
        .startsWith(tok)
        .limit(maxCandidates)
        .toArray();
      for (const row of matches) {
        if (allowed && !allowed.has(row.packId)) continue;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
        if (out.length >= maxCandidates) return out;
      }
    }

    return out;
  }

  async listInstalledHanjaCharacters(): Promise<Set<string>> {
    const rows = await this.db.dict_entries.where('packId').equals('dict-hanja-unihan').toArray();
    const chars = new Set<string>();
    for (const row of rows) {
      if ([...row.headword].length === 1) {
        chars.add(row.headword);
      }
    }
    return chars;
  }

  async getCustomCatalogUrl(): Promise<string | undefined> {
    const row = await this.db.kv.get(CUSTOM_CATALOG_URL_KEY);
    return typeof row?.value === 'string' && row.value.trim() ? row.value.trim() : undefined;
  }

  async setCustomCatalogUrl(url: string | undefined): Promise<void> {
    if (!url || !url.trim()) {
      await this.db.kv.delete(CUSTOM_CATALOG_URL_KEY);
    } else {
      await this.db.kv.put({ key: CUSTOM_CATALOG_URL_KEY, value: url.trim() });
    }
  }

  async getCachedCatalog(): Promise<CachedPackCatalogRecord | undefined> {
    const row = await this.db.kv.get(CACHED_CATALOG_KEY);
    return row?.value as CachedPackCatalogRecord | undefined;
  }

  async setCachedCatalog(record: CachedPackCatalogRecord): Promise<void> {
    await this.db.kv.put({ key: CACHED_CATALOG_KEY, value: record });
  }

  async getStorageUsageBytes(): Promise<number> {
    const packs = await this.db.packs.toArray();
    let total = 0;
    for (const p of packs) {
      total += p.byteSize;
    }
    return total;
  }

  async clearAll(): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.packs, this.db.dict_entries, this.db.strokes, this.db.stroke_index, this.db.kv],
      async () => {
        await this.db.packs.clear();
        await this.db.dict_entries.clear();
        await this.db.strokes.clear();
        await this.db.stroke_index.clear();
        await this.db.kv.clear();
      },
    );
  }

  close(): void {
    this.db.close();
  }
}
