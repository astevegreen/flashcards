import {
  assertSafePackUrl,
  decodePackArchive,
  materializeDictionaryEntries,
  PACK_SECURITY_LIMITS,
  parseAndValidatePackCatalog,
  type DictionaryPackId,
  type PackCatalog,
  type PackCatalogEntry,
  type PackId,
} from '@flash/core/dictionary';
import { buildStrokeLookupIndex } from '@flash/core/drawing';
import type { InstalledPackInfo, PackInstallProgress, PackManager } from '@flash/platform';
import type { DexiePackStorage } from './dexie-pack-storage.ts';
import { DictionaryShardLoader } from './dictionary-shards.ts';
import { readResponseWithCap, safePackFetch } from './pack-fetch.ts';

export interface WebPackManagerOptions {
  packStorage: DexiePackStorage;
  defaultCatalogUrl?: string;
  allowRelativeUrls?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Manages downloadable offline dictionary & stroke packs from a single static `packs.json`
 * manifest (`VITE_PACK_CATALOG_URL`, §3.4 & §6.3), custom HTTPS URLs, or local files.
 * Enforces strict URL validation, streaming byte caps, SHA-256 verification, and
 * gzip-bomb protection (§13).
 */
export class WebPackManager implements PackManager {
  private readonly packStorage: DexiePackStorage;
  private readonly defaultCatalogUrl?: string;
  private readonly allowRelativeUrls: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly shardLoader: DictionaryShardLoader;
  private customCatalogUrl?: string;
  private loadedCustomUrl = false;

  constructor(options: WebPackManagerOptions) {
    this.packStorage = options.packStorage;
    if (options.defaultCatalogUrl?.trim()) {
      this.defaultCatalogUrl = options.defaultCatalogUrl.trim();
    }
    this.allowRelativeUrls = options.allowRelativeUrls ?? false;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.shardLoader = new DictionaryShardLoader({
      packStorage: this.packStorage,
      allowRelativeUrls: this.allowRelativeUrls,
      fetchImpl: this.fetchImpl,
    });
  }

  getCatalogUrl(): string | undefined {
    return this.customCatalogUrl ?? this.defaultCatalogUrl;
  }

  async setCustomCatalogUrl(url: string | undefined): Promise<void> {
    const trimmed = url?.trim();
    if (trimmed) {
      assertSafePackUrl(trimmed, this.allowRelativeUrls);
      this.customCatalogUrl = trimmed;
    } else {
      delete this.customCatalogUrl;
    }
    this.loadedCustomUrl = true;
    await this.packStorage.setCustomCatalogUrl(this.customCatalogUrl);
  }

  private async ensureCustomCatalogLoaded(): Promise<void> {
    if (this.loadedCustomUrl) return;
    this.loadedCustomUrl = true;
    const saved = await this.packStorage.getCustomCatalogUrl();
    if (saved) {
      this.customCatalogUrl = saved;
    }
  }

  private safeFetch(rawUrl: string, headers?: HeadersInit): Promise<Response> {
    return safePackFetch(this.fetchImpl, rawUrl, this.allowRelativeUrls, headers);
  }

  async fetchCatalog(catalogUrl?: string): Promise<PackCatalog> {
    await this.ensureCustomCatalogLoaded();
    const targetUrl = catalogUrl?.trim() || this.getCatalogUrl();
    if (!targetUrl) {
      throw new Error(
        'No pack catalog URL is configured. Set VITE_PACK_CATALOG_URL or enter a packs.json URL in Settings.',
      );
    }

    const cached = await this.packStorage.getCachedCatalog();
    const headers = new Headers();
    if (cached && cached.url === targetUrl && cached.etag) {
      headers.set('If-None-Match', cached.etag);
    }

    try {
      const res = await this.safeFetch(targetUrl, headers);
      if (res.status === 304 && cached && cached.url === targetUrl) {
        return cached.catalog;
      }
      if (!res.ok) {
        throw new Error(`Failed to fetch pack catalog (HTTP ${res.status}).`);
      }
      const bytes = await readResponseWithCap(res, PACK_SECURITY_LIMITS.maxCatalogBytes);
      const rawJson = new TextDecoder('utf-8').decode(bytes);
      const catalog = parseAndValidatePackCatalog(rawJson, {
        allowRelativeUrls: this.allowRelativeUrls || targetUrl.startsWith('/'),
      });
      const etag = res.headers.get('etag') ?? undefined;
      await this.packStorage.setCachedCatalog({
        url: targetUrl,
        catalog,
        ...(etag ? { etag } : {}),
        fetchedAt: Date.now(),
      });
      return catalog;
    } catch (err) {
      // Offline resilience: return cached catalog if network failed
      if (cached && cached.url === targetUrl) {
        return cached.catalog;
      }
      throw err;
    }
  }

  async listInstalledPacks(): Promise<InstalledPackInfo[]> {
    return this.packStorage.listInstalledPacks();
  }

  async installPackFromCatalog(
    entry: PackCatalogEntry,
    onProgress?: (progress: PackInstallProgress) => void,
  ): Promise<InstalledPackInfo> {
    return this.installPackFromUrl(entry.url, {
      ...(entry.sha256 ? { expectedSha256: entry.sha256 } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
  }

  async installPackFromUrl(
    url: string,
    opts?: { expectedSha256?: string; onProgress?: (progress: PackInstallProgress) => void },
  ): Promise<InstalledPackInfo> {
    opts?.onProgress?.({ phase: 'downloading', loadedBytes: 0 });
    const res = await this.safeFetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download pack from "${url}" (HTTP ${res.status}).`);
    }
    const bytes = await readResponseWithCap(
      res,
      PACK_SECURITY_LIMITS.maxCompressedBytes,
      (loadedBytes, totalBytes) => {
        opts?.onProgress?.({
          phase: 'downloading',
          loadedBytes,
          ...(totalBytes !== undefined ? { totalBytes } : {}),
        });
      },
    );
    const catalogUrl = this.getCatalogUrl();
    return this.installPackFromBytes(bytes, {
      ...(opts?.expectedSha256 ? { expectedSha256: opts.expectedSha256 } : {}),
      ...(catalogUrl ? { sourceCatalogUrl: catalogUrl } : {}),
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
      packUrl: url.trim(),
    });
  }

  /**
   * `packUrl` is where the bytes came from. A sharded pack's index needs it: its shards are
   * downloaded later from the same directory, so a sharded index can't be installed from a file.
   */
  async installPackFromBytes(
    bytes: Uint8Array,
    opts?: {
      expectedSha256?: string;
      sourceCatalogUrl?: string;
      onProgress?: (progress: PackInstallProgress) => void;
      packUrl?: string;
    },
  ): Promise<InstalledPackInfo> {
    opts?.onProgress?.({ phase: 'verifying' });
    const decoded = decodePackArchive(bytes, {
      ...(opts?.expectedSha256 ? { expectedSha256: opts.expectedSha256 } : {}),
    });

    const now = Date.now();

    if ('entries' in decoded) {
      const m = decoded.manifest;
      const sharding = m.sharding;
      if (sharding && !opts?.packUrl) {
        throw new Error(
          `${m.name} is a sharded pack: install it from its catalog or URL, not from a file.`,
        );
      }
      // A sharded pack's index rows are stubs until their shard downloads (core `shards.ts`).
      const materialized = materializeDictionaryEntries(m.id, decoded.entries, {
        stub: Boolean(sharding),
      });
      opts?.onProgress?.({
        phase: 'indexing',
        indexedEntries: 0,
        totalEntries: materialized.length,
      });

      await this.packStorage.replaceDictionaryPackEntries(m.id, materialized, (done, total) => {
        opts?.onProgress?.({
          phase: 'indexing',
          indexedEntries: done,
          totalEntries: total,
        });
      });

      const info: InstalledPackInfo = {
        id: m.id,
        kind: 'dictionary',
        name: m.name,
        version: m.version,
        language: m.language,
        entryCount: materialized.length,
        byteSize: bytes.byteLength,
        installedAt: now,
        licenseName: m.license_name,
        licenseUrl: m.license_url,
        attribution: m.attribution,
        sourceUrl: m.source_url,
        ...(opts?.sourceCatalogUrl ? { sourceCatalogUrl: opts.sourceCatalogUrl } : {}),
        ...(sharding ? { shardCount: sharding.shards.length, shardsLoaded: 0 } : {}),
      };
      await this.packStorage.putInstalledPack(info);
      if (sharding && opts?.packUrl) {
        await this.packStorage.setShardState({
          packId: m.id,
          version: m.version,
          installedAt: now,
          indexUrl: opts.packUrl,
          sharding,
          loaded: [],
        });
      }
      opts?.onProgress?.({
        phase: 'done',
        indexedEntries: materialized.length,
        totalEntries: materialized.length,
      });
      return info;
    }

    // Stroke pack (kept strictly separated by script: `ja` KanjiVG vs `zh-Hans` Make Me a Hanzi)
    const m = decoded.manifest;
    const entriesList = Object.entries(decoded.characters);
    opts?.onProgress?.({
      phase: 'indexing',
      indexedEntries: 0,
      totalEntries: entriesList.length,
    });

    const lookupIndex = buildStrokeLookupIndex(
      m.script,
      entriesList.map(([char, data]) => ({ char, medians: data.medians })),
    );

    await this.packStorage.replaceStrokePack(
      m.id,
      m.script,
      decoded.characters,
      lookupIndex,
      (done, total) => {
        opts?.onProgress?.({
          phase: 'indexing',
          indexedEntries: done,
          totalEntries: total,
        });
      },
    );

    const info: InstalledPackInfo = {
      id: m.id,
      kind: 'strokes',
      name: m.name,
      version: m.version,
      language: m.language,
      script: m.script,
      entryCount: entriesList.length,
      byteSize: bytes.byteLength,
      installedAt: now,
      licenseName: m.license_name,
      licenseUrl: m.license_url,
      attribution: m.attribution,
      sourceUrl: m.source_url,
      ...(opts?.sourceCatalogUrl ? { sourceCatalogUrl: opts.sourceCatalogUrl } : {}),
    };
    await this.packStorage.putInstalledPack(info);
    opts?.onProgress?.({
      phase: 'done',
      indexedEntries: entriesList.length,
      totalEntries: entriesList.length,
    });
    return info;
  }

  async downloadAllShards(
    packId: PackId,
    onProgress?: (progress: PackInstallProgress) => void,
  ): Promise<InstalledPackInfo> {
    const info =
      packId.startsWith('dict-') &&
      (await this.shardLoader.loadAllShards(packId as DictionaryPackId, onProgress));
    if (!info) throw new Error(`Pack "${packId}" is not installed.`);
    return info;
  }

  async removePack(packId: PackId): Promise<void> {
    await this.packStorage.removePack(packId);
  }

  async getStorageUsageBytes(): Promise<number> {
    return this.packStorage.getStorageUsageBytes();
  }
}
