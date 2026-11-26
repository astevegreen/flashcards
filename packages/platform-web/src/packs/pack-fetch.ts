import { assertSafePackUrl } from '@flash/core/dictionary';
import { readBodyCapped } from '../net/read-capped.ts';

/** Reads a pack download with a hard byte cap (declared length and streamed bytes, §13). */
export function readResponseWithCap(
  res: Response,
  maxBytes: number,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<Uint8Array> {
  return readBodyCapped(res, maxBytes, {
    tooLarge: (declared) =>
      new Error(
        `Pack download ${declared === undefined ? 'exceeded' : 'exceeds'} maximum allowed size (${maxBytes} bytes).`,
      ),
    ...(onProgress ? { onProgress } : {}),
  });
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
