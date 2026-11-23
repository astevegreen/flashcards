import {
  decodeDictionaryShard,
  findShardForHeadword,
  materializeDictionaryEntries,
  PACK_SECURITY_LIMITS,
  type DictionaryEntry,
  type DictionaryPackId,
} from '@flash/core/dictionary';
import type { InstalledPackInfo, PackInstallProgress } from '@flash/platform';
import type { DexiePackStorage, StoredShardState } from './dexie-pack-storage.ts';
import { readResponseWithCap, safePackFetch, siblingPackUrl } from './pack-fetch.ts';

export interface DictionaryShardLoaderOptions {
  packStorage: DexiePackStorage;
  allowRelativeUrls?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Downloads the shards of sharded dictionary packs on demand (see core `shards.ts`). A shard is
 * fetched from the directory of the pack's index URL, checked against the SHA-256 in the
 * installed index, and its full rows replace their stub rows in IndexedDB. Concurrent requests
 * for the same shard share one download.
 */
export class DictionaryShardLoader {
  private readonly packStorage: DexiePackStorage;
  private readonly allowRelativeUrls: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly inflight = new Map<string, Promise<InstalledPackInfo | undefined>>();

  constructor(options: DictionaryShardLoaderOptions) {
    this.packStorage = options.packStorage;
    this.allowRelativeUrls = options.allowRelativeUrls ?? false;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  /** Loads shard `key` unless it is on the device; resolves to the updated pack info. */
  loadShard(
    state: StoredShardState,
    key: string,
    onProgress?: (loaded: number, total?: number) => void,
  ): Promise<InstalledPackInfo | undefined> {
    const id = `${state.packId}\u0001${state.installedAt}\u0001${key}`;
    const running = this.inflight.get(id);
    if (running) return running;
    const task = this.fetchAndStore(state, key, onProgress).finally(() => {
      this.inflight.delete(id);
    });
    this.inflight.set(id, task);
    return task;
  }

  private async fetchAndStore(
    state: StoredShardState,
    key: string,
    onProgress?: (loaded: number, total?: number) => void,
  ): Promise<InstalledPackInfo | undefined> {
    const shard = state.sharding.shards.find((s) => s.key === key);
    if (!shard) throw new Error(`${state.packId} has no shard "${key}".`);
    const url = siblingPackUrl(state.indexUrl, shard.file);
    const res = await safePackFetch(
      this.fetchImpl,
      url,
      this.allowRelativeUrls || url.startsWith('/'),
    );
    if (!res.ok) {
      throw new Error(`Failed to download ${state.packId} shard "${key}" (HTTP ${res.status}).`);
    }
    const bytes = await readResponseWithCap(
      res,
      PACK_SECURITY_LIMITS.maxCompressedBytes,
      onProgress,
    );
    const decoded = decodeDictionaryShard(bytes, {
      packId: state.packId,
      version: state.version,
      sharding: state.sharding,
      shard,
    });
    const rows = materializeDictionaryEntries(state.packId, decoded.entries, {
      indices: decoded.indices,
    });
    return this.packStorage.putDictionaryShard(
      state.packId,
      state.installedAt,
      key,
      rows,
      bytes.byteLength,
    );
  }

  /**
   * Returns `entries` with each stub row replaced by its full row, loading the shards needed
   * first: at most `maxShards` not yet on the device, chosen in entry order (so the best-ranked
   * results win). Rows whose shard fails to load (offline, bad file) stay stubs.
   */
  async loadFullEntries(
    entries: readonly DictionaryEntry[],
    opts: { maxShards?: number } = {},
  ): Promise<DictionaryEntry[]> {
    const stubs = entries.filter((e) => e.stub);
    if (stubs.length === 0) return [...entries];
    const wanted = await this.pickShardsToLoad(stubs, opts.maxShards ?? Number.POSITIVE_INFINITY);
    if (wanted.length === 0) return [...entries];
    await Promise.allSettled(wanted.map(([state, key]) => this.loadShard(state, key)));
    const fresh = await this.packStorage.getDictionaryEntriesByIds(stubs.map((e) => e.id));
    const full = new Map<string, DictionaryEntry>();
    for (const row of fresh) if (row && !row.stub) full.set(row.id, row);
    return entries.map((e) => full.get(e.id) ?? e);
  }

  /** The first `maxShards` distinct shards the `stubs` need that are not on the device yet. */
  private async pickShardsToLoad(
    stubs: readonly DictionaryEntry[],
    maxShards: number,
  ): Promise<Array<[StoredShardState, string]>> {
    const packIds = [...new Set(stubs.map((e) => e.packId))];
    const states = new Map<DictionaryPackId, StoredShardState | undefined>(
      await Promise.all(
        packIds.map(
          async (id) =>
            [id, await this.packStorage.getShardState(id)] as [
              DictionaryPackId,
              StoredShardState | undefined,
            ],
        ),
      ),
    );
    const wanted: Array<[StoredShardState, string]> = [];
    const seen = new Set<string>();
    for (const entry of stubs) {
      const state = states.get(entry.packId);
      const shard = state ? findShardForHeadword(state.sharding, entry.headword) : undefined;
      if (!state || !shard || state.loaded.includes(shard.key)) continue;
      const id = `${entry.packId}\u0001${shard.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (wanted.length >= maxShards) break;
      wanted.push([state, shard.key]);
    }
    return wanted;
  }

  /** Downloads every shard of `packId` not on the device yet, one at a time. */
  async loadAllShards(
    packId: DictionaryPackId,
    onProgress?: (progress: PackInstallProgress) => void,
  ): Promise<InstalledPackInfo | undefined> {
    const state = await this.packStorage.getShardState(packId);
    if (!state) return this.packStorage.getInstalledPack(packId);
    const missing = state.sharding.shards.filter((s) => !state.loaded.includes(s.key));
    const totalBytes = missing.reduce((sum, s) => sum + s.compressed_bytes, 0);
    let doneBytes = 0;
    let info: InstalledPackInfo | undefined;
    for (const shard of missing) {
      onProgress?.({ phase: 'downloading', loadedBytes: doneBytes, totalBytes });
      // Shards download one at a time on purpose: it caps concurrent requests and memory.
      const onShardProgress = (loaded: number) => {
        onProgress?.({ phase: 'downloading', loadedBytes: doneBytes + loaded, totalBytes });
      };
      info = await this.loadShard(state, shard.key, onShardProgress); // NOSONAR (S9382)
      doneBytes += shard.compressed_bytes;
      if (!info) throw new Error(`${packId} changed while its shards were downloading.`);
    }
    const final = info ?? (await this.packStorage.getInstalledPack(packId));
    onProgress?.({
      phase: 'done',
      indexedEntries: final?.entryCount ?? 0,
      totalEntries: final?.entryCount ?? 0,
    });
    return final;
  }
}
