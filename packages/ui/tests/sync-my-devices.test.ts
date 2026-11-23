import { describe, expect, it } from 'vitest';
import {
  availableSyncProviders,
  ICLOUD_OFF_HINT,
  iCloudOffHint,
  pickDefaultSyncProvider,
  planSyncMyDevices,
  type SyncPlatformFlags,
} from '../src/sync/syncProviders.ts';

const unavailable = () => Promise.reject(new Error('not in this test'));

/** Platform objects as each shell builds them (only the sync capability flags matter here). */
const WEB: SyncPlatformFlags = { googleOAuthConfigured: true, supportsLocalFolderSync: true };
const WEB_ALL: SyncPlatformFlags = {
  ...WEB,
  dropboxConfigured: true,
  getDropboxAuth: unavailable,
  oneDriveConfigured: true,
  getOneDriveAuth: unavailable,
};
const ANDROID: SyncPlatformFlags = { googleOAuthConfigured: true, supportsLocalFolderSync: false };
const IOS: SyncPlatformFlags = {
  googleOAuthConfigured: true,
  supportsLocalFolderSync: false,
  iCloudSyncSupported: true,
  createICloudTransport: unavailable,
};
/** The Tauri shell on macOS when iCloud Drive was available at launch. */
const MACOS_ICLOUD: SyncPlatformFlags = {
  googleOAuthConfigured: true,
  supportsLocalFolderSync: true,
  iCloudSyncSupported: true,
  createICloudTransport: unavailable,
};
/** The Tauri shell on macOS when iCloud was off or slow at launch: offered, not the default. */
const MACOS_ICLOUD_OFF_AT_LAUNCH: SyncPlatformFlags = {
  ...MACOS_ICLOUD,
  iCloudAvailableAtLaunch: false,
};
/** A Tauri build without iCloud support (Windows, Linux, and unsigned Mac builds). */
const MACOS_NO_ICLOUD: SyncPlatformFlags = {
  googleOAuthConfigured: true,
  supportsLocalFolderSync: true,
};

describe('"Sync my devices" default provider', () => {
  it('uses iCloud where the platform has an iCloud transport (no sign-in)', () => {
    expect(pickDefaultSyncProvider(IOS)).toBe('icloud');
    expect(planSyncMyDevices(IOS, undefined)).toEqual({
      primary: 'icloud',
      alternatives: ['google_drive'],
    });
    expect(planSyncMyDevices(MACOS_ICLOUD, undefined)).toEqual({
      primary: 'icloud',
      alternatives: ['google_drive', 'local_folder'],
    });
  });

  it('uses Google Drive on Android, Windows, web and Apple platforms without iCloud', () => {
    for (const platform of [WEB, ANDROID, MACOS_NO_ICLOUD]) {
      expect(pickDefaultSyncProvider(platform)).toBe('google_drive');
    }
    // A flag without the transport (or the reverse) is not an iCloud platform.
    expect(pickDefaultSyncProvider({ ...ANDROID, iCloudSyncSupported: true })).toBe('google_drive');
    expect(pickDefaultSyncProvider({ ...ANDROID, createICloudTransport: unavailable })).toBe(
      'google_drive',
    );
  });

  it('keeps iCloud as an alternative on a Mac where it was off at launch', () => {
    expect(planSyncMyDevices(MACOS_ICLOUD_OFF_AT_LAUNCH, undefined)).toEqual({
      primary: 'google_drive',
      alternatives: ['icloud', 'local_folder'],
    });
    // An add-device link for iCloud still preselects it.
    expect(planSyncMyDevices(MACOS_ICLOUD_OFF_AT_LAUNCH, { provider: 'icloud' }).primary).toBe(
      'icloud',
    );
  });

  it('hints to turn iCloud Drive on only on an entitled Mac where it was off at launch', () => {
    expect(iCloudOffHint(MACOS_ICLOUD_OFF_AT_LAUNCH)).toBe(ICLOUD_OFF_HINT);
    expect(ICLOUD_OFF_HINT).toContain('System Settings');
    for (const platform of [MACOS_ICLOUD, MACOS_NO_ICLOUD, IOS, ANDROID, WEB]) {
      expect(iCloudOffHint(platform)).toBeUndefined();
    }
  });

  it('never offers iCloud on an unsigned Mac build (no iCloud entitlement)', () => {
    expect(availableSyncProviders(MACOS_NO_ICLOUD)).not.toContain('icloud');
    expect(pickDefaultSyncProvider(MACOS_NO_ICLOUD)).toBe('google_drive');
    expect(planSyncMyDevices(MACOS_NO_ICLOUD, { provider: 'icloud' })).toMatchObject({
      primary: 'google_drive',
      unavailableLinkProvider: 'icloud',
    });
  });

  it('lists every other configured provider as an alternative', () => {
    expect(planSyncMyDevices(WEB_ALL, undefined)).toEqual({
      primary: 'google_drive',
      alternatives: ['dropbox', 'onedrive', 'local_folder'],
    });
    expect(availableSyncProviders(ANDROID)).toEqual(['google_drive']);
    // A provider flag without its auth factory is not offered.
    expect(availableSyncProviders({ ...WEB, dropboxConfigured: true })).toEqual([
      'google_drive',
      'local_folder',
    ]);
  });

  it('falls back to the first other provider when Google is not configured', () => {
    expect(pickDefaultSyncProvider({ ...WEB_ALL, googleOAuthConfigured: false })).toBe('dropbox');
    expect(
      pickDefaultSyncProvider({ googleOAuthConfigured: false, supportsLocalFolderSync: false }),
    ).toBeUndefined();
  });

  it('preselects an add-device link provider this device can use', () => {
    expect(planSyncMyDevices(WEB_ALL, { provider: 'onedrive' })).toEqual({
      primary: 'onedrive',
      alternatives: ['google_drive', 'dropbox', 'local_folder'],
    });
    expect(planSyncMyDevices(IOS, { provider: 'google_drive' }).primary).toBe('google_drive');
    // An iCloud link opened on Android: keep the default and say why.
    expect(planSyncMyDevices(ANDROID, { provider: 'icloud' })).toEqual({
      primary: 'google_drive',
      alternatives: [],
      unavailableLinkProvider: 'icloud',
    });
  });
});
