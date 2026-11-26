import {
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type FlashEvent,
} from '@flash/core';
import { createInitialSyncCursor, runSync } from '@flash/core/sync';
import { describe, expect, it } from 'vitest';
import { memoryTransport } from './helpers/memory-transport.ts';
import {
  LOCAL_SNAPSHOT_EVERY_EVENTS,
  localSnapshotDue,
} from '../src/state/localSnapshotCounter.ts';
import { runSyncCycle, type SyncRunnerContext } from '../src/state/syncRunner.ts';
import type { SyncUiState } from '../src/state/useSyncController.ts';

const T0 = Date.UTC(2026, 10, 26, 9, 0, 0);
const PULLED = LOCAL_SNAPSHOT_EVERY_EVENTS + 10;

/** Another device has pushed `PULLED` events and no snapshot. */
async function remoteWithEvents() {
  const transport = memoryTransport();
  const fb = createEventFactory('dev-b', 0, createHlcState('dev-b', T0));
  const events = Array.from({ length: PULLED }, (_, i) =>
    fb.create(
      'DeckCreated',
      {
        deck_id: `d${i}`,
        name: `d${i}`,
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: T0,
      },
      T0 + i,
    ),
  );
  await runSync({
    transport,
    deviceId: 'dev-b',
    cursor: createInitialSyncCursor(),
    localOwnSeq: PULLED,
    currentTotalEvents: PULLED,
    snapshotThreshold: Number.MAX_SAFE_INTEGER,
    nowMs: () => T0 + PULLED,
    getLocalEventsAfterSeq: async (after) => events.filter((e) => e.seq > after),
    buildSnapshotState: async () => {
      throw new Error('no snapshot expected');
    },
  });
  return transport;
}

describe('the sync path moves the shared snapshot counter when it decides (R10)', () => {
  it('a local edit queued before the sync write runs takes no second snapshot', async () => {
    const transport = await remoteWithEvents();
    const ref = <T>(current: T) => ({ current });
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0 + 1_000));
    const snapshots: unknown[] = [];
    const storage = new Proxy(
      {
        getKv: async () => undefined,
        getSyncCursor: async () => undefined,
        getMaxLocalSeq: async () => 0,
        getDeviceEventsAfterSeq: async () => [] as FlashEvent[],
        setLocalSnapshot: async (s: unknown) => void snapshots.push(s),
      } as Record<string, unknown>,
      {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          return async () => undefined;
        },
      },
    );
    // The persist queue is held, as when an earlier write is still running.
    const queued: Array<() => Promise<void>> = [];
    let syncState = { provider: 'dropbox', status: 'syncing' } as SyncUiState;
    const counter = ref(0);
    const ctx = {
      platform: { storage, createDropboxTransport: async () => transport },
      stateRef: ref(createEmptyState()),
      metaRef: ref({ deviceId: 'dev-a', seq: 0, hlc: factory.getHlc() }),
      factoryRef: ref(factory),
      configRef: ref({ provider: 'dropbox' }),
      cursorRef: ref(undefined),
      localFolderTransportRef: ref(null),
      workerRef: ref(null),
      workerHydratedRef: ref(false),
      workerTrackingLocalRef: ref(false),
      pendingWorkerLocalEventsRef: ref([]),
      reviewsSinceSyncRef: ref(0),
      lastLocalSnapshotCountRef: counter,
      lastSyncCompletedAtRef: ref(0),
      collectionChoiceEpochRef: ref(0),
      enqueuePersist: async (task: () => Promise<void>) => void queued.push(task),
      onStateMutated: () => {},
      onReplaceState: () => {},
      setSyncState: (next: SyncUiState | ((p: SyncUiState) => SyncUiState)) => {
        syncState = typeof next === 'function' ? next(syncState) : next;
      },
    } as unknown as SyncRunnerContext;

    await runSyncCycle(ctx, 'dropbox');
    expect(syncState.errorMessage).toBeUndefined();
    expect(ctx.stateRef.current.decks.size).toBe(PULLED);

    // Decided, not yet written: the counter already stands at the pulled total…
    expect(counter.current).toBe(PULLED);
    // …so the next local edit (AppProvider asks the same question) isn't due.
    expect(localSnapshotDue(counter, PULLED + 1)).toBe(false);

    for (const task of queued) await task();
    expect(snapshots).toHaveLength(1);
    // 200 events past the sync's snapshot, the next edit is due again: no skip.
    expect(localSnapshotDue(counter, PULLED + LOCAL_SNAPSHOT_EVERY_EVENTS)).toBe(true);
  });
});
