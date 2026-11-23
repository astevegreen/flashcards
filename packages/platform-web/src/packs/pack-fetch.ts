import { assertSafePackUrl } from '@flash/core/dictionary';

/** Reads a pack download with a hard byte cap (declared length and streamed bytes, §13). */
export async function readResponseWithCap(
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

/** GET with credentials omitted; refuses unsafe URLs and https → http redirect downgrades. */
export async function safePackFetch(
  fetchImpl: typeof fetch,
  rawUrl: string,
  allowRelativeUrls: boolean,
  headers?: HeadersInit,
): Promise<Response> {
  const safeUrl = assertSafePackUrl(rawUrl, allowRelativeUrls);
  const res = await fetchImpl(safeUrl, {
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

/**
 * URL of a file next to `indexUrl` (a shard beside its pack index). `file` is a bare file
 * name (the pack schema forbids `/`), so the result stays in the index's directory.
 */
export function siblingPackUrl(indexUrl: string, file: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) {
    throw new Error(`Invalid pack file name "${file}".`);
  }
  const path = indexUrl.split(/[?#]/, 1)[0] ?? indexUrl;
  return `${path.slice(0, path.lastIndexOf('/') + 1)}${file}`;
}
