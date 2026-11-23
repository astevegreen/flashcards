import type { MediaEntry } from '@flash/core';
import { describe, expect, it } from 'vitest';
import {
  createMediaReAddQueue,
  MEDIA_RE_ADD_TRIES,
  type MediaReAddBatch,
} from '../src/state/mediaReAddQueue.ts';

const entry = (c: string): MediaEntry => ({
  hash: c.repeat(64),
  ext: 'png',
  mime: 'image/png',
  size: 3,
});
const batch = (): MediaReAddBatch => ({ prior: { notes: [] } as never, events: [] });

describe('media re-add queue', () => {
  it('keeps a batch whose chunk failed to load and retries it on the next flush', async () => {
    let loads = 0;
    const emitted: MediaEntry[][] = [];
    const queue = createMediaReAddQueue(
      () => {
        loads += 1;
        if (loads === 1)
          return Promise.reject(new Error('Failed to fetch dynamically imported module'));
        return Promise.resolve(() => Promise.resolve([entry('a')]));
      },
      (entries) => emitted.push(entries),
    );
    queue.add(batch());
    await queue.flush();
    expect(emitted).toEqual([]);
    // The next edit (or sync) flushes again: the first batch is not lost.
    queue.add(batch());
    await queue.flush();
    expect(loads).toBe(2);
    expect(emitted).toEqual([[entry('a')]]); // one re-add per file, across both batches
    await queue.flush();
    expect(loads).toBe(2); // nothing left to do
  });

  it('retries only the batch that failed, and drops it after a few tries', async () => {
    const bad = batch();
    const emitted: MediaEntry[][] = [];
    let badTries = 0;
    const queue = createMediaReAddQueue(
      () =>
        Promise.resolve((b: MediaReAddBatch) => {
          if (b === bad) {
            badTries += 1;
            return Promise.reject(new Error('getMedia failed'));
          }
          return Promise.resolve([entry('b')]);
        }),
      (entries) => emitted.push(entries),
    );
    queue.add(bad);
    queue.add(batch());
    await queue.flush();
    // The good batch is not held back by the bad one.
    expect(emitted).toEqual([[entry('b')]]);
    for (let i = 0; i < 5; i++) {
      queue.add(batch());
      await queue.flush();
    }
    expect(badTries).toBe(MEDIA_RE_ADD_TRIES); // then left to Check media's "Add back"
    expect(emitted).toHaveLength(6);
  });

  it('a flush waits for the one still running', async () => {
    let release = (): void => undefined;
    const emitted: MediaEntry[][] = [];
    const queue = createMediaReAddQueue(
      () =>
        new Promise((resolve) => {
          release = () => resolve(() => Promise.resolve([entry('c')]));
        }),
      (entries) => emitted.push(entries),
    );
    queue.add(batch());
    const first = queue.flush();
    const second = queue.flush(); // what whenSaved() awaits
    await new Promise((resolve) => setTimeout(resolve, 0)); // the load has started
    release();
    await second;
    expect(emitted).toEqual([[entry('c')]]);
    await first;
  });

  it('emits nothing when no file needs re-adding', async () => {
    const emitted: MediaEntry[][] = [];
    const queue = createMediaReAddQueue(
      () => Promise.resolve(() => Promise.resolve([])),
      (entries) => emitted.push(entries),
    );
    queue.add(batch());
    await queue.flush();
    expect(emitted).toEqual([]);
  });
});
