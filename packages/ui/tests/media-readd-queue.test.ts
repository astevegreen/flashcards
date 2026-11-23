import type { MediaEntry } from '@flash/core';
import { describe, expect, it } from 'vitest';
import { createMediaReAddQueue, type MediaReAddBatch } from '../src/state/mediaReAddQueue.ts';

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
