import type { AnkiPackageReadStage } from '@flash/platform';
import { AnkiImportError, type AnkiRawPackage } from '@flash/core/anki';
import type { ApkgReadOptions } from './apkg-reader.ts';

/** Messages between `WebAnkiPackageReader` (main thread) and `apkg-reader.worker.ts`. */
export interface AnkiReadRequest {
  type: 'read';
  bytes: Uint8Array;
  includeReviewHistory: boolean;
}

export type AnkiReadResponse =
  | { type: 'stage'; stage: AnkiPackageReadStage }
  | { type: 'done'; pkg: AnkiRawPackage }
  | { type: 'error'; message: string; code?: string };

function isReadRequest(data: unknown): data is AnkiReadRequest {
  if (typeof data !== 'object' || data === null) return false;
  const req = data as Partial<AnkiReadRequest>;
  return req.type === 'read' && req.bytes instanceof Uint8Array;
}

/**
 * Handles one read request. Every outcome posts exactly one `done` or `error`, so the caller's
 * promise always settles; user-facing `AnkiImportError`s keep their code across the boundary.
 */
export async function handleAnkiReadRequest(
  data: unknown,
  read: (bytes: Uint8Array, options: ApkgReadOptions) => Promise<AnkiRawPackage>,
  post: (msg: AnkiReadResponse) => void,
): Promise<void> {
  if (!isReadRequest(data)) {
    post({ type: 'error', message: 'Malformed Anki import request' });
    return;
  }
  try {
    post({ type: 'stage', stage: 'reading' });
    const pkg = await read(data.bytes, { includeReviewHistory: data.includeReviewHistory });
    post({ type: 'done', pkg });
  } catch (err) {
    if (err instanceof AnkiImportError) {
      post({ type: 'error', message: err.message, code: err.code });
      return;
    }
    const message = err instanceof Error && err.message ? err.message : String(err);
    post({ type: 'error', message: `Could not read this Anki package (${message}).` });
  }
}
