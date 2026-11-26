import 'fake-indexeddb/auto';
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
const realHandoff = () => import('../src/writer-handoff.ts');

function openTab(locks: WriterLocks, name: string, load: () => Promise<HandoffModule>) {
  const { win, reload } = fakeWindow();
  const storage = { close: vi.fn() };
  let onUse: (() => void) | undefined;
  const ready = holdWriter({
    locks,
    name,
    storage,
    win,
    load,
    showWaiting: (use) => {
      onUse = use;
    },
    whenSaved: async () => undefined,
  });
  let holds = false;
  void ready.then(() => {
    holds = true;
  });
  return {
    reload,
    storage,
    holds: () => holds,
    waiting: () => onUse !== undefined,
    useHere: () => onUse?.(),
  };
}

function ask(name: string): void {
  const channel = new BroadcastChannel(`${name}:writer`);
  const take: WriterMessage = { take: 'other tab' };
  channel.postMessage(take);
  channel.close();
}

describe('holdWriter', () => {
  it('a handoff whose chunk fails to load still stops writing, releases and reloads', async () => {
    const { locks } = fakeLocks();
    const name = freshName();
    const writer = openTab(locks, name, () => Promise.reject(new Error('chunk gone')));
    await vi.waitFor(() => expect(writer.holds()).toBe(true));

    ask(name);

    await vi.waitFor(() => expect(writer.reload).toHaveBeenCalledTimes(1));
    expect(writer.storage.close).toHaveBeenCalled();
    expect(await holdWriterLock(locks, name, waitUpTo(500), vi.fn())).not.toBeNull();
  });

  it('a stolen lock stops writing at once and reloads, without loading any chunk', async () => {
    const { locks } = fakeLocks();
    const name = freshName();
    const load = vi.fn(() => Promise.reject(new Error('chunk gone')));
    const writer = openTab(locks, name, load);
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
    const waiting = openTab(locks, name, realHandoff);
    await vi.waitFor(() => expect(waiting.waiting()).toBe(true));
    expect(waiting.holds()).toBe(false);

    release?.(); // the writer tab closes

    await vi.waitFor(() => expect(waiting.holds()).toBe(true));
    expect(stats.steals).toBe(0);
  });

  it('"Use here instead" hands over; the new writer never hands the lock to itself', async () => {
    const { locks, stats } = fakeLocks();
    const name = freshName();
    const first = openTab(locks, name, realHandoff);
    await vi.waitFor(() => expect(first.holds()).toBe(true));
    const second = openTab(locks, name, realHandoff);
    await vi.waitFor(() => expect(second.waiting()).toBe(true));

    second.useHere();

    await vi.waitFor(() => expect(second.holds()).toBe(true));
    expect(first.reload).toHaveBeenCalledTimes(1);
    // Its own requests, still in flight when it won, are ignored.
    await new Promise((r) => setTimeout(r, 1200));
    expect(second.reload).not.toHaveBeenCalled();
    expect(stats.steals).toBe(0);
  });

  it('two waiting tabs both asking: the lock moves on, and no live writer is stolen from', async () => {
    const { locks, stats } = fakeLocks();
    const name = freshName();
    const first = openTab(locks, name, realHandoff);
    await vi.waitFor(() => expect(first.holds()).toBe(true));
    const second = openTab(locks, name, realHandoff);
    const third = openTab(locks, name, realHandoff);
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
