import 'fake-indexeddb/auto';
import { isSyncTransportError } from '@flash/core';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MicrosoftRefreshRejectedError,
  NativeMicrosoftAuth,
  type MicrosoftPublicClientBridge,
} from '../src/auth/microsoft-native-auth.ts';
import { createNativeOneDriveServices } from '../src/onedrive-services.ts';
import { DexieStorage } from '../src/storage/dexie-storage.ts';

const createdDbs: string[] = [];

function createStorage(): DexieStorage {
  const s = new DexieStorage(`msn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  createdDbs.push(s.dbName);
  return s;
}

function createBridge(): MicrosoftPublicClientBridge & {
  authorize: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  return {
    authorize: vi.fn(async () => ({ accessToken: 'native-acc-0', expiresInSeconds: 3600 })),
    refresh: vi.fn(async () => {
      n += 1;
      return { accessToken: `native-acc-${n}`, expiresInSeconds: 3600 };
    }),
    signOut: vi.fn(async () => {}),
  };
}

afterEach(async () => {
  while (createdDbs.length > 0) {
    const db = createdDbs.pop();
    if (db) await Dexie.delete(db);
  }
});

describe('NativeMicrosoftAuth (public client via platform bridge)', () => {
  it('signs in, refreshes near expiry with the granted scopes, and adds Files.Read for sources', async () => {
    const bridge = createBridge();
    let clock = 1_000_000;
    const auth = new NativeMicrosoftAuth({ bridge, storage: createStorage(), nowMs: () => clock });
    const session = await auth.signIn({ intent: 'sync' });
    expect(session?.provider).toBe('onedrive');
    expect(bridge.authorize).toHaveBeenCalledWith(['Files.ReadWrite.AppFolder', 'offline_access']);
    expect(await auth.getValidAccessToken()).toBe('native-acc-0');
    expect(await auth.hasScope('Files.Read')).toBe(false);

    clock += 3_600_000;
    expect(await auth.getValidAccessToken()).toBe('native-acc-1');
    expect(bridge.refresh).toHaveBeenCalledWith(['Files.ReadWrite.AppFolder', 'offline_access']);

    await auth.signIn({ intent: 'sources' });
    expect(bridge.authorize).toHaveBeenLastCalledWith([
      'Files.ReadWrite.AppFolder',
      'offline_access',
      'Files.Read',
    ]);
    expect(await auth.hasScope('Files.Read')).toBe(true);
  });

  it('treats only explicit refresh rejections as reconnect-required', async () => {
    const bridge = createBridge();
    let clock = 0;
    const auth = new NativeMicrosoftAuth({ bridge, storage: createStorage(), nowMs: () => clock });
    await auth.signIn();
    clock += 10_000_000;

    bridge.refresh.mockRejectedValueOnce(new Error('offline'));
    const offline = await auth.getValidAccessToken().catch((e: unknown) => e);
    expect(isSyncTransportError(offline) && offline.code).toBe('NETWORK');
    expect(await auth.isConnected()).toBe(true);

    bridge.refresh.mockRejectedValueOnce(new MicrosoftRefreshRejectedError('invalid_grant'));
    const rejected = await auth.getValidAccessToken().catch((e: unknown) => e);
    expect(isSyncTransportError(rejected) && rejected.code).toBe('AUTH_REQUIRED');
    expect(await auth.isConnected()).toBe(false);

    await auth.signOut();
    expect(bridge.signOut).toHaveBeenCalled();
    expect(await auth.getSession()).toBeNull();
  });

  it('builds transport and picker on the native auth', () => {
    const services = createNativeOneDriveServices({
      bridge: createBridge(),
      storage: createStorage(),
    });
    expect(services.auth.isConfigured()).toBe(true);
    expect(services.picker.isConfigured()).toBe(true);
    expect(typeof services.transport.list).toBe('function');
  });
});
