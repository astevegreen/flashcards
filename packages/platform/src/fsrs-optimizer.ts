/**
 * Phase 11 on-device FSRS optimizer (`fsrs-browser` WASM in a Web Worker on the web).
 * Input is the flattened training batch built by `@flash/core/fsrs-optimizer`.
 */
export interface FsrsOptimizerInput {
  ratings: Uint32Array;
  delta_ts: Uint32Array;
  lengths: Uint32Array;
  enable_short_term: boolean;
}

/** Coarse stages: the WASM trainer is synchronous, so it cannot report finer progress. */
export type FsrsOptimizerStage = 'loading' | 'training';

export interface FsrsOptimizerRun {
  /**
   * Raw weights from the trainer. Rejects with an `Error` whose `name` is `'AbortError'` after
   * `cancel()`, or with the trainer's error message when it fails.
   */
  readonly result: Promise<number[]>;
  /** Stops the run (terminates its Worker). No-op once the run has settled. */
  cancel(): void;
}

export interface FsrsOptimizer {
  optimize(
    input: FsrsOptimizerInput,
    options?: { onStage?: (stage: FsrsOptimizerStage) => void },
  ): FsrsOptimizerRun;
}
