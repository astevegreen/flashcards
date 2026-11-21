import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMissingVoiceInstructions, WebDeviceSpeechPlayer } from '../src/audio/device-speech.ts';
import {
  AzureSpeechTtsProvider,
  escapeSsmlXml,
  GoogleCloudTtsProvider,
  TtsProviderError,
} from '../src/audio/tts-providers.ts';
import { WebAudioPlayer } from '../src/audio/web-audio-player.ts';
import {
  AudioProcessError,
  processAudioBytes,
  resolveValidatedAudioMime,
  sniffAudioMime,
} from '../src/media/audio-processor.ts';

const VALID_WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00,
  0x01, 0x00, 0x08, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

const VALID_MP3_ID3_BYTES = new Uint8Array([
  0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64,
]);

const VALID_MP3_SYNC_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
const VALID_OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);
const VALID_M4A_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebAudioPlayer (§7.2)', () => {
  it('unlocks audioSession.type = playback, preloads RAM ObjectURLs, revokes evicted clips, and plays synchronously at 0.75x with preservesPitch', async () => {
    let urlSeq = 0;
    const createdUrls = new Set<string>();
    const revokedUrls: string[] = [];

    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => {
      const u = `blob:test-${++urlSeq}`;
      createdUrls.add(u);
      return u;
    });
    URL.revokeObjectURL = vi.fn((u: string) => {
      revokedUrls.push(u);
    });

    const audioSession = { type: 'auto' };
    const origNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { audioSession, onLine: true, userAgent: 'Mozilla/5.0 (iPhone)' },
    });

    const fakeAudio = {
      preload: '',
      src: '',
      muted: false,
      currentTime: 0,
      defaultPlaybackRate: 1.0,
      playbackRate: 1.0,
      preservesPitch: false,
      webkitPreservesPitch: false,
      mozPreservesPitch: false,
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
    };

    try {
      const player = new WebAudioPlayer({
        createAudioElement: () => fakeAudio as unknown as HTMLAudioElement,
      });

      player.unlock();
      expect(audioSession.type).toBe('playback');
      expect(fakeAudio.play).toHaveBeenCalledTimes(1);

      // Idempotent unlock does not re-prime
      player.unlock();
      expect(fakeAudio.play).toHaveBeenCalledTimes(1);

      const h1 = '1'.repeat(64);
      const h2 = '2'.repeat(64);
      player.preload(h1, VALID_WAV_BYTES, 'audio/wav');
      player.preload(h2, VALID_MP3_ID3_BYTES, 'audio/mpeg');
      expect(player.hasPreloaded(h1)).toBe(true);
      expect(player.hasPreloaded(h2)).toBe(true);

      // Synchronous playPreloaded at 0.75x with preservesPitch
      const playPromise = player.playPreloaded(h1, 0.75);
      // Must have already called fakeAudio.play() synchronously BEFORE awaiting!
      expect(fakeAudio.play).toHaveBeenCalledTimes(2);
      expect(fakeAudio.muted).toBe(false);
      expect(fakeAudio.playbackRate).toBe(0.75);
      expect(fakeAudio.defaultPlaybackRate).toBe(0.75);
      expect(fakeAudio.preservesPitch).toBe(true);
      expect(fakeAudio.webkitPreservesPitch).toBe(true);
      expect(await playPromise).toBe(true);

      // retainOnly revokes evicted URL h2 while preserving h1
      player.retainOnly(new Set([h1]));
      expect(player.hasPreloaded(h1)).toBe(true);
      expect(player.hasPreloaded(h2)).toBe(false);
      expect(revokedUrls.length).toBe(1);

      player.stop();
      expect(fakeAudio.pause).toHaveBeenCalled();

      player.dispose();
      expect(player.hasPreloaded(h1)).toBe(false);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
      if (origNavDescriptor) {
        Object.defineProperty(globalThis, 'navigator', origNavDescriptor);
      }
    }
  });

  it('retries unlock on subsequent user gesture after initial NotAllowedError (iOS pointerdown -> click)', async () => {
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:silent');
    URL.revokeObjectURL = vi.fn();

    let callNum = 0;
    const fakeAudio = {
      preload: '',
      src: '',
      muted: false,
      currentTime: 0,
      defaultPlaybackRate: 1.0,
      playbackRate: 1.0,
      preservesPitch: false,
      play: vi.fn(() => {
        callNum += 1;
        if (callNum === 1) {
          return Promise.reject(new DOMException('NotAllowedError', 'NotAllowedError'));
        }
        return Promise.resolve();
      }),
      pause: vi.fn(),
    };

    try {
      const player = new WebAudioPlayer({
        createAudioElement: () => fakeAudio as unknown as HTMLAudioElement,
      });

      // 1st unlock (e.g. iOS pointerdown) rejects -> must NOT permanently lock out future unlocks
      player.unlock();
      await Promise.resolve();
      await Promise.resolve();
      expect(fakeAudio.play).toHaveBeenCalledTimes(1);
      expect(fakeAudio.muted).toBe(false);

      // 2nd unlock (e.g. click/touchend) retries and succeeds
      player.unlock();
      await Promise.resolve();
      await Promise.resolve();
      expect(fakeAudio.play).toHaveBeenCalledTimes(2);

      // 3rd unlock is now idempotent
      player.unlock();
      expect(fakeAudio.play).toHaveBeenCalledTimes(2);
      player.dispose();
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });
});

describe('WebDeviceSpeechPlayer (§7.1)', () => {
  it('enforces localService === true offline and prefers local voices online', () => {
    const spoken: Array<{
      text: string;
      lang: string;
      rate: number;
      voice?: SpeechSynthesisVoice;
    }> = [];

    class FakeUtterance {
      text: string;
      lang = '';
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }

    let voices: SpeechSynthesisVoice[] = [
      { name: 'Remote JA', lang: 'ja-JP', localService: false } as SpeechSynthesisVoice,
    ];

    const fakeSynth = {
      getVoices: () => voices,
      cancel: vi.fn(),
      speak: vi.fn((u: FakeUtterance) => {
        spoken.push({
          text: u.text,
          lang: u.lang,
          rate: u.rate,
          ...(u.voice ? { voice: u.voice } : {}),
        });
      }),
      addEventListener: vi.fn(),
    };

    const origWindow = (globalThis as Record<string, unknown>)['window'];
    const origUtterance = (globalThis as Record<string, unknown>)['SpeechSynthesisUtterance'];

    (globalThis as Record<string, unknown>)['window'] = { speechSynthesis: fakeSynth };
    (globalThis as Record<string, unknown>)['SpeechSynthesisUtterance'] = FakeUtterance;

    try {
      const player = new WebDeviceSpeechPlayer();
      expect(player.isAvailable()).toBe(true);

      // Offline with ONLY a remote voice -> missing_local_voice, MUST NOT speak!
      const offlineMiss = player.speak('食べます', 'ja', { isOnline: false, rate: 0.75 });
      expect(offlineMiss.status).toBe('missing_local_voice');
      expect(offlineMiss.lang).toBe('ja');
      expect(fakeSynth.speak).not.toHaveBeenCalled();

      // Online with remote voice -> speaks at 0.75x
      const onlineRemote = player.speak('食べます', 'ja', { isOnline: true, rate: 0.75 });
      expect(onlineRemote.status).toBe('spoken');
      expect(spoken[0]?.voice?.name).toBe('Remote JA');
      expect(spoken[0]?.rate).toBe(0.75);

      // Add local JA voice -> offline succeeds and online prefers local voice
      voices = [
        { name: 'Remote JA', lang: 'ja-JP', localService: false } as SpeechSynthesisVoice,
        { name: 'Local Kyoko', lang: 'ja-JP', localService: true } as SpeechSynthesisVoice,
      ];
      const offlineHit = player.speak('日本[にほん]', 'ja', { isOnline: false, rate: 1.0 });
      expect(offlineHit.status).toBe('spoken');
      expect(spoken[1]?.voice?.name).toBe('Local Kyoko');
      expect(spoken[1]?.text).toBe('日本');

      expect(
        getMissingVoiceInstructions('ko', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'),
      ).toContain('iOS');
      expect(getMissingVoiceInstructions('ja', 'Mozilla/5.0 (Linux; Android 15)')).toContain(
        'Android',
      );
    } finally {
      (globalThis as Record<string, unknown>)['window'] = origWindow;
      (globalThis as Record<string, unknown>)['SpeechSynthesisUtterance'] = origUtterance;
    }
  });
});

describe('BYO Cloud TTS Providers (Google & Azure)', () => {
  it('GoogleCloudTtsProvider posts expected JSON at 1.0x MP3, decodes base64, and redacts API key on errors', async () => {
    const sampleMp3B64 = Buffer.from(VALID_MP3_ID3_BYTES).toString('base64');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes('BAD_SECRET_KEY')) {
        return new Response(`API key BAD_SECRET_KEY invalid`, { status: 403 });
      }
      return new Response(JSON.stringify({ audioContent: sampleMp3B64 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const provider = new GoogleCloudTtsProvider({
      apiKey: 'AIzaTestSecretKey123',
      fetchImpl: fakeFetch,
    });

    const result = await provider.synthesize('안녕하세요', 'ko');
    expect(result.mime).toBe('audio/mpeg');
    expect(result.ext).toBe('mp3');
    expect(result.voiceId).toBe('google:ko-KR-Neural2-A');
    expect(result.bytes).toEqual(VALID_MP3_ID3_BYTES);

    const reqBody = JSON.parse(String(calls[0]?.init?.body)) as {
      input: { text: string };
      voice: { languageCode: string; name: string };
      audioConfig: { audioEncoding: string; speakingRate: number };
    };
    expect(reqBody.input.text).toBe('안녕하세요');
    expect(reqBody.voice).toEqual({ languageCode: 'ko-KR', name: 'ko-KR-Neural2-A' });
    expect(reqBody.audioConfig).toEqual({ audioEncoding: 'MP3', speakingRate: 1.0 });

    // Error redaction check
    const badProvider = new GoogleCloudTtsProvider({
      apiKey: 'BAD_SECRET_KEY',
      fetchImpl: fakeFetch,
    });
    await expect(badProvider.synthesize('hello', 'en')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof TtsProviderError &&
        !err.message.includes('BAD_SECRET_KEY') &&
        err.message.includes('[REDACTED]')
      );
    });
  });

  it('AzureSpeechTtsProvider validates region, escapes SSML XML, and redacts subscription key', async () => {
    expect(
      () => new AzureSpeechTtsProvider({ apiKey: 'sub-key', region: 'eastus.evil.com/path' }),
    ).toThrow(TtsProviderError);

    expect(escapeSsmlXml(`A & B <tag> "q" 'a'`)).toBe(
      'A &amp; B &lt;tag&gt; &quot;q&quot; &apos;a&apos;',
    );

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      const headers = new Headers(init?.headers);
      if (headers.get('Ocp-Apim-Subscription-Key') === 'AZURE_SECRET_999') {
        return new Response('Denied for AZURE_SECRET_999', { status: 401 });
      }
      return new Response(VALID_MP3_SYNC_BYTES, { status: 200 });
    };

    const provider = new AzureSpeechTtsProvider({
      apiKey: 'azure-ok-key',
      region: 'koreacentral',
      fetchImpl: fakeFetch,
    });

    const res = await provider.synthesize('A & B <test>', 'ko');
    expect(res.voiceId).toBe('azure:ko-KR-SunHiNeural');
    expect(res.bytes).toEqual(VALID_MP3_SYNC_BYTES);
    expect(calls[0]?.url).toBe(
      'https://koreacentral.tts.speech.microsoft.com/cognitiveservices/v1',
    );
    expect(String(calls[0]?.init?.body)).toContain('A &amp; B &lt;test&gt;');

    const badProvider = new AzureSpeechTtsProvider({
      apiKey: 'AZURE_SECRET_999',
      region: 'eastus',
      fetchImpl: fakeFetch,
    });
    await expect(badProvider.synthesize('hi', 'en')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof TtsProviderError &&
        !err.message.includes('AZURE_SECRET_999') &&
        err.message.includes('[REDACTED]')
      );
    });
  });
});

describe('Audio processor magic-byte validation (§13)', () => {
  it('sniffs MP3 (ID3 & sync), WAV, OGG, M4A and rejects spoofed HTML/SVG/text', async () => {
    expect(sniffAudioMime(VALID_MP3_ID3_BYTES)).toBe('audio/mpeg');
    expect(sniffAudioMime(VALID_MP3_SYNC_BYTES)).toBe('audio/mpeg');
    expect(sniffAudioMime(VALID_WAV_BYTES)).toBe('audio/wav');
    expect(sniffAudioMime(VALID_OGG_BYTES)).toBe('audio/ogg');
    expect(sniffAudioMime(VALID_M4A_BYTES)).toBe('audio/mp4');

    const spoofedHtml = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const spoofedSvg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    expect(sniffAudioMime(spoofedHtml)).toBeNull();
    expect(sniffAudioMime(spoofedSvg)).toBeNull();

    expect(() => resolveValidatedAudioMime('audio/mpeg', spoofedHtml)).toThrow(AudioProcessError);
    expect(() => resolveValidatedAudioMime('text/html', VALID_WAV_BYTES)).toThrow(
      AudioProcessError,
    );

    const processed = await processAudioBytes(VALID_WAV_BYTES, 'audio/x-wav');
    expect(processed.mime).toBe('audio/wav');
    expect(processed.ext).toBe('wav');
    expect(processed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(processed.size).toBe(VALID_WAV_BYTES.byteLength);

    await expect(processAudioBytes(new Uint8Array(0), 'audio/mpeg')).rejects.toThrow(
      AudioProcessError,
    );
    await expect(processAudioBytes(VALID_WAV_BYTES, 'audio/wav', { maxBytes: 10 })).rejects.toThrow(
      AudioProcessError,
    );

    // Generic/CDN binary & alias MIME types succeed when magic bytes match valid audio
    expect(resolveValidatedAudioMime('application/octet-stream', VALID_MP3_ID3_BYTES)).toEqual({
      mime: 'audio/mpeg',
      ext: 'mp3',
    });
    expect(resolveValidatedAudioMime('video/mp4', VALID_M4A_BYTES)).toEqual({
      mime: 'audio/mp4',
      ext: 'm4a',
    });
    expect(resolveValidatedAudioMime('application/ogg', VALID_OGG_BYTES)).toEqual({
      mime: 'audio/ogg',
      ext: 'ogg',
    });
    // Spoofed octet-stream HTML is still rejected via magic bytes
    expect(() => resolveValidatedAudioMime('application/octet-stream', spoofedHtml)).toThrow(
      AudioProcessError,
    );

    // AVIF & HEIC still images also have `ftyp` at offset 4 and MUST be rejected as audio
    const fakeAvif = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    ]);
    const fakeHeic = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(sniffAudioMime(fakeAvif)).toBeNull();
    expect(sniffAudioMime(fakeHeic)).toBeNull();
    await expect(processAudioBytes(fakeAvif, '')).rejects.toThrow(AudioProcessError);
  });
});
