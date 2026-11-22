import initFsrsBrowser, { Fsrs } from 'fsrs-browser';
import {
  handleFsrsOptimizerRequest,
  type FsrsOptimizerResponse,
  type FsrsTrainingEngine,
} from './fsrs-optimizer-protocol.ts';

/**
 * Phase 11 FSRS optimizer Web Worker. `fsrs-browser` (BSD-3-Clause, fsrs-rs compiled to WASM)
 * is only ever imported here, so neither its JS nor its `.wasm` reaches the initial bundle.
 * Training runs single-threaded: the rayon thread pool needs cross-origin isolation, which the
 * app does not enable, and a deck-sized review log trains in well under a second anyway.
 */

interface WorkerScopeLike {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage(message: FsrsOptimizerResponse): void;
}

const scope = self as unknown as WorkerScopeLike;

let engine: Promise<FsrsTrainingEngine> | null = null;

function loadEngine(): Promise<FsrsTrainingEngine> {
  engine ??= initFsrsBrowser().then(() => ({
    computeParameters(input) {
      const fsrs = new Fsrs();
      try {
        return fsrs.computeParameters(
          input.ratings,
          input.delta_ts,
          input.lengths,
          undefined,
          input.enable_short_term,
        );
      } finally {
        fsrs.free();
      }
    },
  }));
  return engine;
}

scope.onmessage = (ev) => {
  void handleFsrsOptimizerRequest(ev.data, loadEngine, (msg) => scope.postMessage(msg));
};
