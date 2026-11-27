import type { CollectionStatePatch, FlashEvent, SerializedCollectionState } from '@flash/core';
import type { ReplayWorkerClient } from '@flash/platform';
import type { ReplayWorkerRequest, ReplayWorkerResponse } from './replay.worker.ts';

interface PendingCall {
  resolve: (value: CollectionStatePatch | undefined) => void;
  reject: (err: Error) => void;
}

/**
 * Dedicated ES module Web Worker client running FSRS event replay off the main thread (§4.1 & §8).
 */
class WebReplayWorkerClient implements ReplayWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private terminated = false;

  constructor(worker?: Worker) {
    this.worker =
      worker ??
      new Worker(new URL('./replay.worker.ts', import.meta.url), {
        type: 'module',
      });

    this.worker.onmessage = (ev: MessageEvent<ReplayWorkerResponse>) => {
      const msg = ev.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.patch);
      } else {
        entry.reject(new Error(msg.error));
      }
    };

    this.worker.onerror = (ev: ErrorEvent) => {
      const err = new Error(ev.message || 'Replay worker encountered an unhandled error');
      for (const entry of this.pending.values()) {
        entry.reject(err);
      }
      this.pending.clear();
    };
  }

  private send(request: ReplayWorkerRequest): Promise<CollectionStatePatch | undefined> {
    if (this.terminated) {
      return Promise.reject(new Error('Replay worker has been terminated'));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }

  async hydrate(snapshot: SerializedCollectionState): Promise<void> {
    const id = this.nextId++;
    await this.send({ id, type: 'hydrate', snapshot });
  }

  async apply(events: readonly FlashEvent[]): Promise<CollectionStatePatch> {
    const id = this.nextId++;
    const patch = await this.send({ id, type: 'apply', events: [...events] });
    if (!patch) {
      throw new Error('Replay worker returned empty patch');
    }
    return patch;
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    const err = new Error('Replay worker terminated');
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
    this.worker.terminate();
  }
}

export function createWebReplayWorker(): ReplayWorkerClient | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new WebReplayWorkerClient();
  } catch {
    return null;
  }
}
