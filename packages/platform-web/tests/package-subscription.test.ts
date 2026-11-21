import { CatalogValidationError } from '@flash/core/sources';
import { describe, expect, it, vi } from 'vitest';
import { WebPackageSubscriptionFetcher } from '../src/sources/package-subscription.ts';

describe('WebPackageSubscriptionFetcher', () => {
  it('rejects non-https URLs and enforces streaming byte caps', async () => {
    const fetchMock = vi.fn();
    const fetcher = new WebPackageSubscriptionFetcher({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(fetcher.fetchCatalog('http://example.com/index.json')).rejects.toThrow(
      CatalogValidationError,
    );
    await expect(fetcher.fetchPackage('javascript:alert(1)')).rejects.toThrow(
      CatalogValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // Streaming response exceeding maxBytes aborts cleanly
    const bigStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(bigStream, { status: 200 }));
    await expect(
      fetcher.fetchPackage('https://example.com/big.flashpkg', { maxBytes: 1000 }),
    ).rejects.toThrow(/maximum allowed size/i);
  });

  it('sends ETag/Last-Modified conditional headers and handles 304 Not Modified', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(init?.credentials).toBe('omit');
      if (headers.get('If-None-Match') === '"v1"') {
        return new Response(null, { status: 304 });
      }
      return new Response(new Uint8Array([80, 75, 3, 4]), {
        status: 200,
        headers: { ETag: '"v1"', 'Last-Modified': 'Fri, 20 Nov 2026 12:00:00 GMT' },
      });
    });

    const fetcher = new WebPackageSubscriptionFetcher({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const first = await fetcher.fetchPackage(
      'https://raw.githubusercontent.com/org/repo/main/a.flashpkg',
    );
    expect(first.notModified).toBe(false);
    if (!first.notModified) {
      expect(first.etag).toBe('"v1"');
      expect(first.bytes.byteLength).toBe(4);
    }

    const second = await fetcher.fetchPackage(
      'https://raw.githubusercontent.com/org/repo/main/a.flashpkg',
      {
        etag: '"v1"',
      },
    );
    expect(second).toEqual({ notModified: true });
  });
});
