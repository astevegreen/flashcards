import { createEventFactory, createHlcState, type KnownEvent } from '@flash/core';
import type { DeviceMeta, PlatformServices } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import { localEditWriter } from '../src/state/localEditWrite.ts';
import { createPersistQueue } from '../src/state/persistQueue.ts';

/** A storage whose `appendEvents` rejects while `full` is set (an IndexedDB quota error). */
function fakeStorage() {
  const log: string[] = [];
  const state = { full: true };
  const storage = {
    appendEvents: async (events: readonly KnownEvent[]) => {
      if (state.full) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      log.push(`events:${events.map((e) => e.id).join(',')}`);
    },
    upsertMaterializedCards: async (rows: readonly { id: string }[]) =>
      void log.push(`cards:${rows.map((r) => r.id).join(',')}`),
    deleteMaterializedCards: async (ids: readonly string[]) =>
      void log.push(`removed:${ids.join(',')}`),
    setDeviceMeta: async (meta: DeviceMeta) => void log.push(`meta:${meta.seq}`),
  };
  return { log, state, storage: storage as unknown as PlatformServices['storage'] };
}

describe('emitEvents write with a failed persist (§9 UI state)', () => {
  it('keeps the failed write, reports it, and saves everything in order on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const factory = createEventFactory('dev', 0, createHlcState('dev', 0));
    const events = [
      factory.create(
        'DeckCreated',
        { deck_id: 'd', name: 'D', note_type_id: 't', language: 'ko', created_at: 0 },
        0,
      ),
    ] as KnownEvent[];
    const meta = { deviceId: 'dev', seq: factory.getSeq(), hlc: factory.getHlc() } as DeviceMeta;
    const { log, state, storage } = fakeStorage();
    const failures: unknown[] = [];
    const queue = createPersistQueue((err) => failures.push(err));

    await queue.enqueue(
      localEditWriter(storage, 0, {
        events,
        changedRows: [{ id: 'c1' } as never],
        removedIds: ['c0'],
        meta,
      }),
    );
    // The events are not saved, nothing after them ran, and the app hears about it once.
    expect(failures).toHaveLength(1);
    expect(log).toEqual([]);
    await expect(queue.whenSaved()).rejects.toThrow('1 change(s) could not be saved.');

    // A later edit is not blocked by the failed one.
    state.full = false;
    await queue.enqueue(
      localEditWriter(storage, 0, { events: [], changedRows: [], removedIds: [], meta }),
    );
    expect(log).toEqual(['events:', `meta:${meta.seq}`]);

    // Retry writes the kept edit in full, events first.
    log.length = 0;
    await queue.retryFailed();
    expect(log).toEqual([`events:${events[0]?.id}`, 'cards:c1', 'removed:c0', `meta:${meta.seq}`]);
    await expect(queue.whenSaved()).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
