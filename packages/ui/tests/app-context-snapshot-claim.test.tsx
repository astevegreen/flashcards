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
  it.each([
    ['appendEvents then setDeviceMeta', false],
    ['appendEventsWithMeta (one transaction)', true],
  ])('lets the next edit take the snapshot after a failed %s', async (_path, withMeta) => {
    const storage = createMemoryStorage();
    if (withMeta) {
      const appendedWithMeta: unknown[] = [];
      storage.appendEventsWithMeta = async (events) => {
        if (storage.failAppend) throw storage.failAppend;
        appendedWithMeta.push(events);
      };
      storage.appendEvents = () => Promise.reject(new Error('the one-transaction path is used'));
    }
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

    // Due: the first time, this edit may only load the snapshot code; the next one snapshots.
    await emit(LOCAL_SNAPSHOT_EVERY_EVENTS);
    await emit(1);
    expect(saved.length).toBeGreaterThan(0);
    const before = saved.length;

    // Due again, and its write fails: no snapshot is saved.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    storage.failAppend = new Error('QuotaExceededError');
    await emit(LOCAL_SNAPSHOT_EVERY_EVENTS);
    expect(m.app().persistFailed).toBe(true);
    expect(saved).toHaveLength(before);

    // The claim came back, so the very next edit takes it.
    storage.failAppend = undefined;
    await emit(1);
    expect(saved).toHaveLength(before + 1);
  });
});
