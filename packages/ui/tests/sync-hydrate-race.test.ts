import {
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type CollectionState,
  type FlashEvent,
} from '@flash/core';
import { snapshotsPrefix } from '@flash/core/sync';
import { describe, expect, it } from 'vitest';
import { remoteWithSnapshot } from './helpers/remote-snapshot.ts';
import { runSyncCycle, type SyncRunnerContext } from '../src/state/syncRunner.ts';
import type { SyncUiState } from '../src/state/useSyncController.ts';

const T0 = Date.UTC(2026, 10, 25, 9, 0, 0);

const deck = (deck_id: string) => ({
  deck_id,
  name: deck_id,
  note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
  language: 'ko',
  created_at: T0,
});

describe('a sync hydrating a snapshot keeps local ratings made while it ran (D20)', () => {
  it('replays an event made while the concurrent-local read was in flight', async () => {
    const transport = await remoteWithSnapshot(T0, deck('d-remote'));
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', T0 + 50));
    const stored: FlashEvent[] = [];
    const ref = <T>(current: T) => ({ current });
    const metaRef = ref({ deviceId: 'dev-a', seq: 0, hlc: factory.getHlc() });
    /** What emitEvents does: bump the meta seq now, persist the event through the queue. */
    const emitLocal = (deckId: string) => {
      const ev = factory.create('DeckCreated', deck(deckId), T0 + 100 + stored.length);
      metaRef.current = { ...metaRef.current, seq: factory.getSeq(), hlc: factory.getHlc() };
      stored.push(ev);
    };

    // The user creates d1 while the snapshot downloads…
    transport.onRead = (path) => {
      if (path.startsWith(snapshotsPrefix()) && stored.length === 0) emitLocal('d1');
    };
    let reads = 0;
    const storage = new Proxy(
      {
        getKv: async () => undefined,
        getSyncCursor: async () => undefined,
        getMaxLocalSeq: async () => stored.length,
        getDeviceEventsAfterSeq: async (_device: string, after: number) => {
          const result = stored.filter((e) => e.seq > after);
          // …and d2 while the sync, its push done (read 1), reads d1 back from storage to replay it
          // over the snapshot (read 2): d2's write lands after that read.
          if (++reads === 2) emitLocal('d2');
          return result;
        },
      } as Record<string, unknown>,
      {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          return async () => undefined;
        },
      },
    );

    let replaced: CollectionState | undefined;
    let syncState = { provider: 'dropbox', status: 'syncing' } as SyncUiState;
    const ctx = {
      platform: { storage, createDropboxTransport: async () => transport },
      stateRef: ref(createEmptyState()),
      metaRef,
      factoryRef: ref(factory),
      configRef: ref({ provider: 'dropbox' }),
      cursorRef: ref(undefined),
      localFolderTransportRef: ref(null),
      workerRef: ref(null),
      workerHydratedRef: ref(false),
      workerTrackingLocalRef: ref(false),
      pendingWorkerLocalEventsRef: ref([]),
      reviewsSinceSyncRef: ref(0),
      lastLocalSnapshotCountRef: ref(0),
      lastSyncCompletedAtRef: ref(0),
      collectionChoiceEpochRef: ref(0),
      enqueuePersist: async (task: () => Promise<void>) => task(),
      onStateMutated: () => {},
      onReplaceState: (next: CollectionState, meta: typeof metaRef.current) => {
        replaced = next;
        metaRef.current = meta;
      },
      setSyncState: (next: SyncUiState | ((p: SyncUiState) => SyncUiState)) => {
        syncState = typeof next === 'function' ? next(syncState) : next;
      },
    } as unknown as SyncRunnerContext;

    await runSyncCycle(ctx, 'dropbox');

    expect(syncState.errorMessage).toBeUndefined();
    expect(stored.map((e) => e.seq)).toEqual([1, 2]);
    expect([...(replaced?.decks.keys() ?? [])].sort()).toEqual(['d-remote', 'd1', 'd2']);
    expect(metaRef.current.seq).toBe(2);
  });
});
