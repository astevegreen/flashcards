import type { FsrsOptimizerInput, FsrsOptimizerStage } from '@flash/platform';

/**
 * Message protocol between `WebFsrsOptimizer` (main thread) and `fsrs-optimizer.worker.ts`.
 * The handler is engine-agnostic so tests can drive it with the real WASM in Node or a fake.
 */
export interface FsrsOptimizerRequest {
  type: 'optimize';
  input: FsrsOptimizerInput;
}

export type FsrsOptimizerResponse =
  | { type: 'stage'; stage: FsrsOptimizerStage }
  | { type: 'done'; weights: number[] }
  | { type: 'error'; message: string };

/** The slice of `fsrs-browser` the worker needs (one synchronous training call). */
export interface FsrsTrainingEngine {
  computeParameters(input: FsrsOptimizerInput): ArrayLike<number>;
}

/** The slice of an `fsrs-browser` `Fsrs` instance one training run uses. */
export interface FsrsTrainer {
  computeParameters(
    ratings: Uint32Array,
    delta_ts: Uint32Array,
    lengths: Uint32Array,
    progress: undefined,
    enable_short_term: boolean,
  ): ArrayLike<number>;
  free(): void;
}

/**
 * Wraps `fsrs-browser` as a training engine: a fresh trainer per run, always freed. A WASM panic
 * in `computeParameters` leaves the wasm-bindgen instance borrowed, so `free()` then throws a
 * second error; it is swallowed so the original failure is the one the caller sees.
 */
export function createFsrsTrainingEngine(newTrainer: () => FsrsTrainer): FsrsTrainingEngine {
  return {
    computeParameters(input) {
      const fsrs = newTrainer();
      try {
        return fsrs.computeParameters(
          input.ratings,
          input.delta_ts,
          input.lengths,
          undefined,
          input.enable_short_term,
        );
      } finally {
        try {
          fsrs.free();
        } catch {
          // Already failing (see above); the instance's memory goes with the Worker.
        }
      }
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const text = String(err);
  return text && text !== '[object Object]' ? text : 'FSRS optimizer failed';
}

function isOptimizeRequest(data: unknown): data is FsrsOptimizerRequest {
  if (typeof data !== 'object' || data === null) return false;
  const req = data as Partial<FsrsOptimizerRequest>;
  return (
    req.type === 'optimize' &&
    req.input?.ratings instanceof Uint32Array &&
    req.input.delta_ts instanceof Uint32Array &&
    req.input.lengths instanceof Uint32Array
  );
}

/**
 * Handles one request: loads the engine (stage `loading`), trains (stage `training`) and posts
 * the raw weights. Every failure, including a malformed request, ends in an `error` message so the
 * caller's promise always settles.
 */
export async function handleFsrsOptimizerRequest(
  data: unknown,
  loadEngine: () => Promise<FsrsTrainingEngine>,
  post: (msg: FsrsOptimizerResponse) => void,
): Promise<void> {
  if (!isOptimizeRequest(data)) {
    post({ type: 'error', message: 'Malformed FSRS optimizer request' });
    return;
  }
  try {
    post({ type: 'stage', stage: 'loading' });
    const engine = await loadEngine();
    post({ type: 'stage', stage: 'training' });
    const raw = engine.computeParameters(data.input);
    post({ type: 'done', weights: Array.from(raw) });
  } catch (err) {
    post({ type: 'error', message: describeError(err) });
  }
}
