import type { PlatformServices } from '@flash/platform';
import { describe, expect, it } from 'vitest';
import {
  emptyLinkedSourcesHint,
  linkedSourcesDescription,
  unconfiguredSourceHints,
} from '../src/sources/sourceProviders.ts';

type ProviderPlatform = Parameters<typeof unconfiguredSourceHints>[0];

function platform(overrides: Partial<PlatformServices> = {}): ProviderPlatform {
  return {
    isDevMode: false,
    googleOAuthConfigured: true,
    googlePickerConfigured: true,
    supportsLocalFolderSync: true,
    ...overrides,
  } as ProviderPlatform;
}

describe('Linked Sources provider list', () => {
  it('lists only the providers this platform offers', () => {
    const everything = platform({
      oneDriveConfigured: true,
      getOneDrivePicker: async () => ({}) as never,
      dropboxConfigured: true,
      getDropboxPicker: async () => ({}) as never,
    });
    expect(linkedSourcesDescription(everything)).toBe(
      'Pull updates from Google Drive (Sheets, Docs, and CSV/TSV/XLSX files), OneDrive spreadsheets, Dropbox files, PC local folders (including Inbox/), or subscribed .flashpkg URLs. Everything stays cached offline.',
    );

    // A phone build without OneDrive: no OneDrive, no local folders.
    const phone = platform({ supportsLocalFolderSync: false });
    const text = linkedSourcesDescription(phone);
    expect(text).toContain('Google Drive');
    expect(text).not.toContain('OneDrive');
    expect(text).not.toContain('local folders');
    expect(emptyLinkedSourcesHint(phone)).toBe(
      'No external sources linked yet. Link a Google Sheet, Doc or Drive file, or subscribe to a Family Library URL above.',
    );

    const nothing = platform({ googleOAuthConfigured: false, supportsLocalFolderSync: false });
    expect(linkedSourcesDescription(nothing)).toBe(
      'Pull updates from subscribed .flashpkg URLs. Everything stays cached offline.',
    );
    expect(emptyLinkedSourcesHint(nothing)).toBe(
      'No external sources linked yet. Subscribe to a Family Library URL above.',
    );
  });

  it('names missing env vars in dev builds only', () => {
    const missing = { googleOAuthConfigured: false, googlePickerConfigured: false };
    expect(unconfiguredSourceHints(platform(missing))).toEqual([]);

    const dev = unconfiguredSourceHints(platform({ ...missing, isDevMode: true }));
    expect(dev.map((h) => h.id)).toEqual(['google', 'onedrive', 'dropbox']);
    expect(dev[0]?.message).toBe('Not configured in this build (set VITE_GOOGLE_CLIENT_ID).');
    expect(dev[1]?.message).toContain('VITE_MS_CLIENT_ID');
    expect(dev[2]?.message).toContain('VITE_DROPBOX_APP_KEY');

    // Google signed-in builds without a Picker key say which key the picker needs.
    const noPicker = unconfiguredSourceHints(
      platform({
        isDevMode: true,
        googlePickerConfigured: false,
        oneDriveConfigured: true,
        getOneDrivePicker: async () => ({}) as never,
        dropboxConfigured: true,
        getDropboxPicker: async () => ({}) as never,
      }),
    );
    expect(noPicker.map((h) => h.id)).toEqual(['google-picker']);
    expect(noPicker[0]?.message).toContain('VITE_GOOGLE_API_KEY');
  });
});
