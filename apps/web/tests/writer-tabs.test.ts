import 'fake-indexeddb/auto';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  holdWriter,
  holdWriterLock,
  waitUpTo,
  type HandoffModule,
  type WriterLocks,
  type WriterMessage,
} from '../src/writer-lock.ts';
import { fakeLocks } from './helpers/fake-locks.ts';
import { fakeWindow } from './helpers/fake-window.ts';

/** Tabs of one browser profile, in one process: shared locks, real BroadcastChannels. */

let count = 0;
const freshName = () => `flashcards-db-tabs${++count}`;
const realChunk = () => import('../src/other-tab.tsx');
const chunkGone = () => Promise.reject(new Error('chunk gone'));

interface TabOptions {
  load?: () => Promise<HandoffModule>;
  whenSaved?: () => Promise<void>;
}

function openTab(locks: WriterLocks, name: string, options: TabOptions = {}) {
  const { win, reload } = fakeWindow();
  const storage = { close: vi.fn() };
  const events: string[] = [];
  let onUse: (() => void) | undefined;
  const ready = holdWriter({
    locks,
    name,
    storage,
    win,
    load: options.load ?? realChunk,
    render: (node) => {
      events.push('render');
      onUse = (node as ReactElement<{ onUse: () => void }>).props.onUse;
    },
    whenSaved: options.whenSaved ?? (async () => undefined),
  });
  let holds = false;
  void ready.then(() => {
    holds = true;
    events.push('held');
  });
  return {
    reload,
    storage,
    events,
    holds: () => holds,
    waiting: () => onUse !== undefined,
    useHere: () => onUse?.(),
  };
}

/** Another tab asking for the lock; returns the writer's answers seen so far. */
function ask(name: string): { answers: () => number; close: () => void } {
  const channel = new BroadcastChannel(`${name}:writer`);
  let answers = 0;
  channel.onmessage = (e: MessageEvent<WriterMessage>) => {
    if ('yielding' in e.data) answers++;
  };
  const take: WriterMessage = { take: 'other tab' };
  channel.postMessage(take);
  return { answers: () => answers, close: () => channel.close() };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('holdWriter', () => {
  it('answers "yielding" at once, before the handoff chunk has loaded', async () => {
    const { locks } = fakeLocks();
    const name = freshName();
    const writer = openTab(locks, name, { load: () => new Promise<never>(() => undefined) });
    await vi.waitFor(() => expect(writer.holds()).toBe(true));

    const asking = ask(name);
    try {
      await vi.waitFor(() => expect(asking.answers()).toBeGreaterThan(0), { timeout: 200 });
      // ...and keeps answering, so the asking tab doesn't steal while the chunk loads.
      await vi.waitFor(() => expect(asking.answers()).toBeGreaterThan(1), { timeout: 1500 });
    } finally {
      asking.close();
    }
  });

  it('answers every repeated request, even when its timers are throttled (a hidden tab)', async () => {
    const { locks } = fakeLocks();
    const name = freshName();
    const writer = openTab(locks, name, { load: () => new Promise<never>(() => undefined) });
    await vi.waitFor(() => expect(writer.holds()).toBe(true));
    // The writer's 500 ms answer timer never fires from here on.
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const channel = new BroadcastChannel(`${name}:writer`);
    let answers = 0;
    channel.onmessage = (e: MessageEvent<WriterMessage>) => {
      if ('yielding' in e.data) answers++;
    };
    const take: WriterMessage = { take: 'other tab' };
    try {
      for (let i = 1; i <= 3; i++) {
        channel.postMessage(take);
        await vi.waitFor(() => expect(answers).toBe(i), { timeout: 500 });
      }
      await tick(100);
      expect(answers).toBe(3);
    } finally {
      vi.useRealTimers();
      channel.close();
    }
  });

  it('a handoff whose chunk fails to load saves queued writes, then stops and releases', async () => {
    const { locks } = fakeLocks();
    const name = freshName();
    let saveQueued: () => void = () => undefined;
    const queuedWrite = new Promise<void>((r) => {
      saveQueued = r;
    });
    const writer = openTab(locks, name, { load: chunkGone, whenSaved: () => queuedWrite });
    await vi.waitFor(() => expect(writer.holds()).toBe(true));

    ask(name).close();
    await tick(100);
    // The rating already on screen is still being saved: nothing stopped yet.
    expect(writer.reload).not.toHaveBeenCalled();
    expect(writer.storage.close).not.toHaveBeenCalled();

    saveQueued();

    await vi.waitFor(() => expect(writer.reload).toHaveBeenCalledTimes(1));
    expect(writer.storage.close).toHaveBeenCalled();
    expect(await holdWriterLock(locks, name, waitUpTo(500), vi.fn())).not.toBeNull();
  });

  it('a stolen lock stops writing at once and reloads, without loading any chunk', async () => {
    const { locks } = fakeLocks();
    const name = freshName();
    const load = vi.fn(chunkGone);
    const writer = openTab(locks, name, { load });
    await vi.waitFor(() => expect(writer.holds()).toBe(true));

    await holdWriterLock(locks, name, { steal: true }, vi.fn());

    await vi.waitFor(() => expect(writer.reload).toHaveBeenCalledTimes(1));
    expect(writer.storage.close).toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('a waiting tab takes over by itself when the writer closes', async () => {
    const { locks, stats } = fakeLocks();
    const name = freshName();
    const release = await holdWriterLock(locks, name, waitUpTo(10), vi.fn());
    const waiting = openTab(locks, name);
    await vi.waitFor(() => expect(waiting.waiting()).toBe(true));
    expect(waiting.holds()).toBe(false);

    release?.(); // the writer tab closes

    await vi.waitFor(() => expect(waiting.holds()).toBe(true));
    expect(stats.steals).toBe(0);
  });

  it('never renders the waiting screen once the lock is held', async () => {
    const { locks } = fakeLocks();
    const name = freshName();
    const release = await holdWriterLock(locks, name, waitUpTo(10), vi.fn());
    // The writer closes while this tab's screen chunk is still loading.
    let finishLoading: () => void = () => undefined;
    const loading = new Promise<void>((r) => {
      finishLoading = r;
    });
    const waiting = openTab(locks, name, { load: () => loading.then(realChunk) });
    await tick(600); // past the first 500 ms try
    release?.();
    finishLoading();

    await vi.waitFor(() => expect(waiting.holds()).toBe(true));
    await tick(50);
    expect(waiting.events).toEqual(['render', 'held']);
  });

  it('without the screen chunk, a waiting tab still takes over when the writer closes', async () => {
    const { locks, stats } = fakeLocks();
    const name = freshName();
    const release = await holdWriterLock(locks, name, waitUpTo(10), vi.fn());
    const waiting = openTab(locks, name, { load: chunkGone });
    await tick(600);
    expect(waiting.holds()).toBe(false);

    release?.();

    await vi.waitFor(() => expect(waiting.holds()).toBe(true));
    expect(waiting.events).toEqual(['held']);
    expect(stats.steals).toBe(0);
  });

  it('"Use here instead" hands over; the new writer never hands the lock to itself', async () => {
    const { locks, stats } = fakeLocks();
    const name = freshName();
    const first = openTab(locks, name);
    await vi.waitFor(() => expect(first.holds()).toBe(true));
    const second = openTab(locks, name);
    await vi.waitFor(() => expect(second.waiting()).toBe(true));

    second.useHere();

    await vi.waitFor(() => expect(second.holds()).toBe(true));
    expect(first.reload).toHaveBeenCalledTimes(1);
    // Its own requests, still in flight when it won, are ignored.
    await tick(1200);
    expect(second.reload).not.toHaveBeenCalled();
    expect(stats.steals).toBe(0);
  });

  it('two waiting tabs both asking: the lock moves on, and no live writer is stolen from', async () => {
    const { locks, stats } = fakeLocks();
    const name = freshName();
    const first = openTab(locks, name);
    await vi.waitFor(() => expect(first.holds()).toBe(true));
    const second = openTab(locks, name);
    const third = openTab(locks, name);
    await vi.waitFor(() => expect(second.waiting() && third.waiting()).toBe(true));

    second.useHere();
    third.useHere();

    // The second tab's waiting request was first in line; it takes over, hears the third tab's
    // repeated request and hands over again.
    await vi.waitFor(() => expect(third.holds()).toBe(true), { timeout: 4000 });
    expect(first.reload).toHaveBeenCalledTimes(1);
    expect(second.reload).toHaveBeenCalledTimes(1);
    expect(stats.steals).toBe(0);
  });
});
