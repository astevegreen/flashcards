import type {
  FsrsOptimizer,
  FsrsOptimizerInput,
  FsrsOptimizerRun,
  FsrsOptimizerStage,
} from '@flash/platform';
import type { FsrsOptimizerRequest, FsrsOptimizerResponse } from './fsrs-optimizer-protocol.ts';

/** Minimal Worker surface used here, so tests can pass a fake. */
export interface FsrsOptimizerWorkerLike {
  onmessage: ((ev: MessageEvent<FsrsOptimizerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: FsrsOptimizerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

function createDefaultWorker(): FsrsOptimizerWorkerLike {
  return new Worker(new URL('./fsrs-optimizer.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as FsrsOptimizerWorkerLike;
}

function abortError(): Error {
  const err = new Error('FSRS optimization cancelled');
  err.name = 'AbortError';
  return err;
}

/**
 * Runs each optimization in its own short-lived Worker (one per deck run). Cancelling or
 * finishing terminates the Worker, which is the only way to stop the synchronous WASM trainer.
 */
export class WebFsrsOptimizer implements FsrsOptimizer {
  private readonly createWorker: () => FsrsOptimizerWorkerLike;

  constructor(createWorker: () => FsrsOptimizerWorkerLike = createDefaultWorker) {
    this.createWorker = createWorker;
  }

  optimize(
    input: FsrsOptimizerInput,
    options?: { onStage?: (stage: FsrsOptimizerStage) => void },
  ): FsrsOptimizerRun {
    const worker = this.createWorker();
    let settled = false;
    let rejectRun: (err: Error) => void = () => {};

    const settle = () => {
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    const result = new Promise<number[]>((resolve, reject) => {
      rejectRun = reject;
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'stage') {
          options?.onStage?.(msg.stage);
          return;
        }
        settle();
        if (msg.type === 'done') resolve(msg.weights);
        else reject(new Error(msg.message));
      };
      worker.onerror = (ev) => {
        settle();
        reject(new Error(ev.message || 'FSRS optimizer worker failed to load'));
      };
      const copy: FsrsOptimizerInput = {
        ratings: input.ratings.slice(),
        delta_ts: input.delta_ts.slice(),
        lengths: input.lengths.slice(),
        enable_short_term: input.enable_short_term,
      };
      worker.postMessage({ type: 'optimize', input: copy }, [
        copy.ratings.buffer,
        copy.delta_ts.buffer,
        copy.lengths.buffer,
      ]);
    });

    return {
      result,
      cancel: () => {
        if (settled) return;
        settle();
        rejectRun(abortError());
      },
    };
  }
}

export function createWebFsrsOptimizer(): FsrsOptimizer {
  if (typeof Worker === 'undefined') {
    throw new Error('This browser cannot run the FSRS optimizer (Web Workers are unavailable).');
  }
  return new WebFsrsOptimizer();
}
