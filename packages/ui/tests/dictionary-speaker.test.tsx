// @vitest-environment happy-dom
/**
 * The dictionary's speaker button speaks the headword in the entry's language through the study
 * cards' audio chain, and is only there when that language can be spoken.
 */
import { computeTtsLangCacheKey, createEventFactory, createHlcState } from '@flash/core';
import type {
  AudioPlayer,
  DeviceSpeechPlayer,
  DeviceVoiceInfo,
  DictionaryEntry,
  DictionaryPackId,
  DictionaryService,
  InstalledPackInfo,
  PlatformServices,
  TtsProvider,
} from '@flash/platform';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DictionaryPanel } from '../src/dictionary/DictionaryPanel.tsx';
import { TTS_CONFIG_KV_KEY } from '../src/state/useAudioController.ts';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  sampleEvents,
  type MemoryStorage,
  type Mounted,
  type MountOptions,
} from './helpers/app-harness.tsx';

function entry(packId: DictionaryPackId, headword: string): DictionaryEntry {
  return {
    id: `${packId}:${headword}`,
    packId,
    headword,
    readings: [],
    meanings: ['a word'],
    searchTokens: [],
  };
}

const ENTRIES = [entry('dict-krdict', '한국'), entry('dict-jmdict', '日本')];

const pack = (id: DictionaryPackId, language: string): InstalledPackInfo => ({
  id,
  kind: 'dictionary',
  name: id,
  version: '1',
  language,
  entryCount: 1,
  byteSize: 1,
  installedAt: 0,
  licenseName: 'test',
  licenseUrl: 'https://example.test/license',
  attribution: 'test',
  sourceUrl: 'https://example.test',
});

const dictionary = {
  listInstalledDictionaryPacks: async () => [pack('dict-krdict', 'ko'), pack('dict-jmdict', 'ja')],
  getBrowseSummary: async (packId: DictionaryPackId) => ({
    packId,
    total: 0,
    initials: [],
    levels: [],
    pos: [],
    topics: [],
    grades: [],
  }),
  search: async () => ENTRIES,
  lookupCharacter: async () => [],
  browse: async () => ({ entries: [] }),
} as unknown as DictionaryService;

const voice = (lang: string, localService = true): DeviceVoiceInfo => ({
  name: `${lang} voice`,
  lang,
  localService,
});

/** Device speech whose voice list the test controls, as an OS that loads voices late does. */
function fakeSpeech(initial: DeviceVoiceInfo[]) {
  let voices = initial;
  const listeners = new Set<() => void>();
  const speak = vi.fn<DeviceSpeechPlayer['speak']>((_text, lang) => ({ status: 'spoken', lang }));
  const player: DeviceSpeechPlayer = {
    isAvailable: () => true,
    listVoices: (lang) => voices.filter((v) => !lang || v.lang.startsWith(lang)),
    onVoicesChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    speak,
    stop: () => {},
  };
  const load = async (next: DeviceVoiceInfo[]) => {
    await act(async () => {
      voices = next;
      for (const listener of listeners) listener();
    });
  };
  return { player, speak, load };
}

function fakeAudioPlayer() {
  const playPreloaded = vi.fn<AudioPlayer['playPreloaded']>(async () => true);
  const unlock = vi.fn();
  const player: AudioPlayer = {
    unlock,
    preload: () => {},
    hasPreloaded: () => false,
    retainOnly: () => {},
    playPreloaded,
    play: async () => {},
    stop: () => {},
    dispose: () => {},
  };
  return { player, playPreloaded, unlock };
}

function fakeTtsProvider(synthesize: TtsProvider['synthesize']) {
  const spy = vi.fn(synthesize);
  const provider: TtsProvider = {
    id: 'google',
    resolveVoiceId: (lang) => `google:${lang}`,
    synthesize: spy,
  };
  return { provider, synthesize: spy };
}

let mounted: Mounted | undefined;
let online = true;

async function setOnline(next: boolean): Promise<void> {
  online = next;
  await act(async () => {
    window.dispatchEvent(new Event(next ? 'online' : 'offline'));
  });
}

async function mountPanel(
  services: Partial<PlatformServices>,
  options: { storage?: MemoryStorage } & Pick<MountOptions, 'initialEvents'> = {},
): Promise<Mounted> {
  vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
  const platform = createTestPlatform(options.storage ?? createMemoryStorage(), {
    getDictionaryService: async () => dictionary,
    ...services,
  });
  mounted = await mountWithApp(<DictionaryPanel initialQuery="word" />, {
    platform,
    initialEvents: options.initialEvents ?? sampleEvents(),
  });
  await vi.waitFor(async () => {
    await flush();
    expect(find('dict-entry-한국')).not.toBeNull();
  });
  return mounted;
}

const find = (testId: string): HTMLElement | null =>
  must(mounted, 'a mounted panel').container.querySelector(`[data-testid="${testId}"]`);

const speaker = (headword: string) => find(`dict-speak-${headword}`) as HTMLButtonElement | null;

async function press(headword: string): Promise<void> {
  await act(async () => {
    must(speaker(headword), `the speaker for ${headword}`).click();
  });
  await flush();
}

/** A saved BYO cloud TTS key. */
function cloudStorage(): MemoryStorage {
  const storage = createMemoryStorage();
  storage.kv.set(TTS_CONFIG_KV_KEY, { provider: 'google', apiKey: 'test-key' });
  return storage;
}

/** Mounts the panel with a saved cloud key whose provider runs `synthesize`. */
function mountCloud(synthesize: TtsProvider['synthesize']): Promise<Mounted> {
  const tts = fakeTtsProvider(synthesize);
  return mountPanel(
    { audioPlayer: fakeAudioPlayer().player, createTtsProvider: async () => tts.provider },
    { storage: cloudStorage() },
  );
}

const quotaExceeded = async (): Promise<never> => {
  throw new Error('quota exceeded');
};

const clip = { bytes: new Uint8Array([4]), mime: 'audio/mpeg', ext: 'mp3', voiceId: 'google:ko' };

/** A TTS clip another device made for `text` in `lang`, synced in under its language key. */
function clipEvent(hash: string, text: string, lang: string) {
  const factory = createEventFactory('other', 0, createHlcState('other', Date.now()));
  return factory.create(
    'MediaAdded',
    {
      media: {
        hash,
        ext: 'mp3',
        mime: 'audio/mpeg',
        size: 1,
        tts_lang_key: computeTtsLangCacheKey(text, lang),
      },
    },
    Date.now(),
  );
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  online = true;
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('dictionary speaker button', () => {
  it('speaks the headword in the entry language, only for a language with a voice', async () => {
    const speech = fakeSpeech([voice('ko-KR')]);
    const audio = fakeAudioPlayer();
    await mountPanel({ deviceSpeech: speech.player, audioPlayer: audio.player });

    const button = must(speaker('한국'), 'the Korean speaker');
    expect(button.getAttribute('aria-label')).toBe('Play pronunciation of 한국');
    // A native button: in the tab order, and Enter and Space press it.
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    expect(speaker('日本')).toBeNull();

    await press('한국');
    expect(audio.unlock).toHaveBeenCalled();
    expect(speech.speak).toHaveBeenCalledExactlyOnceWith('한국', 'ko', {
      rate: 1,
      isOnline: true,
    });
  });

  it('has no button when nothing can speak', async () => {
    await mountPanel({});
    expect(speaker('한국')).toBeNull();
    expect(speaker('日本')).toBeNull();
  });

  it('appears when the OS voice list loads late', async () => {
    const speech = fakeSpeech([]);
    await mountPanel({ deviceSpeech: speech.player });
    expect(speaker('日本')).toBeNull();

    await speech.load([voice('ja-JP')]);
    expect(speaker('日本')).not.toBeNull();
    expect(speaker('한국')).toBeNull();
  });

  it('counts only voices on the device while offline', async () => {
    const speech = fakeSpeech([voice('ko-KR', false), voice('ja-JP')]);
    await mountPanel({ deviceSpeech: speech.player });
    expect(speaker('한국')).not.toBeNull();

    await setOnline(false);
    expect(speaker('한국')).toBeNull();
    expect(speaker('日本')).not.toBeNull();

    await setOnline(true);
    expect(speaker('한국')).not.toBeNull();
  });

  it('speaks with the configured cloud provider online, and its cached clip offline', async () => {
    const tts = fakeTtsProvider(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'audio/mpeg',
      ext: 'mp3',
      voiceId: 'google:ja',
    }));
    const audio = fakeAudioPlayer();
    await mountPanel(
      { audioPlayer: audio.player, createTtsProvider: async () => tts.provider },
      { storage: cloudStorage() },
    );

    await press('日本');
    await vi.waitFor(() => expect(audio.playPreloaded).toHaveBeenCalledOnce());
    expect(tts.synthesize).toHaveBeenCalledExactlyOnceWith('日本', 'ja', expect.anything());

    await setOnline(false);
    // The clip just made is cached, so that word still plays; the other one cannot.
    expect(speaker('日本')).not.toBeNull();
    expect(speaker('한국')).toBeNull();
  });

  it('shows why a cloud request failed', async () => {
    await mountCloud(quotaExceeded);
    expect(find('dict-audio-warning')).toBeNull();

    await press('한국');
    await vi.waitFor(() =>
      expect(find('dict-audio-warning')?.textContent).toContain('quota exceeded'),
    );

    await act(async () => {
      must(find('dict-audio-warning')?.querySelector('button'), 'Dismiss').click();
    });
    expect(find('dict-audio-warning')).toBeNull();
  });

  it('plays a clip already in the collection with no voice at all', async () => {
    const hash = 'a'.repeat(64);
    const storage = createMemoryStorage();
    storage.media.set(hash, { hash, mime: 'audio/mpeg', bytes: new Uint8Array([1]) });
    const audio = fakeAudioPlayer();
    await mountPanel(
      { audioPlayer: audio.player },
      { storage, initialEvents: [...sampleEvents(), clipEvent(hash, '한국', 'ko')] },
    );
    expect(speaker('日本')).toBeNull();

    await press('한국');
    await vi.waitFor(() => expect(audio.playPreloaded).toHaveBeenCalledWith(hash, 1));
  });

  it('plays a cached clip when cloud TTS is set up but this platform cannot run it', async () => {
    const hash = 'b'.repeat(64);
    const storage = cloudStorage();
    storage.media.set(hash, { hash, mime: 'audio/mpeg', bytes: new Uint8Array([1]) });
    const audio = fakeAudioPlayer();
    // No `createTtsProvider`: the saved key can't synthesize here, so the clip in the collection
    // (made by another device, in its voice) is what plays.
    await mountPanel(
      { audioPlayer: audio.player },
      { storage, initialEvents: [...sampleEvents(), clipEvent(hash, '한국', 'ko')] },
    );
    expect(speaker('日本')).toBeNull();

    await press('한국');
    await vi.waitFor(() => expect(audio.playPreloaded).toHaveBeenCalledWith(hash, 1));
  });
});

describe('audio warnings stay where they came from', () => {
  it('keeps a dictionary failure off the study banner', async () => {
    const m = await mountCloud(quotaExceeded);

    await press('한국');
    await vi.waitFor(() =>
      expect(find('dict-audio-warning')?.textContent).toContain('quota exceeded'),
    );
    expect(m.app().audio.lastAudioWarning).toBeNull();
  });

  it('keeps a study-card failure out of the dictionary', async () => {
    const m = await mountCloud(quotaExceeded);

    await act(async () => {
      await m.app().audio.speakTarget({
        rawText: '공부',
        normalizedText: '공부',
        lang: 'ko',
        bcp47Lang: 'ko-KR',
      });
    });
    await flush();
    expect(m.app().audio.lastAudioWarning).toContain('quota exceeded');
    expect(find('dict-audio-warning')).toBeNull();
  });

  it('keeps a Settings voice test failure off the study banner', async () => {
    const m = await mountCloud(quotaExceeded);

    let message = '';
    await act(async () => {
      message = (await m.app().audio.testTtsVoice('ko')).message;
    });
    expect(message).toContain('quota exceeded');
    expect(m.app().audio.lastAudioWarning).toBeNull();
  });

  it('clears the dictionary warning on a press that speaks', async () => {
    let fail = true;
    await mountCloud(async () => {
      if (fail) throw new Error('quota exceeded');
      return clip;
    });

    await press('한국');
    await vi.waitFor(() => expect(find('dict-audio-warning')).not.toBeNull());
    fail = false;
    await press('日本');
    await vi.waitFor(() => expect(find('dict-audio-warning')).toBeNull());
  });

  it('ignores a press that settles after a newer one, or after the panel closed', async () => {
    let release = (): void => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mountCloud(async (text) => {
      // The first word answers late; the second fails at once.
      if (text === '한국') {
        await slow;
        return clip;
      }
      throw new Error('quota exceeded');
    });

    await press('한국');
    await press('日本');
    await vi.waitFor(() => expect(find('dict-audio-warning')).not.toBeNull());
    await act(async () => {
      release();
    });
    await flush();
    // The superseded press doesn't wipe the newer press's warning.
    expect(find('dict-audio-warning')?.textContent).toContain('quota exceeded');

    // A press still pending when the panel closes doesn't follow it to the next panel.
    let fail = (): void => {};
    const late = new Promise<void>((_resolve, reject) => {
      fail = () => reject(new Error('late failure'));
    });
    await must(mounted, 'a mounted panel').unmount();
    await mountCloud(async () => {
      await late.catch(() => {});
      throw new Error('late failure');
    });
    await press('한국');
    await must(mounted, 'a mounted panel').unmount();
    await act(async () => {
      fail();
    });
    await flush();
    await mountCloud(quotaExceeded);
    expect(find('dict-audio-warning')).toBeNull();
  });
});
