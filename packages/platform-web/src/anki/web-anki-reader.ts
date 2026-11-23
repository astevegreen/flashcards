import type { AnkiPackageReader, AnkiPackageReadStage } from '@flash/platform';
import type { AnkiCollectionPlan } from '@flash/core/anki-export';
import { AnkiImportError, type AnkiImportErrorCode, type AnkiRawPackage } from '@flash/core/anki';
import {
  transferableInput,
  type AnkiReadRequest,
  type AnkiReadResponse,
} from './anki-reader-protocol.ts';

/** Minimal Worker surface used here, so tests can pass a fake. */
export interface AnkiReaderWorkerLike {
  onmessage: ((ev: MessageEvent<AnkiReadResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: AnkiReadRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

function createDefaultWorker(): AnkiReaderWorkerLike {
  return new Worker(new URL('./apkg-reader.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as AnkiReaderWorkerLike;
}

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

  constructor(createWorker: () => AnkiReaderWorkerLike = createDefaultWorker) {
    this.createWorker = createWorker;
  }

  read(
    bytes: Uint8Array,
    options?: {
      includeReviewHistory?: boolean;
      onStage?: (stage: AnkiPackageReadStage) => void;
    },
  ): Promise<AnkiRawPackage> {
    const worker = this.createWorker();
    const finish = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    return new Promise<AnkiRawPackage>((resolve, reject) => {
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'stage') {
          options?.onStage?.(msg.stage);
          return;
        }
        finish();
        if (msg.type === 'done') resolve(msg.pkg);
        else reject(toError(msg));
      };
      worker.onerror = (ev) => {
        finish();
        reject(new Error(ev.message || 'The Anki import worker failed to load'));
      };
      worker.postMessage(
        { type: 'read', bytes, includeReviewHistory: options?.includeReviewHistory === true },
        transferableInput(bytes),
      );
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
