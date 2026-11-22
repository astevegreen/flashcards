import type { AnkiPackageReader, AnkiPackageReadStage } from '@flash/platform';
import { AnkiImportError, type AnkiImportErrorCode, type AnkiRawPackage } from '@flash/core/anki';
import type { AnkiReadRequest, AnkiReadResponse } from './anki-reader-protocol.ts';

/** Minimal Worker surface used here, so tests can pass a fake. */
export interface AnkiReaderWorkerLike {
  onmessage: ((ev: MessageEvent<AnkiReadResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: AnkiReadRequest): void;
  terminate(): void;
}

function createDefaultWorker(): AnkiReaderWorkerLike {
  return new Worker(new URL('./apkg-reader.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as AnkiReaderWorkerLike;
}

const ERROR_CODES: readonly string[] = [
  'not_apkg',
  'unsupported_format',
  'unsafe_archive',
  'too_large',
  'invalid_collection',
];

function toError(msg: { message: string; code?: string }): Error {
  if (msg.code && ERROR_CODES.includes(msg.code)) {
    return new AnkiImportError(msg.code as AnkiImportErrorCode, msg.message);
  }
  return new Error(msg.message);
}

/** Reads each `.apkg` in its own short-lived Worker, terminated once the read settles. */
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
      worker.postMessage({
        type: 'read',
        bytes,
        includeReviewHistory: options?.includeReviewHistory === true,
      });
    });
  }
}

export function createWebAnkiPackageReader(): AnkiPackageReader {
  return new WebAnkiPackageReader();
}
