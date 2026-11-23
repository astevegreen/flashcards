import {
  browseCursorFor,
  browseKeyRange,
  browsePageSize,
  buildEntryBrowseKeys,
  DictionaryBrowseSummaryBuilder,
  matchesBrowseFilters,
  type DictionaryBrowsePage,
  type DictionaryBrowseQuery,
  type DictionaryBrowseSummary,
  type DictionaryEntry,
  type DictionaryPackId,
  type DictionaryShardingInfo,
  type PackCatalog,
  type PackId,
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
const BROWSE_SUMMARY_KEY_PREFIX = 'browse_summary:';
const SHARD_STATE_KEY_PREFIX = 'dict_shards:';

/** A sharded dictionary pack's shard list and which shards are on this device. */
export interface StoredShardState {
  packId: DictionaryPackId;
  version: string;
  /** `installedAt` of the index install this state belongs to. */
  installedAt: number;
  /** URL the index was downloaded from; shards are fetched from the same directory. */
  indexUrl: string;
  sharding: DictionaryShardingInfo;
  loaded: string[];
}

interface StoredBrowseSummary {
  /** `installedAt` of the pack the summary was computed for. */
  installedAt: number;
  summary: DictionaryBrowseSummary;
}

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
    // Browse without typing: a multiEntry index of `packId␁group␁headword␁id` keys (core browse.ts).
    // Rows installed before v2 get their keys here, so no pack needs reinstalling.
    this.version(2)
      .stores({ dict_entries: 'id, packId, headword, *altForms, *searchTokens, *browseKeys' })
      .upgrade((tx) =>
        tx
          .table<DictionaryEntry, string>('dict_entries')
          .toCollection()
          .modify((entry) => {
            entry.browseKeys = buildEntryBrowseKeys(entry);
          }),
      );
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
    await this.db.kv.delete(BROWSE_SUMMARY_KEY_PREFIX + packId);
    await this.db.kv.delete(SHARD_STATE_KEY_PREFIX + packId);
    const CHUNK = 2000;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      await this.db.dict_entries.bulkPut(slice);
      onChunk?.(Math.min(i + slice.length, entries.length), entries.length);
    }
  }

  async getShardState(packId: DictionaryPackId): Promise<StoredShardState | undefined> {
    const row = await this.db.kv.get(SHARD_STATE_KEY_PREFIX + packId);
    return row?.value as StoredShardState | undefined;
  }

  async setShardState(state: StoredShardState): Promise<void> {
    await this.db.kv.put({ key: SHARD_STATE_KEY_PREFIX + state.packId, value: state });
  }

  /**
   * Writes one shard's full rows over their stubs and marks the shard loaded. Does nothing and
   * returns `undefined` when the pack was reinstalled or removed while the shard downloaded.
   */
  async putDictionaryShard(
    packId: DictionaryPackId,
    installedAt: number,
    key: string,
    rows: readonly DictionaryEntry[],
    downloadedBytes: number,
  ): Promise<InstalledPackInfo | undefined> {
    return this.db.transaction(
      'rw',
      [this.db.packs, this.db.dict_entries, this.db.kv],
      async () => {
        const state = await this.getShardState(packId);
        const info = await this.db.packs.get(packId);
        if (
          !state ||
          !info ||
          state.installedAt !== installedAt ||
          info.installedAt !== installedAt
        ) {
          return undefined;
        }
        if (state.loaded.includes(key)) return info;
        // Every full row must land on its stub's id, or search would list the word twice.
        const existing = await this.db.dict_entries.bulkGet(rows.map((r) => r.id));
        if (existing.some((row) => row?.packId !== packId)) {
          throw new Error(`Shard "${key}" of ${packId} does not match the installed index.`);
        }
        await this.db.dict_entries.bulkPut(rows);
        const loaded = [...state.loaded, key];
        await this.setShardState({ ...state, loaded });
        const next: InstalledPackInfo = {
          ...info,
          byteSize: info.byteSize + downloadedBytes,
          shardsLoaded: loaded.length,
        };
        await this.db.packs.put(next);
        return next;
      },
    );
  }

  /** Rows by id, in the order given (`undefined` for ids no longer stored). */
  async getDictionaryEntriesByIds(
    ids: readonly string[],
  ): Promise<Array<DictionaryEntry | undefined>> {
    return this.db.dict_entries.bulkGet([...ids]);
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
      [this.db.packs, this.db.dict_entries, this.db.strokes, this.db.stroke_index, this.db.kv],
      async () => {
        await this.db.packs.delete(packId);
        await this.db.dict_entries.where('packId').equals(packId).delete();
        await this.db.kv.delete(BROWSE_SUMMARY_KEY_PREFIX + packId);
        await this.db.kv.delete(SHARD_STATE_KEY_PREFIX + packId);
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

  /** Bulk exact-headword lookup (deinflected / romanized Korean candidates validated in one query). */
  async lookupDictionaryByHeadwords(
    headwords: readonly string[],
    packIds?: readonly DictionaryPackId[],
  ): Promise<DictionaryEntry[]> {
    const keys = [...new Set(headwords.map((h) => h.normalize('NFC').trim()).filter(Boolean))];
    if (keys.length === 0) return [];
    const rows = await this.db.dict_entries.where('headword').anyOf(keys).toArray();
    const allowed = packIds && packIds.length > 0 ? new Set(packIds) : null;
    return allowed ? rows.filter((r) => allowed.has(r.packId)) : rows;
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

  /** One page of a browse group, in headword order; POS filtering happens while paging. */
  async browseDictionary(query: DictionaryBrowseQuery): Promise<DictionaryBrowsePage> {
    const range = browseKeyRange(query);
    if (!range) return { entries: [] };
    const size = browsePageSize(query);
    // One row past the page tells whether a next page exists.
    const rows = await this.db.dict_entries
      .where('browseKeys')
      .between(range.lower, range.upper, !range.lowerOpen, false)
      .filter((entry) => matchesBrowseFilters(query, entry))
      .limit(size + 1)
      .toArray();
    const entries = rows.slice(0, size);
    const last = entries.at(-1);
    return rows.length > size && last
      ? { entries, next: browseCursorFor(query, last) }
      : { entries };
  }

  /** The pack's browse groups with counts, computed once per install and cached. */
  async getBrowseSummary(packId: DictionaryPackId): Promise<DictionaryBrowseSummary> {
    const key = BROWSE_SUMMARY_KEY_PREFIX + packId;
    const installedAt = (await this.db.packs.get(packId))?.installedAt ?? 0;
    const cached = (await this.db.kv.get(key))?.value as StoredBrowseSummary | undefined;
    if (cached && cached.installedAt === installedAt) return cached.summary;
    const builder = new DictionaryBrowseSummaryBuilder(packId);
    await this.db.dict_entries
      .where('packId')
      .equals(packId)
      .each((entry) => builder.add(entry));
    const summary = builder.build();
    const record: StoredBrowseSummary = { installedAt, summary };
    await this.db.kv.put({ key, value: record });
    return summary;
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
