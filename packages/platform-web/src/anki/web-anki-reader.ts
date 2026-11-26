import type { AnkiPackageReader, AnkiPackageReadStage } from '@flash/platform';
import type { AnkiCollectionPlan } from '@flash/core/anki-export';
import { AnkiImportError, type AnkiImportErrorCode, type AnkiRawPackage } from '@flash/core/anki';
import {
  transferableInput,
  type AnkiReadRequest,
  type AnkiReadResponse,
} from './anki-reader-protocol.ts';
import { watchWorker } from '../workers/worker-watch.ts';

/** Minimal Worker surface used here, so tests can pass a fake. */
export interface AnkiReaderWorkerLike {
  onmessage: ((ev: MessageEvent<AnkiReadResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror?: ((ev: MessageEvent) => void) | null;
  postMessage(message: AnkiReadRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

function createDefaultWorker(): AnkiReaderWorkerLike {
  return new Worker(new URL('./apkg-reader.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as AnkiReaderWorkerLike;
}

/**
 * Bounds the wait for the Worker's `reading` stage message, sent once the Worker has loaded. The
 * read then runs to the end in one go and sends nothing, so it has no idle limit: a large deck on a
 * slow phone cannot be told from a dead Worker. Load and message errors still reject during it.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

const ERROR_CODES: ReadonlySet<string> = new Set([
  'not_apkg',
  'unsupported_format',
  'unsafe_archive',
  'too_large',
  'invalid_collection',
]);

function toError(msg: { message: string; code?: string }): Error {
  if (msg.code && ERROR_CODES.has(msg.code)) {
    return new AnkiImportError(msg.code as AnkiImportErrorCode, msg.message);
  }
  return new Error(msg.message);
}

/**
 * Reads each `.apkg` in its own short-lived Worker, terminated once the read settles. The input
 * buffer is transferred to the worker when `bytes` spans all of it, so callers must not reuse
 * `bytes` after `read` (the import panel never does).
 */
export class WebAnkiPackageReader implements AnkiPackageReader {
  private readonly createWorker: () => AnkiReaderWorkerLike;
  private readonly idleTimeoutMs: number;

  constructor(
    createWorker: () => AnkiReaderWorkerLike = createDefaultWorker,
    options?: { idleTimeoutMs?: number },
  ) {
    this.createWorker = createWorker;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  read(
    bytes: Uint8Array,
    options?: {
      includeReviewHistory?: boolean;
      onStage?: (stage: AnkiPackageReadStage) => void;
    },
  ): Promise<AnkiRawPackage> {
    const worker = this.createWorker();
    return new Promise<AnkiRawPackage>((resolve, reject) => {
      const finish = () => {
        watch.stop();
        worker.onmessage = null;
        worker.terminate();
      };
      const watch = watchWorker(worker, 'Anki import', this.idleTimeoutMs, (err) => {
        finish();
        reject(err);
      });
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'stage') {
          // The read runs from here to `done` without a message: silence is not a hang.
          watch.quiet();
          options?.onStage?.(msg.stage);
          return;
        }
        finish();
        if (msg.type === 'done') resolve(msg.pkg);
        else reject(toError(msg));
      };
      try {
        worker.postMessage(
          { type: 'read', bytes, includeReviewHistory: options?.includeReviewHistory === true },
          transferableInput(bytes),
        );
      } catch (err) {
        finish();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** `.apkg` export: writes `collection.anki2` in its own short-lived sql.js Worker. */
  async writeCollection(plan: AnkiCollectionPlan): Promise<Uint8Array> {
    const { WebAnkiCollectionWriter } = await import('./apkg-writer.ts');
    return new WebAnkiCollectionWriter().write(plan);
  }
}

export function createWebAnkiPackageReader(): AnkiPackageReader {
  return new WebAnkiPackageReader();
}
