/**
 * The one capped HTTP body reader (P8, R8): refuses a body whose `Content-Length` is over the cap
 * and stops reading a stream as soon as it passes the cap, so a missing or lying header can't
 * make the app buffer an unbounded download.
 */

export interface ReadCappedOptions {
  /** The error to throw; `declared` is set when the `Content-Length` header was over the cap. */
  tooLarge: (declared?: number) => Error;
  onProgress?: (loaded: number, total?: number) => void;
}

function declaredLength(res: Response): number | undefined {
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
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

export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  options: ReadCappedOptions,
): Promise<Uint8Array> {
  const { tooLarge, onProgress } = options;
  const total = declaredLength(res);
  if (total !== undefined && total > maxBytes) throw tooLarge(total);

  if (!res.body || typeof res.body.getReader !== 'function') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge();
    onProgress?.(bytes.byteLength, total ?? bytes.byteLength);
    return bytes;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      // A stream is read in order, one chunk at a time.
      const { done, value } = await reader.read(); // NOSONAR (S9382)
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      loaded += value.byteLength;
      if (loaded > maxBytes) {
        await reader.cancel().catch(() => undefined); // NOSONAR (S9382)
        throw tooLarge();
      }
      chunks.push(value);
      onProgress?.(loaded, total);
    }
  } finally {
    reader.releaseLock();
  }
  return concatChunks(chunks, loaded);
}

/** {@link readBodyCapped}, decoded as UTF-8 text. */
export async function readTextCapped(
  res: Response,
  maxBytes: number,
  options: ReadCappedOptions,
): Promise<string> {
  return new TextDecoder().decode(await readBodyCapped(res, maxBytes, options));
}
