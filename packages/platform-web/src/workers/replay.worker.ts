import {
  computeStatePatch,
  createEmptyState,
  deserializeCollectionState,
  type CollectionState,
  type CollectionStatePatch,
  type FlashEvent,
  type SerializedCollectionState,
} from '@flash/core';

export type ReplayWorkerRequest =
  | {
      id: number;
      type: 'hydrate';
      snapshot: SerializedCollectionState;
    }
  | {
      id: number;
      type: 'apply';
      events: FlashEvent[];
    };

export type ReplayWorkerResponse =
  | {
      id: number;
      ok: true;
      patch?: CollectionStatePatch;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

interface WorkerGlobalLike {
  onmessage: ((ev: MessageEvent<ReplayWorkerRequest>) => void) | null;
  postMessage(message: ReplayWorkerResponse): void;
}

const workerScope = self as unknown as WorkerGlobalLike;
let state: CollectionState = createEmptyState();

workerScope.onmessage = (ev: MessageEvent<ReplayWorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'hydrate') {
      state = deserializeCollectionState(msg.snapshot);
      workerScope.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.type === 'apply') {
      const patch = computeStatePatch(state, msg.events);
      workerScope.postMessage({ id: msg.id, ok: true, patch });
      return;
    }
    workerScope.postMessage({
      id: (msg as { id: number }).id,
      ok: false,
      error: 'Unknown replay worker message type',
    });
  } catch (err) {
    workerScope.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
