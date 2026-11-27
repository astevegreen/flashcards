// @vitest-environment happy-dom
import type { FlashEvent } from '@flash/core';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryStorage,
  createTestPlatform,
  mountWithApp,
  must,
  newCard,
  sampleEvents,
  type Mounted,
} from './helpers/app-harness.tsx';

/**
 * Stands in for the web shell's handoff (`apps/web/src/writer-handoff.ts`, tested there): it saves
 * the app's queued writes, then releases the lock. This checks the app's side of it.
 */
async function handOver(release: () => void, whenSaved: () => Promise<void>): Promise<void> {
  await whenSaved().catch(() => undefined);
  release();
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('writer-lock handoff and the persist queue (owner: "Save them first")', () => {
  it('a handoff waits for a rating still being saved before it releases the lock', async () => {
    const storage = createMemoryStorage();
    const append = storage.appendEvents.bind(storage);
    let holdBack = false;
    let finishWrite: () => void = () => undefined;
    const writeHeld = new Promise<void>((r) => {
      finishWrite = r;
    });
    storage.appendEvents = async (events: readonly FlashEvent[]) => {
      if (holdBack) await writeHeld;
      await append(events);
    };
    const exposeWhenSaved = vi.fn();
    mounted = await mountWithApp(null, {
      platform: createTestPlatform(storage),
      initialEvents: sampleEvents(),
      exposeWhenSaved,
    });
    const m = mounted;
    // The app hands its persist queue to the web shell.
    expect(exposeWhenSaved).toHaveBeenCalledWith(expect.any(Function));
    const whenSaved = must(exposeWhenSaved.mock.lastCall)[0] as () => Promise<void>;

    holdBack = true;
    act(() => {
      void m.app().rateCard(newCard(m), 3, 1000);
    });

    const release = vi.fn();
    const handoff = handOver(release, whenSaved);
    await new Promise((r) => setTimeout(r, 50));
    // The rating is shown but not yet stored: the lock stays.
    expect(release).not.toHaveBeenCalled();
    expect(storage.appended.flat().some((e) => e.type === 'ReviewRecorded')).toBe(false);

    finishWrite();
    await handoff;

    expect(release).toHaveBeenCalledTimes(1);
    expect(storage.appended.flat().some((e) => e.type === 'ReviewRecorded')).toBe(true);
  });
});
