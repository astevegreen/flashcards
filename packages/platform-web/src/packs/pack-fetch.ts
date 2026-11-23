import { assertSafePackUrl } from '@flash/core/dictionary';

function declaredLength(res: Response): number | undefined {
  const header = res.headers.get('content-length');
  const declared = header ? Number.parseInt(header, 10) : Number.NaN;
  return Number.isFinite(declared) && declared > 0 ? declared : undefined;
}

function concatChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readStreamWithCap(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  totalBytes: number | undefined,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    while (true) {
      // A stream is read in order, one chunk at a time.
      const { done, value } = await reader.read(); // NOSONAR (S9382)
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      loaded += value.byteLength;
      if (loaded > maxBytes) {
        await reader.cancel().catch(() => {}); // NOSONAR (S9382)
        throw new Error(`Pack download exceeded maximum allowed size (${maxBytes} bytes).`);
      }
      chunks.push(value);
      onProgress?.(loaded, totalBytes);
    }
  } finally {
    reader.releaseLock();
  }
  return concatChunks(chunks, loaded);
}

/** Reads a pack download with a hard byte cap (declared length and streamed bytes, §13). */
export async function readResponseWithCap(
  res: Response,
  maxBytes: number,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<Uint8Array> {
  const totalBytes = declaredLength(res);
  if (totalBytes !== undefined && totalBytes > maxBytes) {
    throw new Error(`Pack download exceeds maximum allowed size (${maxBytes} bytes).`);
  }

  if (res.body && typeof res.body.getReader === 'function') {
    return readStreamWithCap(res.body, maxBytes, totalBytes, onProgress);
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
