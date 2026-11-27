import {
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  getTotalAppliedEventCount,
  type FlashEvent,
} from '@flash/core';
import { createInitialSyncCursor, runSync } from '@flash/core/sync';
import { describe, expect, it } from 'vitest';
import { memoryTransport } from './helpers/memory-transport.ts';
import { remoteWithSnapshot } from './helpers/remote-snapshot.ts';
import {
  claimLocalSnapshot,
  LOCAL_SNAPSHOT_EVERY_EVENTS,
  localSnapshotDue,
  SYNC_PULL_SNAPSHOT_EVENTS,
} from '../src/state/localSnapshotCounter.ts';
import { runSyncCycle, type SyncRunnerContext } from '../src/state/syncRunner.ts';
import type { SyncUiState } from '../src/state/useSyncController.ts';

const T0 = Date.UTC(2026, 10, 26, 9, 0, 0);
const PULLED = LOCAL_SNAPSHOT_EVERY_EVENTS + 10;

const deck = (i: number) => ({
  deck_id: `d${i}`,
  name: `d${i}`,
  note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
  language: 'ko',
  created_at: T0,
});

/** Another device has pushed `count` events and no snapshot. */
async function remoteWithEvents(count = PULLED) {
  const transport = memoryTransport();
  const fb = createEventFactory('dev-b', 0, createHlcState('dev-b', T0));
  const events = Array.from({ length: count }, (_, i) => fb.create('DeckCreated', deck(i), T0 + i));
  await runSync({
    transport,
    deviceId: 'dev-b',
    cursor: createInitialSyncCursor(),
    localOwnSeq: count,
    currentTotalEvents: count,
    snapshotThreshold: Number.MAX_SAFE_INTEGER,
    nowMs: () => T0 + count,
    getLocalEventsAfterSeq: async (after) => events.filter((e) => e.seq > after),
    buildSnapshotState: async () => {
      throw new Error('no snapshot expected');
    },
  });
  return transport;
}

/**
 * A sync runner context whose persist queue is held, as when an earlier write is still running:
 * `drain` runs the queued writes, and reports which of them failed.
 */
function heldContext(
  transport: ReturnType<typeof memoryTransport>,
  storageOverrides: Record<string, unknown> = {},
) {
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
      ...storageOverrides,
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return async () => undefined;
      },
    },
  );
  const queued: Array<() => Promise<void>> = [];
  const state = { sync: { provider: 'dropbox', status: 'syncing' } as SyncUiState };
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
    // AppProvider's handler also moves the counter; this one doesn't, so the tests see what the
    // sync runner itself does.
    onReplaceState: () => {},
    setSyncState: (next: SyncUiState | ((p: SyncUiState) => SyncUiState)) => {
      state.sync = typeof next === 'function' ? next(state.sync) : next;
    },
  } as unknown as SyncRunnerContext;
  const drain = async (): Promise<unknown[]> => {
    const failures: unknown[] = [];
    for (const task of queued.splice(0)) {
      await task().catch((err: unknown) => failures.push(err)); // NOSONAR (S9382): in order
    }
    return failures;
  };
  return { ctx, counter, snapshots, state, drain };
}

describe('the sync path moves the shared snapshot counter when it decides (R10)', () => {
  it('a local edit queued before the sync write runs takes no second snapshot', async () => {
    const { ctx, counter, snapshots, state, drain } = heldContext(await remoteWithEvents());

    await runSyncCycle(ctx, 'dropbox');
    expect(state.sync.errorMessage).toBeUndefined();
    expect(ctx.stateRef.current.decks.size).toBe(PULLED);

    // Decided, not yet written: the counter already stands at the pulled total…
    expect(counter.current).toBe(PULLED);
    // …so the next local edit (AppProvider asks the same question) isn't due.
    expect(localSnapshotDue(counter, PULLED + 1)).toBe(false);

    expect(await drain()).toEqual([]);
    expect(snapshots).toHaveLength(1);
    // 200 events past the sync's snapshot, the next edit is due again: no skip.
    expect(localSnapshotDue(counter, PULLED + LOCAL_SNAPSHOT_EVERY_EVENTS)).toBe(true);
  });

  it('a failed write gives the claim back, so the next snapshot is not 200 events late', async () => {
    const { ctx, counter, snapshots, drain } = heldContext(await remoteWithEvents(), {
      appendEvents: async () => {
        throw new Error('disk full');
      },
    });
    await runSyncCycle(ctx, 'dropbox');
    expect(counter.current).toBe(PULLED);

    const failures = await drain();
    expect(failures).toHaveLength(1);
    expect(snapshots).toHaveLength(0);
    expect(counter.current).toBe(0);
    // The next local edit is due at once.
    expect(localSnapshotDue(counter, PULLED + 1)).toBe(true);
  });

  it('a failed write leaves a snapshot decided after it alone', async () => {
    const { ctx, counter, drain } = heldContext(await remoteWithEvents(), {
      setLocalSnapshot: async () => {
        throw new Error('quota');
      },
    });
    await runSyncCycle(ctx, 'dropbox');
    // A local edit decided its own snapshot while the sync's write was queued.
    counter.current = PULLED + LOCAL_SNAPSHOT_EVERY_EVENTS;
    expect(await drain()).toHaveLength(1);
    expect(counter.current).toBe(PULLED + LOCAL_SNAPSHOT_EVERY_EVENTS);
  });

  it(`a pull of ${SYNC_PULL_SNAPSHOT_EVENTS}+ events snapshots before the counter is due, and moves it`, async () => {
    const count = SYNC_PULL_SNAPSHOT_EVENTS + 20;
    expect(count).toBeLessThan(LOCAL_SNAPSHOT_EVERY_EVENTS);
    const { ctx, counter, snapshots, drain } = heldContext(await remoteWithEvents(count));
    expect(localSnapshotDue(counter, count)).toBe(false);

    await runSyncCycle(ctx, 'dropbox');
    expect(counter.current).toBe(count);
    expect(await drain()).toEqual([]);
    expect(snapshots).toHaveLength(1);
    // The edit after it doesn't snapshot the same events again.
    expect(localSnapshotDue(counter, count + 1)).toBe(false);
  });

  it('a smaller pull leaves the counter alone when it is not due', async () => {
    const count = SYNC_PULL_SNAPSHOT_EVENTS - 1;
    const { ctx, counter, snapshots, drain } = heldContext(await remoteWithEvents(count));
    await runSyncCycle(ctx, 'dropbox');
    expect(await drain()).toEqual([]);
    expect(snapshots).toHaveLength(0);
    expect(counter.current).toBe(0);
  });

  it('hydrating a snapshot moves the counter when it decides, and its write never moves it back', async () => {
    const { ctx, counter, snapshots, drain } = heldContext(await remoteWithSnapshot(T0, deck(0)));
    let hydratedTotal = -1;
    ctx.onReplaceState = (next) => {
      hydratedTotal = getTotalAppliedEventCount(next);
    };

    await runSyncCycle(ctx, 'dropbox');
    expect(hydratedTotal).toBe(1);
    expect(counter.current).toBe(hydratedTotal);

    // A local edit queued behind the hydrate write decides its own snapshot…
    counter.current = hydratedTotal + LOCAL_SNAPSHOT_EVERY_EVENTS;
    expect(await drain()).toEqual([]);
    expect(snapshots).toHaveLength(1);
    // …and the hydrate write leaves that alone, so the edit after it isn't due a second one.
    expect(counter.current).toBe(hydratedTotal + LOCAL_SNAPSHOT_EVERY_EVENTS);
    expect(localSnapshotDue(counter, hydratedTotal + LOCAL_SNAPSHOT_EVERY_EVENTS + 1)).toBe(false);
  });
});

describe("the platform's snapshot caps reach the sync engine", () => {
  it('a platform with a smaller cap skips a remote snapshot past it and replays segments', async () => {
    const remote = await remoteWithSnapshot(T0, deck(0));
    const capped = heldContext(remote);
    // Far below the one-deck snapshot, as a phone's 25 MiB cap is below a 20k-card one.
    (capped.ctx.platform as { syncSnapshotLimits?: object }).syncSnapshotLimits = {
      maxUncompressedBytes: 64,
    };
    let replaced = false;
    capped.ctx.onReplaceState = () => {
      replaced = true;
    };
    await runSyncCycle(capped.ctx, 'dropbox');
    expect(capped.state.sync.errorMessage).toBeUndefined();
    expect(replaced).toBe(false);
    expect(capped.ctx.stateRef.current.decks.size).toBe(1);

    // Without the cap the same store hydrates the snapshot.
    const uncapped = heldContext(remote);
    let hydrated = false;
    uncapped.ctx.onReplaceState = () => {
      hydrated = true;
    };
    await runSyncCycle(uncapped.ctx, 'dropbox');
    expect(hydrated).toBe(true);
  });
});

describe('claimLocalSnapshot', () => {
  it('gives the claim back only while nothing else moved the counter', () => {
    const counter = { current: 10 };
    const release = claimLocalSnapshot(counter, 300);
    expect(counter.current).toBe(300);
    release();
    expect(counter.current).toBe(10);

    const late = claimLocalSnapshot(counter, 300);
    counter.current = 520;
    late();
    expect(counter.current).toBe(520);
  });
});
