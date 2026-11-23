import { describe, expect, it, vi } from 'vitest';
import { createAddDeviceUrlSourceFrom, isAddDeviceUrl } from '../src/native/add-device-url.ts';

function fakePlugin(launch: string[] | null = null) {
  let open: ((urls: string[]) => void) | undefined;
  const unlisten = vi.fn();
  return {
    plugin: {
      getCurrent: vi.fn(async () => launch),
      onOpenUrl: vi.fn(async (h: (urls: string[]) => void) => {
        open = h;
        return unlisten;
      }),
    },
    emit: (urls: string[]) => open?.(urls),
    unlisten,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('isAddDeviceUrl', () => {
  it('accepts only the exact add-device host', () => {
    for (const ok of [
      'flashcards://add-device',
      'flashcards://add-device?sync=google',
      'flashcards://add-device/?sync=google',
      'FLASHCARDS://ADD-DEVICE#x',
    ]) {
      expect(isAddDeviceUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      'flashcards://add-device.evil?sync=google',
      'flashcards://picker-callback?files=1',
      'flashcards://oauth/microsoft',
      'https://add-device',
      '',
    ]) {
      expect(isAddDeviceUrl(bad), bad).toBe(false);
    }
  });
});

describe('createAddDeviceUrlSourceFrom', () => {
  it('delivers the launch URL and later links, ignoring other deep links', async () => {
    const f = fakePlugin(['flashcards://add-device?sync=icloud']);
    const handler = vi.fn();
    const stop = createAddDeviceUrlSourceFrom(f.plugin)(handler);
    await tick();
    f.emit(['flashcards://picker-callback?x=1', 'flashcards://add-device?sync=google']);
    expect(handler.mock.calls.map((c) => c[0])).toEqual([
      'flashcards://add-device?sync=icloud',
      'flashcards://add-device?sync=google',
    ]);
    stop();
    expect(f.unlisten).toHaveBeenCalled();
    f.emit(['flashcards://add-device?sync=dropbox']);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not replay the launch URL when subscribed again', async () => {
    const f = fakePlugin(['flashcards://add-device?sync=icloud']);
    const source = createAddDeviceUrlSourceFrom(f.plugin);
    const first = vi.fn();
    const stop = source(first);
    await tick();
    stop();
    const second = vi.fn();
    source(second);
    await tick();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
