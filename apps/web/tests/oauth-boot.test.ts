import { createHlcState } from '@flash/core';
import type { AuthSession, DeviceMeta, PlatformServices } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import { completeOAuthRedirect } from '../src/oauth-boot.ts';

const meta: DeviceMeta = {
  deviceId: 'web-1',
  seq: 3,
  hlc: createHlcState('web-1', 0),
  collectionId: 'col-old',
};

const session = (intent?: AuthSession['intent']): AuthSession => ({
  provider: 'google',
  accessToken: 't',
  expiresAt: 1,
  ...(intent ? { intent } : {}),
});

function platform(
  callback: () => Promise<AuthSession | null>,
  extra: Partial<PlatformServices> = {},
) {
  const storage = {
    setSyncConfig: vi.fn(async () => {}),
    setSyncCursor: vi.fn(async () => {}),
    setDeviceMeta: vi.fn(async () => {}),
  };
  const auth = { handleRedirectCallback: vi.fn(callback) };
  const p = {
    storage,
    getGoogleAuth: async () => auth,
    ...extra,
  } as unknown as PlatformServices;
  return { p, storage };
}

describe('completeOAuthRedirect (boot on ?code= / ?error=)', () => {
  it('a sync sign-in switches the provider, starts a new cursor and forgets the collection', async () => {
    const { p, storage } = platform(async () => session());
    const out = await completeOAuthRedirect(p, {
      syncConfig: { provider: 'dropbox', connectedAt: 1 },
      syncCursor: undefined,
      meta,
    });
    expect(out.syncConfig?.provider).toBe('google_drive');
    expect(out.syncCursor).toBeDefined();
    expect(out.meta.collectionId).toBeUndefined();
    expect(out.initialOAuthError).toBeUndefined();
    expect(storage.setSyncConfig).toHaveBeenCalledTimes(1);
    expect(storage.setSyncCursor).toHaveBeenCalledTimes(1);
    expect(storage.setDeviceMeta).toHaveBeenCalledTimes(1);
  });

  it('a Sources sign-in keeps the sync provider already configured', async () => {
    const { p, storage } = platform(async () => session('sources'));
    const syncConfig = { provider: 'local_folder' as const, connectedAt: 1 };
    const out = await completeOAuthRedirect(p, { syncConfig, syncCursor: undefined, meta });
    expect(out.syncConfig).toBe(syncConfig);
    expect(out.meta).toBe(meta);
    expect(storage.setSyncConfig).not.toHaveBeenCalled();
  });

  it('OneDrive and Dropbox answer their own callbacks before Google', async () => {
    const google = vi.fn(async () => session());
    const { p } = platform(google, {
      oneDriveConfigured: true,
      getOneDriveAuth: async () =>
        ({ handleRedirectCallback: async () => null }) as unknown as Awaited<
          ReturnType<NonNullable<PlatformServices['getOneDriveAuth']>>
        >,
      dropboxConfigured: true,
      getDropboxAuth: async () =>
        ({ handleRedirectCallback: async () => session('sources') }) as unknown as Awaited<
          ReturnType<NonNullable<PlatformServices['getDropboxAuth']>>
        >,
    });
    const out = await completeOAuthRedirect(p, {
      syncConfig: undefined,
      syncCursor: undefined,
      meta,
    });
    // A Dropbox picker sign-in never turns on Dropbox sync by itself.
    expect(out.syncConfig).toBeUndefined();
    expect(google).not.toHaveBeenCalled();
  });

  it('a failed sign-in is reported, with the boot state kept', async () => {
    const { p } = platform(async () => {
      throw new Error('access_denied');
    });
    const out = await completeOAuthRedirect(p, {
      syncConfig: undefined,
      syncCursor: undefined,
      meta,
    });
    expect(out.initialOAuthError).toBe('access_denied');
    expect(out.meta).toBe(meta);
  });
});
