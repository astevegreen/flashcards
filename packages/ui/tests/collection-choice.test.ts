import {
  createEmptyState,
  createEventFactory,
  createHlcState,
  SyncTransportError,
  type FlashEvent,
} from '@flash/core';
import { encodeManifest, manifestPath } from '@flash/core/sync';
import { describe, expect, it } from 'vitest';
import { answerCollectionChoice } from '../src/state/collectionChoice.ts';
import { COLLECTION_REBUILT_KV_KEY } from '../src/state/rebuildSignal.ts';
import { saveAddDeviceExpectation } from '../src/sync/addDeviceExpectation.ts';
import {
  disconnectActiveSync,
  runSyncCycle,
  type SyncRunnerContext,
} from '../src/state/syncRunner.ts';
import type { SyncUiState } from '../src/state/useSyncController.ts';

const EXPECTED = 'col-11111111-1111-4111-8111-111111111111';
const REMOTE = 'col-22222222-2222-4222-8222-222222222222';

function memoryTransport() {
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  return {
    files,
    writes,
    async list(prefix: string) {
      return [...files.entries()]
        .filter(([p]) => p.startsWith(prefix))
        .map(([path, d]) => ({ path, size: d.byteLength, updatedAt: 1 }));
    },
    async read(path: string) {
      const d = files.get(path);
      if (!d) throw new SyncTransportError('NOT_FOUND', path);
      return d;
    },
    async write(path: string, data: Uint8Array) {
      writes.push(path);
      files.set(path, data);
    },
    async delete(path: string) {
      files.delete(path);
    },
  };
}

function setup(localEvents: FlashEvent[] = []) {
  const kv = new Map<string, unknown>();
  const calls: string[] = [];
  const storage = new Proxy(
    {
      getKv: async (k: string) => kv.get(k),
      setKv: async (k: string, v: unknown) => void kv.set(k, v),
      deleteKv: async (k: string) => void kv.delete(k),
      getSyncCursor: async () => undefined,
      getDeviceEventsAfterSeq: async () => localEvents,
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return async (...args: unknown[]) => {
          calls.push(prop);
          void args;
          return undefined;
        };
      },
    },
  );
  const transport = memoryTransport();
  transport.files.set(
    manifestPath(),
    encodeManifest({
      collection_id: REMOTE,
      format_version: 1,
      min_app_version: '0.0.1',
      created_at: 1,
    }),
  );
  const platform = {
    storage,
    createDropboxTransport: async () => transport,
    getDropboxAuth: async () => ({ signOut: async () => {} }),
  };
  let syncState = {
    provider: 'dropbox',
    status: 'syncing',
    isOnline: true,
    readOnly: false,
    pendingCount: 0,
    lastPulledCount: 0,
    lastPushedCount: 0,
  } as SyncUiState;
  const ref = <T>(current: T) => ({ current });
  const ctx = {
    platform,
    stateRef: ref(createEmptyState()),
    metaRef: ref({
      deviceId: 'dev-a',
      seq: localEvents.length,
      hlc: { wall: 0, counter: 0, device: 'dev-a' },
    }),
    factoryRef: ref({ setSeq() {}, setHlc() {} }),
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
    onReplaceState: () => {},
    setSyncState: (next: SyncUiState | ((p: SyncUiState) => SyncUiState)) => {
      syncState = typeof next === 'function' ? next(syncState) : next;
    },
  } as unknown as SyncRunnerContext;
  return { ctx, calls, transport, storage, state: () => syncState };
}

describe('asking before adopting a different collection', () => {
  it('stops with a pending choice and changes nothing on either side', async () => {
    const t = setup();
    await saveAddDeviceExpectation(t.storage as never, {
      provider: 'dropbox',
      collectionId: EXPECTED,
    });
    await runSyncCycle(t.ctx, 'dropbox');

    expect(t.state().collectionChoice).toEqual({
      expectedCollectionId: EXPECTED,
      remoteCollectionId: REMOTE,
    });
    expect(t.state().readOnly).toBe(true);
    expect(t.transport.writes).toEqual([]);
    // No cursor, meta, event or card write: this device is still unbound.
    expect(t.calls).toEqual([]);
    expect(t.ctx.cursorRef.current?.collectionId).toBeUndefined();
  });

  it('"Keep this device\'s cards" disconnects without touching any event or card', async () => {
    const t = setup();
    await saveAddDeviceExpectation(t.storage as never, {
      provider: 'dropbox',
      collectionId: EXPECTED,
    });
    await runSyncCycle(t.ctx, 'dropbox');
    await disconnectActiveSync(t.ctx, () => t.ctx.metaRef.current);

    expect(t.state().provider).toBe('none');
    expect(t.state().collectionChoice).toBeUndefined();
    const allowed = new Set(['setSyncConfig', 'setSyncCursor', 'setDeviceMeta']);
    expect(t.calls.filter((c) => !allowed.has(c))).toEqual([]);
    expect(t.transport.writes).toEqual([]);
  });

  it('"Use the synced collection" binds to it and pushes nothing away', async () => {
    const t = setup();
    await saveAddDeviceExpectation(t.storage as never, {
      provider: 'dropbox',
      collectionId: EXPECTED,
    });
    await runSyncCycle(t.ctx, 'dropbox');
    // The choice clears the stored link, then syncs again.
    const { clearAddDeviceExpectation } = await import('../src/sync/addDeviceExpectation.ts');
    await clearAddDeviceExpectation(t.storage as never);
    await runSyncCycle(t.ctx, 'dropbox');

    expect(t.state().collectionChoice).toBeUndefined();
    expect(t.state().status).toBe('synced');
    expect(t.ctx.cursorRef.current?.collectionId).toBe(REMOTE);
    expect(t.calls).not.toContain('deleteEvents');
  });
});

describe('a sync already in flight when the user answers', () => {
  /** Holds every transport call until `release()`, so a sync can be caught mid-flight. */
  function gate(t: ReturnType<typeof setup>) {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const { list, read } = t.transport;
    t.transport.list = async (prefix: string) => {
      entered();
      await opened;
      return list(prefix);
    };
    t.transport.read = async (path: string) => {
      entered();
      await opened;
      return read(path);
    };
    return { release, reached };
  }

  async function pendingChoice() {
    const t = setup();
    await saveAddDeviceExpectation(t.storage as never, {
      provider: 'dropbox',
      collectionId: EXPECTED,
    });
    await runSyncCycle(t.ctx, 'dropbox');
    expect(t.state().collectionChoice).toBeDefined();
    return t;
  }

  it('"Keep this device\'s cards" is not undone by a sync that read the old link', async () => {
    const t = await pendingChoice();
    const g = gate(t);
    // An automatic sync starts while the question is open; it has read the link already.
    const stale = runSyncCycle(t.ctx, 'dropbox');
    await g.reached;

    const { clearAddDeviceExpectation } = await import('../src/sync/addDeviceExpectation.ts');
    await answerCollectionChoice({
      choice: 'local',
      latch: () => void (t.ctx.collectionChoiceEpochRef.current += 1),
      disconnect: () => disconnectActiveSync(t.ctx, () => t.ctx.metaRef.current),
      clearLink: () => clearAddDeviceExpectation(t.storage as never),
      sync: async () => {},
      setSyncState: (u) => t.ctx.setSyncState(u as never),
    });
    g.release();
    await stale;

    expect(t.state().collectionChoice).toBeUndefined();
    expect(t.state().provider).toBe('none');
    expect(t.state().status).toBe('disconnected');
    expect(t.state().readOnly).toBe(false);
    expect(t.transport.writes).toEqual([]);
  });

  it('"Use the synced collection" is not re-asked by a sync that read the old link', async () => {
    const t = await pendingChoice();
    const g = gate(t);
    const stale = runSyncCycle(t.ctx, 'dropbox');
    await g.reached;

    const { clearAddDeviceExpectation } = await import('../src/sync/addDeviceExpectation.ts');
    // The answer's own sync waits behind the stale one, as executeSync queues it.
    await answerCollectionChoice({
      choice: 'synced',
      latch: () => void (t.ctx.collectionChoiceEpochRef.current += 1),
      disconnect: async () => {},
      clearLink: () => clearAddDeviceExpectation(t.storage as never),
      sync: async () => {},
      setSyncState: (u) => t.ctx.setSyncState(u as never),
    });
    g.release();
    await stale;
    expect(t.state().collectionChoice).toBeUndefined();
    expect(t.state().readOnly).toBe(false);

    await runSyncCycle(t.ctx, 'dropbox');
    expect(t.state().collectionChoice).toBeUndefined();
    expect(t.state().status).toBe('synced');
    expect(t.ctx.cursorRef.current?.collectionId).toBe(REMOTE);
  });

  it('a sync that starts after the answer still asks when the link is still stored', async () => {
    // The latch only drops results of syncs begun before the answer.
    const t = await pendingChoice();
    t.ctx.collectionChoiceEpochRef.current += 1;
    t.ctx.setSyncState({ ...t.state(), collectionChoice: undefined } as never);
    await runSyncCycle(t.ctx, 'dropbox');
    expect(t.state().collectionChoice).toBeDefined();
  });
});

describe('use the synced collection keeps the device own events', () => {
  it('pushes every local event into the synced collection and binds to it', async () => {
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 1_000));
    const local = [
      factory.create('PreferencesChanged', { preferences: { day_start_hour: 5 } }, 1_000),
      factory.create('PreferencesChanged', { preferences: { day_start_hour: 6 } }, 1_001),
    ];
    const t = setup(local);
    await saveAddDeviceExpectation(t.storage as never, {
      provider: 'dropbox',
      collectionId: EXPECTED,
    });
    await runSyncCycle(t.ctx, 'dropbox');
    expect(t.transport.writes).toEqual([]);

    const { clearAddDeviceExpectation } = await import('../src/sync/addDeviceExpectation.ts');
    await answerCollectionChoice({
      choice: 'synced',
      latch: () => {},
      disconnect: async () => {},
      clearLink: () => clearAddDeviceExpectation(t.storage as never),
      sync: () => runSyncCycle(t.ctx, 'dropbox'),
      setSyncState: (u) => t.ctx.setSyncState(u as never),
    });

    expect(t.state().status).toBe('synced');
    expect(t.state().lastPushedCount).toBe(2);
    expect(t.ctx.cursorRef.current?.collectionId).toBe(REMOTE);
    expect(t.ctx.cursorRef.current?.lastPushedSeq).toBe(2);
    expect(t.transport.writes.some((w) => w.includes('seg-'))).toBe(true);
    expect(t.calls).not.toContain('deleteEvents');
  });
});

describe('answerCollectionChoice', () => {
  const pendingState = {
    provider: 'dropbox',
    status: 'idle',
    isOnline: true,
    readOnly: true,
    errorMessage: 'Choose below',
    collectionChoice: { expectedCollectionId: EXPECTED, remoteCollectionId: REMOTE },
    pendingCount: 1,
    lastPulledCount: 0,
    lastPushedCount: 0,
  } as SyncUiState;

  function harness(opts: { disconnectFails?: boolean } = {}) {
    const order: string[] = [];
    let state = pendingState;
    return {
      order,
      state: () => state,
      run: (choice: 'synced' | 'local') =>
        answerCollectionChoice({
          choice,
          latch: () => void order.push('latch'),
          disconnect: async () => {
            order.push('disconnect');
            if (opts.disconnectFails) throw new Error('sign-out failed');
          },
          clearLink: async () => void order.push('clearLink'),
          sync: async () => void order.push('sync'),
          setSyncState: (u) => {
            order.push('setState');
            state = u(state);
          },
        }),
    };
  }

  it('keep: disconnects first, then forgets the link, and never syncs', async () => {
    const h = harness();
    await h.run('local');
    expect(h.order).toEqual(['latch', 'disconnect', 'clearLink']);
  });

  it('keep: a failing disconnect leaves the link stored and the question open', async () => {
    const h = harness({ disconnectFails: true });
    await expect(h.run('local')).rejects.toThrow('sign-out failed');
    expect(h.order).toEqual(['latch', 'disconnect']);
    expect(h.state().collectionChoice).toBeDefined();
  });

  it('use synced: forgets the link, clears the question and read-only, then syncs', async () => {
    const h = harness();
    await h.run('synced');
    expect(h.order).toEqual(['latch', 'clearLink', 'setState', 'sync']);
    expect(h.state().collectionChoice).toBeUndefined();
    expect(h.state().errorMessage).toBeUndefined();
    expect(h.state().readOnly).toBe(false);
  });
});

describe('a tab that a Check database rebuild left stale', () => {
  it('stops syncing: no pull, push or cursor move until it reloads', async () => {
    const t = setup();
    (t.ctx as { startedAtMs?: number }).startedAtMs = 1_000;
    await (t.storage as { setKv(k: string, v: unknown): Promise<void> }).setKv(
      COLLECTION_REBUILT_KV_KEY,
      2_000,
    );
    await runSyncCycle(t.ctx, 'dropbox');
    expect(t.transport.writes).toEqual([]);
    expect(t.calls).not.toContain('setSyncCursor');
    expect(t.calls).not.toContain('setLocalSnapshot');
    expect(t.ctx.cursorRef.current).toBeUndefined();
    expect(t.state().status).toBe('idle');
  });
});
