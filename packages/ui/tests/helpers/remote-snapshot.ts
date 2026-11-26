import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  getTotalAppliedEventCount,
  serializeCollectionState,
  type DeckCreatedPayload,
} from '@flash/core';
import { createInitialSyncCursor, runSync, snapshotsPrefix } from '@flash/core/sync';
import { expect } from 'vitest';
import { memoryTransport } from './memory-transport.ts';

/** Another device (`dev-b`) has synced a snapshot holding one deck, created at `t0`. */
export async function remoteWithSnapshot(t0: number, deck: DeckCreatedPayload) {
  const transport = memoryTransport();
  const fb = createEventFactory('dev-b', 0, createHlcState('dev-b', t0));
  const events = [fb.create('DeckCreated', deck, t0)];
  const stateB = applyEvents(createEmptyState(), events);
  await runSync({
    transport,
    deviceId: 'dev-b',
    cursor: createInitialSyncCursor(),
    localOwnSeq: 1,
    currentTotalEvents: 1,
    snapshotThreshold: 1,
    nowMs: () => t0 + 10,
    getLocalEventsAfterSeq: (after) => Promise.resolve(events.filter((e) => e.seq > after)),
    buildSnapshotState: () =>
      Promise.resolve({
        state: serializeCollectionState(stateB, { 'dev-b': 1 }),
        totalEvents: getTotalAppliedEventCount(stateB),
        watermarks: { 'dev-b': 1 },
      }),
  });
  expect([...transport.files.keys()].some((p) => p.startsWith(snapshotsPrefix()))).toBe(true);
  return transport;
}
