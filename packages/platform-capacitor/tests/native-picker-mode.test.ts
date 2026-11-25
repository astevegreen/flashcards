import { describe, expect, it } from 'vitest';
import { CapacitorNativePickerBridge } from '../src/sources/native-picker-bridge.ts';

describe('native Picker bridge: Link from Google Drive', () => {
  it('asks picker.html for Drive files only when mode is drive_files', async () => {
    const opened: string[] = [];
    const bridge = new CapacitorNativePickerBridge({
      openAndAwaitDeepLink: async ({ url }) => {
        opened.push(url);
        return `flashcards://picker-callback?files=${encodeURIComponent(
          JSON.stringify([{ id: 'csv-1', name: 'vocab.csv', mimeType: 'text/csv' }]),
        )}`;
      },
    });
    const base = {
      pickerPageUrl: 'https://flashcards.example/picker.html',
      accessToken: 'tok',
      appId: '123',
      apiKey: 'key',
    };
    const picked = await bridge.openSystemBrowserPicker({ ...base, mode: 'drive_files' });
    expect(picked).toEqual([{ id: 'csv-1', name: 'vocab.csv', mimeType: 'text/csv' }]);
    await bridge.openSystemBrowserPicker(base);

    const fragments = opened.map((u) => new URLSearchParams(new URL(u).hash.slice(1)));
    expect(fragments[0]?.get('mode')).toBe('drive_files');
    expect(fragments[1]?.has('mode')).toBe(false);
  });
});
