/**
 * Response bodies for the per-call-site cap tests (P8): one that streams more bytes than a cap
 * with no `Content-Length`, and one whose header declares more than the cap. Both count how much
 * of the body the reader pulled, so a test can check the reader stopped early.
 */

export interface OversizedBody {
  response: Response;
  /** Bytes the reader pulled before it stopped or cancelled. */
  readonly pulled: number;
  readonly cancelled: boolean;
}

/** Streams `total` bytes in `chunk`-byte pieces, with no `Content-Length` header. */
export function streamedBody(
  total: number,
  chunk = 64 * 1024,
  headers: Record<string, string> = {},
): OversizedBody {
  let pulled = 0;
  let cancelled = false;
  const piece = new Uint8Array(chunk).fill(0x41);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, total - pulled);
      pulled += size;
      controller.enqueue(size === chunk ? piece.slice() : piece.slice(0, size));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers }),
    get pulled() {
      return pulled;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/** A small body whose `Content-Length` header declares `declared` bytes. */
export function declaredBody(declared: number, headers: Record<string, string> = {}): Response {
  return new Response('x', {
    status: 200,
    headers: { ...headers, 'content-length': String(declared) },
  });
}
