import { describe, expect, it } from 'vitest';
import { CapacitorNativePickerBridge } from '../src/sources/native-picker-bridge.ts';
import { isPickerCallback } from '../src/native/deep-links.ts';

describe('native Picker bridge: Link from Google Drive', () => {
  it('asks picker.html for Drive files only when mode is drive_files', async () => {
    const opened: string[] = [];
    const bridge = new CapacitorNativePickerBridge({
      openAndAwaitDeepLink: async ({ url, state }) => {
        opened.push(url);
        return `flashcards://picker-callback?files=${encodeURIComponent(
          JSON.stringify([{ id: 'csv-1', name: 'vocab.csv', mimeType: 'text/csv' }]),
        )}&state=${state ?? ''}`;
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

describe('native Picker bridge: state nonce (S10)', () => {
  const base = {
    pickerPageUrl: 'https://flashcards.example/picker.html',
    accessToken: 'tok',
    appId: '123',
    apiKey: 'key',
  };

  it('sends a fresh state and hands it to the launcher', async () => {
    const seen: Array<{ fragment: string | null; state: string | undefined }> = [];
    const bridge = new CapacitorNativePickerBridge({
      openAndAwaitDeepLink: async ({ url, state }) => {
        const fragment = new URLSearchParams(new URL(url).hash.slice(1)).get('state');
        seen.push({ fragment, state });
        return `flashcards://picker-callback?files=%5B%5D&state=${fragment ?? ''}`;
      },
    });
    await bridge.openSystemBrowserPicker(base);
    await bridge.openSystemBrowserPicker(base);
    expect(seen[0]?.fragment).toMatch(/^[0-9a-f]{32}$/);
    expect(seen[0]?.state).toBe(seen[0]?.fragment);
    expect(seen[1]?.fragment).not.toBe(seen[0]?.fragment);
  });

  it('refuses a callback carrying another state', async () => {
    const reply = 'flashcards://picker-callback?files=%5B%5D&state=forged';
    const bridge = new CapacitorNativePickerBridge({ openAndAwaitDeepLink: async () => reply });
    await expect(bridge.openSystemBrowserPicker(base)).rejects.toThrow(/did not come from/);
  });

  it('refuses a callback with no state (required since the hosted picker.js echoes it)', async () => {
    const files = encodeURIComponent(JSON.stringify([{ id: 'f1', name: 'Deck' }]));
    for (const reply of [
      `flashcards://picker-callback?files=${files}`,
      `flashcards://picker-callback?files=${files}&state=`,
    ]) {
      const bridge = new CapacitorNativePickerBridge({ openAndAwaitDeepLink: async () => reply });
      await expect(bridge.openSystemBrowserPicker(base)).rejects.toThrow(/did not come from/);
    }
  });

  it('isPickerCallback matches the exact host and the state', () => {
    expect(
      isPickerCallback('flashcards://picker-callback?state=s1&files=[]', 'flashcards', 's1'),
    ).toBe(true);
    expect(isPickerCallback('flashcards://picker-callback?state=s2', 'flashcards', 's1')).toBe(
      false,
    );
    // No state at all (a stale cached picker.js, or a forged link): refused.
    expect(isPickerCallback('flashcards://picker-callback?files=[]', 'flashcards', 's1')).toBe(
      false,
    );
    expect(isPickerCallback('flashcards://picker-callbackevil?state=s1', 'flashcards', 's1')).toBe(
      false,
    );
    expect(isPickerCallback('flashcards://picker-callback.evil?state=s1', 'flashcards')).toBe(
      false,
    );
    expect(isPickerCallback('flashcards://picker-callback?files=[]', 'flashcards')).toBe(true);
  });
});
