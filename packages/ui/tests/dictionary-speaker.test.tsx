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
    const tts = fakeTtsProvider(async () => {
      throw new Error('quota exceeded');
    });
    await mountPanel(
      { audioPlayer: fakeAudioPlayer().player, createTtsProvider: async () => tts.provider },
      { storage: cloudStorage() },
    );
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
    const factory = createEventFactory('other', 0, createHlcState('other', Date.now()));
    const clip = factory.create(
      'MediaAdded',
      {
        media: {
          hash,
          ext: 'mp3',
          mime: 'audio/mpeg',
          size: 1,
          tts_lang_key: computeTtsLangCacheKey('한국', 'ko'),
        },
      },
      Date.now(),
    );
    const audio = fakeAudioPlayer();
    await mountPanel(
      { audioPlayer: audio.player },
      { storage, initialEvents: [...sampleEvents(), clip] },
    );
    expect(speaker('日本')).toBeNull();

    await press('한국');
    await vi.waitFor(() => expect(audio.playPreloaded).toHaveBeenCalledWith(hash, 1));
  });
});
