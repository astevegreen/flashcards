import {
  assertSafePackUrl,
  decodePackArchive,
  materializeDictionaryEntries,
  PACK_SECURITY_LIMITS,
  parseAndValidatePackCatalog,
  type PackCatalog,
  type PackCatalogEntry,
  type PackId,
} from '@flash/core/dictionary';
import { buildStrokeLookupIndex } from '@flash/core/drawing';
import type { InstalledPackInfo, PackInstallProgress, PackManager } from '@flash/platform';
import type { DexiePackStorage } from './dexie-pack-storage.ts';

export interface WebPackManagerOptions {
  packStorage: DexiePackStorage;
  defaultCatalogUrl?: string;
  allowRelativeUrls?: boolean;
  fetchImpl?: typeof fetch;
}

async function readResponseWithCap(
  res: Response,
  maxBytes: number,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<Uint8Array> {
  const contentLengthHeader = res.headers.get('content-length');
  const declared = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : NaN;
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : undefined;
  if (totalBytes !== undefined && totalBytes > maxBytes) {
    throw new Error(`Pack download exceeds maximum allowed size (${maxBytes} bytes).`);
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          loaded += value.byteLength;
          if (loaded > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`Pack download exceeded maximum allowed size (${maxBytes} bytes).`);
          }
          chunks.push(value);
          onProgress?.(loaded, totalBytes);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(`Pack download exceeded maximum allowed size (${maxBytes} bytes).`);
  }
  onProgress?.(buf.byteLength, totalBytes ?? buf.byteLength);
  return buf;
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
  private customCatalogUrl?: string;
  private loadedCustomUrl = false;

  constructor(options: WebPackManagerOptions) {
    this.packStorage = options.packStorage;
    if (options.defaultCatalogUrl?.trim()) {
      this.defaultCatalogUrl = options.defaultCatalogUrl.trim();
    }
    this.allowRelativeUrls = options.allowRelativeUrls ?? false;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
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

  private async safeFetch(rawUrl: string, headers?: HeadersInit): Promise<Response> {
    const safeUrl = assertSafePackUrl(rawUrl, this.allowRelativeUrls);
    const res = await this.fetchImpl(safeUrl, {
      method: 'GET',
      ...(headers ? { headers } : {}),
      credentials: 'omit',
      redirect: 'follow',
    });
    // Prevent https -> http downgrade on redirects for external URLs
    if (res.url && !safeUrl.startsWith('/')) {
      assertSafePackUrl(res.url, false);
    }
    return res;
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
    });
  }

  async installPackFromBytes(
    bytes: Uint8Array,
    opts?: {
      expectedSha256?: string;
      sourceCatalogUrl?: string;
      onProgress?: (progress: PackInstallProgress) => void;
    },
  ): Promise<InstalledPackInfo> {
    opts?.onProgress?.({ phase: 'verifying' });
    const decoded = decodePackArchive(bytes, {
      ...(opts?.expectedSha256 ? { expectedSha256: opts.expectedSha256 } : {}),
    });

    const now = Date.now();

    if ('entries' in decoded) {
      const m = decoded.manifest;
      const materialized = materializeDictionaryEntries(m.id, decoded.entries);
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
      };
      await this.packStorage.putInstalledPack(info);
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

  async removePack(packId: PackId): Promise<void> {
    await this.packStorage.removePack(packId);
  }

  async getStorageUsageBytes(): Promise<number> {
    return this.packStorage.getStorageUsageBytes();
  }
}
