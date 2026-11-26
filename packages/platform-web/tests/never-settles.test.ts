import type { FsrsOptimizerInput } from '@flash/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnkiReadResponse } from '../src/anki/anki-reader-protocol.ts';
import { WebAnkiPackageReader, type AnkiReaderWorkerLike } from '../src/anki/web-anki-reader.ts';
import { WebAudioPlayer } from '../src/audio/web-audio-player.ts';
import { WebFiles } from '../src/files/web-files.ts';
import type { FsrsOptimizerResponse } from '../src/fsrs/fsrs-optimizer-protocol.ts';
import { WebFsrsOptimizer, type FsrsOptimizerWorkerLike } from '../src/fsrs/web-fsrs-optimizer.ts';

/** A Worker that never answers unless told to: the hang C25 is about. */
class SilentWorker<T> {
  onmessage: ((ev: MessageEvent<T>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  terminated = 0;
  postMessage(): void {
    if (this.postError) throw this.postError;
  }
  terminate(): void {
    this.terminated += 1;
  }
  /** Set to make `postMessage` throw, as a DataCloneError does. */
  postError: Error | null = null;
  emit(data: T): void {
    this.onmessage?.({ data } as MessageEvent<T>);
  }
}

const fsrsInput = (): FsrsOptimizerInput => ({
  ratings: new Uint32Array([3]),
  delta_ts: new Uint32Array([0]),
  lengths: new Uint32Array([1]),
  enable_short_term: true,
});

/** Settles to 'pending' when `p` has not settled after the microtask queue drains. */
async function state(p: Promise<unknown>): Promise<string> {
  const pending = Symbol('pending');
  const r = await Promise.race([
    p.then(
      () => 'fulfilled',
      (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), 0)),
  ]);
  return r === pending ? 'pending' : String(r);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Worker requests always settle (C25)', () => {
  it('Anki reader: a message the page cannot read rejects and frees the Worker', async () => {
    const worker = new SilentWorker<AnkiReadResponse>();
    const read = new WebAnkiPackageReader(() => worker as AnkiReaderWorkerLike).read(
      new Uint8Array([1]),
    );
    worker.onmessageerror?.({} as MessageEvent);
    await expect(read).rejects.toThrow(/could not be read/);
    expect(worker.terminated).toBe(1);
  });

  it('Anki reader: a Worker that goes silent before its stage message times out', async () => {
    vi.useFakeTimers();
    const worker = new SilentWorker<AnkiReadResponse>();
    const read = new WebAnkiPackageReader(() => worker as AnkiReaderWorkerLike, {
      idleTimeoutMs: 1_000,
    }).read(new Uint8Array([1]));
    const outcome = read.then(
      () => 'resolved',
      (e: unknown) => (e as Error).message,
    );
    vi.advanceTimersByTime(900);
    expect(worker.terminated).toBe(0);
    vi.advanceTimersByTime(100);
    expect(await outcome).toMatch(/stopped responding/);
    expect(worker.terminated).toBe(1);
  });

  it('Anki reader: the read itself has no idle limit, and errors during it still reject', async () => {
    vi.useFakeTimers();
    const worker = new SilentWorker<AnkiReadResponse>();
    const read = new WebAnkiPackageReader(() => worker as AnkiReaderWorkerLike, {
      idleTimeoutMs: 1_000,
    }).read(new Uint8Array([1]));
    worker.emit({ type: 'stage', stage: 'reading' });
    // A large deck on a slow phone sends nothing until it is done.
    vi.advanceTimersByTime(60 * 60_000);
    expect(worker.terminated).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    worker.onmessageerror?.({} as MessageEvent);
    await expect(read).rejects.toThrow(/could not be read/);
    expect(worker.terminated).toBe(1);
  });

  it('FSRS optimizer: messageerror and silence both reject and terminate', async () => {
    const w1 = new SilentWorker<FsrsOptimizerResponse>();
    const r1 = new WebFsrsOptimizer(() => w1 as FsrsOptimizerWorkerLike).optimize(fsrsInput());
    w1.onmessageerror?.({} as MessageEvent);
    await expect(r1.result).rejects.toThrow(/could not be read/);
    expect(w1.terminated).toBe(1);

    vi.useFakeTimers();
    const w2 = new SilentWorker<FsrsOptimizerResponse>();
    const r2 = new WebFsrsOptimizer(() => w2 as FsrsOptimizerWorkerLike, {
      idleTimeoutMs: 1_000,
    }).optimize(fsrsInput());
    const outcome = r2.result.then(
      () => 'resolved',
      (e: unknown) => (e as Error).message,
    );
    vi.advanceTimersByTime(1_000);
    expect(await outcome).toMatch(/stopped responding/);
    expect(w2.terminated).toBe(1);
    // Cancelling after the timeout is a no-op.
    r2.cancel();
    expect(w2.terminated).toBe(1);
  });

  it('FSRS optimizer: training itself has no idle limit, and errors during it still reject', async () => {
    vi.useFakeTimers();
    const worker = new SilentWorker<FsrsOptimizerResponse>();
    const run = new WebFsrsOptimizer(() => worker as FsrsOptimizerWorkerLike, {
      idleTimeoutMs: 1_000,
    }).optimize(fsrsInput());
    worker.emit({ type: 'stage', stage: 'loading' });
    worker.emit({ type: 'stage', stage: 'training' });
    // A long synchronous run on a slow device sends nothing for a long time.
    vi.advanceTimersByTime(60 * 60_000);
    expect(worker.terminated).toBe(0);
    worker.onmessageerror?.({} as MessageEvent);
    await expect(run.result).rejects.toThrow(/could not be read/);
    expect(worker.terminated).toBe(1);
  });

  it('a postMessage that throws rejects and frees the Worker', async () => {
    const clone = new DOMException('could not be cloned', 'DataCloneError');
    const w1 = new SilentWorker<AnkiReadResponse>();
    w1.postError = clone;
    await expect(
      new WebAnkiPackageReader(() => w1 as AnkiReaderWorkerLike).read(new Uint8Array([1])),
    ).rejects.toBe(clone);
    expect(w1.terminated).toBe(1);

    vi.useFakeTimers();
    const w2 = new SilentWorker<FsrsOptimizerResponse>();
    w2.postError = clone;
    const run = new WebFsrsOptimizer(() => w2 as FsrsOptimizerWorkerLike).optimize(fsrsInput());
    await expect(run.result).rejects.toBe(clone);
    expect(w2.terminated).toBe(1);
    // Nothing is left running: no idle timer, no second terminate on cancel.
    expect(vi.getTimerCount()).toBe(0);
    run.cancel();
    expect(w2.terminated).toBe(1);
  });

  it('FSRS optimizer: a finished run clears its timer', async () => {
    vi.useFakeTimers();
    const worker = new SilentWorker<FsrsOptimizerResponse>();
    const run = new WebFsrsOptimizer(() => worker as FsrsOptimizerWorkerLike, {
      idleTimeoutMs: 1_000,
    }).optimize(fsrsInput());
    worker.emit({ type: 'done', weights: [1] });
    await expect(run.result).resolves.toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('WebFiles.pickFile settles when the file cannot be read (C25)', () => {
  it('rejects with the read error instead of hanging', async () => {
    const input = Object.assign(new EventTarget(), {
      type: '',
      accept: '',
      files: [
        {
          name: 'gone.csv',
          size: 3,
          type: 'text/csv',
          arrayBuffer: () => Promise.reject(new Error('NotReadableError')),
        },
      ],
      click() {
        queueMicrotask(() => input.dispatchEvent(new Event('change')));
      },
    });
    vi.stubGlobal('document', { createElement: () => input });
    const picked = new WebFiles().pickFile();
    expect(await state(picked)).toBe('rejected: NotReadableError');
  });
});

describe('WebAudioPlayer.play reports a failed playback (C25)', () => {
  it('rejects with a cacheHash, as it already does without one', async () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:clip', revokeObjectURL: () => {} });
    const failure = new DOMException('blocked', 'NotAllowedError');
    const fakeAudio = {
      preload: '',
      src: '',
      muted: false,
      currentTime: 0,
      defaultPlaybackRate: 1,
      playbackRate: 1,
      play: vi.fn(() => Promise.reject(failure)),
      pause: vi.fn(),
    };
    const player = new WebAudioPlayer({
      createAudioElement: () => fakeAudio as unknown as HTMLAudioElement,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(player.play(bytes, 'audio/mpeg', 1)).rejects.toBe(failure);
    await expect(player.play(bytes, 'audio/mpeg', 1, 'a'.repeat(64))).rejects.toThrow(
      'Audio playback failed',
    );
    // playPreloaded keeps its boolean contract.
    await expect(player.playPreloaded('a'.repeat(64))).resolves.toBe(false);
  });
});
