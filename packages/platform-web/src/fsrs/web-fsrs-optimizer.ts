import type {
  FsrsOptimizer,
  FsrsOptimizerInput,
  FsrsOptimizerRun,
  FsrsOptimizerStage,
} from '@flash/platform';
import type { FsrsOptimizerRequest, FsrsOptimizerResponse } from './fsrs-optimizer-protocol.ts';
import { watchWorker } from '../workers/worker-watch.ts';

/** Minimal Worker surface used here, so tests can pass a fake. */
export interface FsrsOptimizerWorkerLike {
  onmessage: ((ev: MessageEvent<FsrsOptimizerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror?: ((ev: MessageEvent) => void) | null;
  postMessage(message: FsrsOptimizerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

function createDefaultWorker(): FsrsOptimizerWorkerLike {
  return new Worker(new URL('./fsrs-optimizer.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as FsrsOptimizerWorkerLike;
}

/**
 * Training is one synchronous WASM call after the `training` stage, so this bounds the whole run.
 * Generous on purpose (a big collection on a slow phone; the user can cancel sooner): it is there
 * for a Worker that died silently.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

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
  private readonly idleTimeoutMs: number;

  constructor(
    createWorker: () => FsrsOptimizerWorkerLike = createDefaultWorker,
    options?: { idleTimeoutMs?: number },
  ) {
    this.createWorker = createWorker;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  optimize(
    input: FsrsOptimizerInput,
    options?: { onStage?: (stage: FsrsOptimizerStage) => void },
  ): FsrsOptimizerRun {
    const worker = this.createWorker();
    let settled = false;
    let rejectRun: (err: Error) => void = () => {};
    const watch = watchWorker(worker, 'FSRS optimizer', this.idleTimeoutMs, (err) => {
      settle();
      rejectRun(err);
    });

    function settle() {
      settled = true;
      watch.stop();
      worker.onmessage = null;
      worker.terminate();
    }

    const result = new Promise<number[]>((resolve, reject) => {
      rejectRun = reject;
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'stage') {
          watch.touch();
          options?.onStage?.(msg.stage);
          return;
        }
        settle();
        if (msg.type === 'done') resolve(msg.weights);
        else reject(new Error(msg.message));
      };
      const copy: FsrsOptimizerInput = {
        ratings: input.ratings.slice(),
        delta_ts: input.delta_ts.slice(),
        lengths: input.lengths.slice(),
        enable_short_term: input.enable_short_term,
      };
      try {
        worker.postMessage({ type: 'optimize', input: copy }, [
          copy.ratings.buffer,
          copy.delta_ts.buffer,
          copy.lengths.buffer,
        ]);
      } catch (err) {
        settle();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
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
    throw new TypeError(
      'This browser cannot run the FSRS optimizer (Web Workers are unavailable).',
    );
  }
  return new WebFsrsOptimizer();
}
