import { createEmptyState, SyncTransportError } from '@flash/core';
import { encodeManifest, manifestPath } from '@flash/core/sync';
import { describe, expect, it } from 'vitest';
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

function setup() {
  const kv = new Map<string, unknown>();
  const calls: string[] = [];
  const storage = new Proxy(
    {
      getKv: async (k: string) => kv.get(k),
      setKv: async (k: string, v: unknown) => void kv.set(k, v),
      deleteKv: async (k: string) => void kv.delete(k),
      getSyncCursor: async () => undefined,
      getDeviceEventsAfterSeq: async () => [],
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
    metaRef: ref({ deviceId: 'dev-a', seq: 0, hlc: { wall: 0, counter: 0, device: 'dev-a' } }),
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
