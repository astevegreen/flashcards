import type { FlashEvent } from '@flash/core';
import { describe, expect, it, vi } from 'vitest';
import { createSyncShell, initialSyncUiState, type SyncActions } from '../src/state/syncShell.ts';

function fakeController(overrides: Partial<SyncActions> = {}): SyncActions {
  return {
    syncNow: vi.fn(async () => {}),
    flushPendingSync: vi.fn(),
    connectGoogleDrive: vi.fn(async () => {}),
    connectDropbox: vi.fn(async () => {}),
    connectOneDrive: vi.fn(async () => {}),
    connectLocalFolder: vi.fn(async () => true),
    reconnectLocalFolder: vi.fn(async () => true),
    connectICloud: vi.fn(async () => {}),
    disconnectSync: vi.fn(async () => {}),
    resolveCollectionChoice: vi.fn(async () => {}),
    notifyLocalEvents: vi.fn(),
    getCurrentWatermarks: vi.fn(() => ({ live: 9 })),
    resetSyncState: vi.fn(),
    ...overrides,
  };
}

const ev = (n: number) => ({ id: `e${n}` }) as unknown as FlashEvent;

describe('sync shell (P1: the controller loads after first paint)', () => {
  it('queues local-event notices and replays them in order when the controller attaches', () => {
    const shell = createSyncShell(() => ({}));
    shell.notifyLocalEvents([ev(1)], 1);
    shell.notifyLocalEvents([ev(2), ev(3)]);
    const controller = fakeController();
    shell.attach(controller);
    expect(vi.mocked(controller.notifyLocalEvents).mock.calls).toEqual([
      [[ev(1)], 1],
      [[ev(2), ev(3)], undefined],
    ]);
    // Later notices go straight through, and the queue isn't replayed twice.
    shell.notifyLocalEvents([ev(4)], 0);
    shell.attach(controller);
    expect(controller.notifyLocalEvents).toHaveBeenCalledTimes(3);
  });

  it('answers watermarks from the boot cursor until the controller attaches', () => {
    const shell = createSyncShell(() => ({ boot: 1 }));
    expect(shell.getCurrentWatermarks()).toEqual({ boot: 1 });
    shell.attach(fakeController());
    expect(shell.getCurrentWatermarks()).toEqual({ live: 9 });
  });

  it('holds actions until the controller attaches, then uses the latest one', async () => {
    const shell = createSyncShell(() => ({}));
    const connected = shell.connectLocalFolder();
    const first = fakeController({ connectLocalFolder: vi.fn(async () => false) });
    const latest = fakeController();
    shell.attach(first);
    shell.attach(latest);
    await expect(connected).resolves.toBe(true);
    expect(first.connectLocalFolder).not.toHaveBeenCalled();
    await shell.syncNow({ silent: true });
    expect(latest.syncNow).toHaveBeenCalledWith({ silent: true });
  });

  it('starts from the same status the controller would show', () => {
    const meta = { deviceId: 'd', seq: 12, hlc: { wallMs: 0, counter: 0, deviceId: 'd' } };
    const state = initialSyncUiState(
      'local_folder',
      meta as never,
      { provider: 'local_folder', localFolderName: 'Cards' },
      { lastPushedSeq: 10, lastSyncedAt: 5, remoteWatermarks: {} } as never,
    );
    expect(state).toMatchObject({
      provider: 'local_folder',
      status: 'synced',
      pendingCount: 2,
      lastSyncedAt: 5,
      localFolderName: 'Cards',
    });
    expect(initialSyncUiState('none', meta as never).status).toBe('disconnected');
    expect(
      initialSyncUiState('dropbox', meta as never, undefined, undefined, 'denied'),
    ).toMatchObject({ status: 'error', errorMessage: 'denied' });
  });
});
