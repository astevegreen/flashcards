// @vitest-environment happy-dom
import { BUILTIN_NOTE_TYPE_IDS } from '@flash/core';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_SNAPSHOT_EVERY_EVENTS } from '../src/state/localSnapshotCounter.ts';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  type Mounted,
} from './helpers/app-harness.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

describe('a local edit whose snapshot write fails gives the counter back (R10)', () => {
  it('lets the next edit take the snapshot instead of waiting another 200 events', async () => {
    const storage = createMemoryStorage();
    const saved: unknown[] = [];
    storage.setLocalSnapshot = async (s) => {
      saved.push(s);
    };
    mounted = await mountWithApp(null, { platform: createTestPlatform(storage) });
    const m = mounted;
    let n = 0;
    const emit = async (count: number) => {
      const f = m.app().getEventFactory();
      const events = Array.from({ length: count }, () => {
        n += 1;
        return f.create(
          'DeckCreated',
          {
            deck_id: `d${n}`,
            name: `d${n}`,
            note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
            language: 'ko',
          },
          1_000 + n,
        );
      });
      await act(async () => m.app().emitEvents(events));
      await flush();
    };

    // Due, but the snapshot code is not loaded yet: this edit only loads it.
    await emit(LOCAL_SNAPSHOT_EVERY_EVENTS);
    expect(saved).toHaveLength(0);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    storage.failAppend = new Error('QuotaExceededError');
    await emit(1);
    expect(m.app().persistFailed).toBe(true);
    expect(saved).toHaveLength(0);

    storage.failAppend = undefined;
    await emit(1);
    expect(saved).toHaveLength(1);
  });
});
