import { SyncTransportError } from '@flash/core';
import { FLASHPKG_SECURITY_LIMITS } from '@flash/core/flashpkg';
import { assertSafeHttpsUrl, FAMILY_CATALOG_LIMITS } from '@flash/core/sources';
import { readBodyCapped } from '../net/read-capped.ts';
import type { PackageFetchResult, PackageSubscriptionFetcher } from '@flash/platform';

export interface WebPackageSubscriptionFetcherOptions {
  fetchImpl?: typeof fetch;
}

function readBodyWithByteCap(res: Response, maxBytes: number): Promise<Uint8Array> {
  return readBodyCapped(res, maxBytes, {
    tooLarge: (declared) =>
      new SyncTransportError(
        'UNKNOWN',
        declared === undefined
          ? `Remote download exceeded maximum allowed size (${maxBytes} bytes).`
          : `Remote resource exceeds maximum allowed size (${maxBytes} bytes).`,
      ),
  });
}

/**
 * Lazy-loaded HTTPS fetcher for `.flashpkg` URL subscriptions & Family Library `index.json` catalogs (§3.4, §13).
 * - Strictly enforces `https:` URLs without credentials
 * - Uses `credentials: 'omit'` so cookies/auth are never leaked to package hosts
 * - Enforces streaming byte caps to protect against oversized responses
 * - Supports `If-None-Match` (ETag) / `If-Modified-Since` (`304 Not Modified`)
 */
export class WebPackageSubscriptionFetcher implements PackageSubscriptionFetcher {
  private readonly fetchImpl: typeof fetch;

  constructor(options: WebPackageSubscriptionFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  private async safeHttpsFetch(
    rawUrl: string,
    opts?: { etag?: string; lastModified?: string },
  ): Promise<Response> {
    const safeUrl = assertSafeHttpsUrl(rawUrl);
    const headers = new Headers();
    if (opts?.etag) headers.set('If-None-Match', opts.etag);
    if (opts?.lastModified) headers.set('If-Modified-Since', opts.lastModified);

    let res: Response;
    try {
      res = await this.fetchImpl(safeUrl, {
        method: 'GET',
        headers,
        credentials: 'omit',
        redirect: 'follow',
      });
    } catch (err) {
      throw new SyncTransportError(
        'NETWORK',
        `Network error fetching "${safeUrl}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Re-validate final URL after any redirects (prevents https -> http downgrade)
    if (res.url) {
      assertSafeHttpsUrl(res.url);
    }

    return res;
  }

  async fetchCatalog(
    url: string,
    opts?: { etag?: string; lastModified?: string },
  ): Promise<
    | { notModified: true }
    | {
        notModified: false;
        rawJson: string;
        etag?: string;
        lastModified?: string;
      }
  > {
    const res = await this.safeHttpsFetch(url, opts);
    if (res.status === 304) {
      return { notModified: true };
    }
    if (!res.ok) {
      throw new SyncTransportError(
        res.status === 404 ? 'NOT_FOUND' : 'NETWORK',
        `Failed to fetch Family Library catalog (HTTP ${res.status}).`,
        res.status,
      );
    }

    const bytes = await readBodyWithByteCap(res, FAMILY_CATALOG_LIMITS.maxCatalogBytes);
    const rawJson = new TextDecoder().decode(bytes);
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;

    return {
      notModified: false,
      rawJson,
      ...(etag !== undefined ? { etag } : {}),
      ...(lastModified !== undefined ? { lastModified } : {}),
    };
  }

  async fetchPackage(
    url: string,
    opts?: { etag?: string; lastModified?: string; maxBytes?: number },
  ): Promise<PackageFetchResult> {
    const res = await this.safeHttpsFetch(url, opts);
    if (res.status === 304) {
      return { notModified: true };
    }
    if (!res.ok) {
      throw new SyncTransportError(
        res.status === 404 ? 'NOT_FOUND' : 'NETWORK',
        `Failed to download package (HTTP ${res.status}).`,
        res.status,
      );
    }

    const maxBytes = opts?.maxBytes ?? FLASHPKG_SECURITY_LIMITS.maxCompressedBytes;
    const bytes = await readBodyWithByteCap(res, maxBytes);
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;

    return {
      notModified: false,
      bytes,
      ...(etag !== undefined ? { etag } : {}),
      ...(lastModified !== undefined ? { lastModified } : {}),
    };
  }
}
