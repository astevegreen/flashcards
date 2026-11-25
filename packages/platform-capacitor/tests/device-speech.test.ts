import { describe, expect, it, vi } from 'vitest';
import {
  CapacitorDeviceSpeechPlayer,
  type NativeTtsPlugin,
} from '../src/audio/native-device-speech.ts';

function createFakeTtsPlugin(opts?: {
  available?: boolean;
  voices?: Array<{ name: string; lang: string; localService: boolean; default?: boolean }>;
}) {
  let available = opts?.available ?? true;
  let voices = opts?.voices ?? [
    { name: 'ko-KR-local', lang: 'ko-KR', localService: true, default: true },
    { name: 'ko-KR-net', lang: 'ko-KR', localService: false },
    { name: 'en-US-net', lang: 'en-US', localService: false },
  ];
  let voicesListener: ((e: { available?: boolean }) => void) | null = null;
  const speakCalls: Array<{ text: string; lang: string; rate?: number; voiceName?: string }> = [];
  const stop = vi.fn(async () => undefined);

  const plugin: NativeTtsPlugin = {
    isAvailable: async () => ({ available }),
    getVoices: async () => ({ voices }),
    speak: async (call) => {
      speakCalls.push(call);
    },
    stop,
    addListener: async (_event, listener) => {
      voicesListener = listener;
      return { remove: async () => undefined };
    },
  };

  return {
    plugin,
    speakCalls,
    stop,
    setState(next: {
      available?: boolean;
      voices?: Array<{ name: string; lang: string; localService: boolean; default?: boolean }>;
    }) {
      if (next.available !== undefined) available = next.available;
      if (next.voices !== undefined) voices = next.voices;
      voicesListener?.({ available });
    },
  };
}

describe('CapacitorDeviceSpeechPlayer', () => {
  it('loads availability and voices asynchronously and notifies onVoicesChanged', async () => {
    const fake = createFakeTtsPlugin();
    const player = new CapacitorDeviceSpeechPlayer(fake.plugin);
    const onChanged = vi.fn();
    const unsub = player.onVoicesChanged(onChanged);

    await player.refresh();
    expect(player.isAvailable()).toBe(true);
    expect(player.listVoices('ko')).toHaveLength(2);
    expect(player.listVoices('ko').filter((v) => v.localService)).toHaveLength(1);
    expect(onChanged).toHaveBeenCalled();

    unsub();
  });

  it('enforces localService voices when offline and returns missing_local_voice otherwise', async () => {
    const fake = createFakeTtsPlugin();
    const player = new CapacitorDeviceSpeechPlayer(fake.plugin);
    await player.refresh();

    const koRes = player.speak('안녕하세요', 'ko', { isOnline: false, rate: 0.75 });
    expect(koRes.status).toBe('spoken');
    expect(fake.speakCalls).toEqual([
      { text: '안녕하세요', lang: 'ko-KR', rate: 0.75, voiceName: 'ko-KR-local' },
    ]);

    // English only has a network voice -> must refuse offline with Android instructions.
    const enRes = player.speak('Hello', 'en', { isOnline: false });
    expect(enRes.status).toBe('missing_local_voice');
    expect(enRes.message).toContain('Android');

    // Online allows the network voice.
    const enOnline = player.speak('Hello', 'en', { isOnline: true });
    expect(enOnline.status).toBe('spoken');
    expect(fake.speakCalls[1]).toEqual({
      text: 'Hello',
      lang: 'en-US',
      rate: 1,
      voiceName: 'en-US-net',
    });
  });

  it('reports unavailable with an informative message when native TTS is not ready', async () => {
    const fake = createFakeTtsPlugin({ available: false, voices: [] });
    const player = new CapacitorDeviceSpeechPlayer(fake.plugin);
    await player.refresh();

    expect(player.isAvailable()).toBe(false);
    const res = player.speak('테스트', 'ko');
    expect(res.status).toBe('unavailable');
    expect(res.message).toContain('Android Text-to-Speech');
  });

  it('forwards stop() to the native plugin when available', async () => {
    const fake = createFakeTtsPlugin();
    const player = new CapacitorDeviceSpeechPlayer(fake.plugin);
    await player.refresh();
    player.stop();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
});
