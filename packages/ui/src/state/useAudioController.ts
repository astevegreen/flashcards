import {
  computeTtsCacheKey,
  computeTtsLangCacheKey,
  normalizeAudioLang,
  normalizeTtsText,
  resolveCanonicalVoiceId,
  resolveCardAudioTarget,
  sha256Hex,
  toBcp47SpeechTag,
  type Card,
  type CardAudioTarget,
  type CollectionState,
  type Deck,
  type Layout,
  type Note,
  type NoteType,
} from '@flash/core';
import type {
  PlatformServices,
  ProcessedAudio,
  TtsProvider,
  TtsProviderConfig,
} from '@flash/platform';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

export const TTS_CONFIG_KV_KEY = 'tts_config_v1';
export const MISSING_VOICE_PROMPTED_KV_PREFIX = 'missing_voice_prompted:';

const TEST_PHRASES_BY_LANG: Readonly<Record<string, string>> = {
  ja: 'こんにちは、日本語のテストです。',
  'zh-Hans': '你好，这是中文语音测试。',
  'zh-Hant': '你好，這是中文語音測試。',
  ko: '안녕하세요, 한국어 음성 테스트입니다.',
  en: 'Hello, this is a voice test.',
};

export interface MissingVoicePromptState {
  lang: string;
  message: string;
}

export interface AudioSpeakResult {
  source: 'attached' | 'cached_tts' | 'cloud_tts' | 'device_tts' | 'none';
  played: boolean;
  missingLocalVoice?: boolean;
  warning?: string;
}

export interface TtsVoiceTestOverride {
  config: TtsProviderConfig;
  voiceOverride?: string;
}

export interface AudioController {
  ttsConfig: TtsProviderConfig;
  ttsConfigLoaded: boolean;
  missingVoicePrompt: MissingVoicePromptState | null;
  lastAudioWarning: string | null;
  saveTtsConfig: (config: TtsProviderConfig) => Promise<void>;
  clearTtsKey: () => Promise<void>;
  resetLocalState: () => void;
  dismissMissingVoicePrompt: () => Promise<void>;
  dismissAudioWarning: () => void;
  unlock: () => void;
  stop: () => void;
  playMediaHash: (hash: string, rate?: number) => Promise<boolean>;
  speakTarget: (target: CardAudioTarget, rate?: number) => Promise<AudioSpeakResult>;
  speakCard: (
    card: Card,
    note: Note,
    layout: Layout,
    noteType: NoteType | undefined,
    deck: Deck,
    rate?: number,
  ) => Promise<AudioSpeakResult>;
  speakText: (rawText: string, lang: string, rate?: number) => Promise<AudioSpeakResult>;
  preloadCards: (cards: readonly Card[]) => void;
  testTtsVoice: (
    lang: string,
    draftOverride?: TtsVoiceTestOverride,
  ) => Promise<{ ok: boolean; source: string; message: string }>;
  canPlayAnyAudio: (target?: CardAudioTarget) => boolean;
}

export interface UseAudioControllerOptions {
  platform: PlatformServices;
  stateRef: MutableRefObject<CollectionState>;
  addMedia: (media: {
    hash: string;
    ext: string;
    mime: string;
    size: number;
    bytes: Uint8Array;
    tts_key?: string;
    tts_lang_key?: string;
  }) => Promise<void>;
}

function isNavigatorOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
    ? true
    : navigator.onLine;
}

function isCloudTtsConfigured(cfg: TtsProviderConfig): boolean {
  if (cfg.provider === 'google') {
    return Boolean(cfg.apiKey?.trim());
  }
  if (cfg.provider === 'azure') {
    return Boolean(cfg.apiKey?.trim() && cfg.azureRegion?.trim());
  }
  return false;
}

function sanitizeStoredConfig(raw: unknown): TtsProviderConfig {
  if (!raw || typeof raw !== 'object') {
    return { provider: 'none' };
  }
  const obj = raw as Record<string, unknown>;
  const provider =
    obj['provider'] === 'google' || obj['provider'] === 'azure' ? obj['provider'] : 'none';
  const apiKey = typeof obj['apiKey'] === 'string' ? obj['apiKey'] : undefined;
  const azureRegion = typeof obj['azureRegion'] === 'string' ? obj['azureRegion'] : undefined;
  return {
    provider,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(azureRegion !== undefined ? { azureRegion } : {}),
  };
}

export function useAudioController({
  platform,
  stateRef,
  addMedia,
}: UseAudioControllerOptions): AudioController {
  const [ttsConfig, setTtsConfig] = useState<TtsProviderConfig>({ provider: 'none' });
  const [ttsConfigLoaded, setTtsConfigLoaded] = useState(false);
  const [missingVoicePrompt, setMissingVoicePrompt] = useState<MissingVoicePromptState | null>(
    null,
  );
  const [lastAudioWarning, setLastAudioWarning] = useState<string | null>(null);

  const ttsConfigRef = useRef<TtsProviderConfig>({ provider: 'none' });
  const missingVoicePromptRef = useRef<MissingVoicePromptState | null>(null);
  const providerCacheRef = useRef<{ signature: string; provider: TtsProvider } | null>(null);
  const requestIdRef = useRef(0);
  const inFlightTtsRef = useRef<
    Map<string, Promise<{ audio: ProcessedAudio | null; warning?: string }>>
  >(new Map());
  const dismissedLangsRef = useRef<Set<string>>(new Set());
  const preloadKeepHashesRef = useRef<Set<string>>(new Set());

  // Load device-local BYO Cloud TTS config from IndexedDB KV (never synced)
  useEffect(() => {
    let cancelled = false;
    void platform.storage
      .getKv<unknown>(TTS_CONFIG_KV_KEY)
      .then((saved) => {
        if (cancelled) return;
        const parsed = sanitizeStoredConfig(saved);
        ttsConfigRef.current = parsed;
        setTtsConfig(parsed);
        setTtsConfigLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setTtsConfigLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [platform.storage]);

  // Dispose audio player resources on provider unmount
  useEffect(() => {
    return () => {
      platform.audioPlayer?.stop();
      platform.deviceSpeech?.stop();
    };
  }, [platform.audioPlayer, platform.deviceSpeech]);

  const saveTtsConfig = useCallback(
    async (config: TtsProviderConfig) => {
      const cleaned: TtsProviderConfig = {
        provider: config.provider,
        ...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}),
        ...(config.azureRegion?.trim()
          ? { azureRegion: config.azureRegion.trim().toLowerCase() }
          : {}),
      };
      ttsConfigRef.current = cleaned;
      providerCacheRef.current = null;
      setTtsConfig(cleaned);
      setLastAudioWarning(null);
      await platform.storage.setKv(TTS_CONFIG_KV_KEY, cleaned);
    },
    [platform.storage],
  );

  const clearTtsKey = useCallback(async () => {
    const next: TtsProviderConfig = { provider: 'none' };
    ttsConfigRef.current = next;
    providerCacheRef.current = null;
    setTtsConfig(next);
    setLastAudioWarning(null);
    await platform.storage.deleteKv(TTS_CONFIG_KV_KEY);
  }, [platform.storage]);

  const resetLocalState = useCallback(() => {
    requestIdRef.current += 1;
    platform.audioPlayer?.stop();
    platform.audioPlayer?.retainOnly(new Set());
    platform.deviceSpeech?.stop();
    const next: TtsProviderConfig = { provider: 'none' };
    ttsConfigRef.current = next;
    providerCacheRef.current = null;
    inFlightTtsRef.current.clear();
    dismissedLangsRef.current.clear();
    preloadKeepHashesRef.current = new Set();
    missingVoicePromptRef.current = null;
    setTtsConfig(next);
    setMissingVoicePrompt(null);
    setLastAudioWarning(null);
  }, [platform.audioPlayer, platform.deviceSpeech]);

  const dismissMissingVoicePrompt = useCallback(async () => {
    const current = missingVoicePromptRef.current;
    if (!current) {
      setMissingVoicePrompt(null);
      return;
    }
    dismissedLangsRef.current.add(current.lang);
    try {
      await platform.storage.setKv(`${MISSING_VOICE_PROMPTED_KV_PREFIX}${current.lang}`, true);
    } finally {
      if (missingVoicePromptRef.current?.lang === current.lang) {
        missingVoicePromptRef.current = null;
      }
      setMissingVoicePrompt(null);
    }
  }, [platform.storage]);

  const dismissAudioWarning = useCallback(() => {
    setLastAudioWarning(null);
  }, []);

  const unlock = useCallback(() => {
    platform.audioPlayer?.unlock();
  }, [platform.audioPlayer]);

  const stop = useCallback(() => {
    requestIdRef.current += 1;
    platform.audioPlayer?.stop();
    platform.deviceSpeech?.stop();
  }, [platform.audioPlayer, platform.deviceSpeech]);

  const resolveCachedTtsHash = useCallback(
    (
      normalizedText: string,
      lang: string,
      override?: TtsVoiceTestOverride,
    ): { hash?: string; exactKey?: string; langKey: string } => {
      const st = stateRef.current;
      const cfg = override?.config ?? ttsConfigRef.current;
      const normLang = normalizeAudioLang(lang);
      const langKey = computeTtsLangCacheKey(normalizedText, normLang);
      const cloudConfigured = isCloudTtsConfigured(cfg);
      const voiceOverride =
        override !== undefined
          ? override.voiceOverride?.trim() || undefined
          : st.preferences.tts_voices?.[normLang];

      if (cfg.provider === 'google' || cfg.provider === 'azure') {
        const voice = resolveCanonicalVoiceId(cfg.provider, normLang, voiceOverride);
        const exactKey = computeTtsCacheKey(normalizedText, voice.canonicalVoiceId);
        const exactHash = st.ttsMediaByKey.get(exactKey);
        if (exactHash) {
          return { hash: exactHash, exactKey, langKey };
        }
        // Only fall back to language-level cache when offline or without an active API key
        // so switching voices online generates a fresh clip for the new voice (§7.1).
        if (!cloudConfigured || !isNavigatorOnline()) {
          const langHash = st.ttsMediaByLangKey.get(langKey);
          if (langHash) {
            return { hash: langHash, exactKey, langKey };
          }
        }
        return { exactKey, langKey };
      }

      // No BYO cloud provider configured: check language-level synced neural TTS cache first
      const langHash = st.ttsMediaByLangKey.get(langKey);
      return langHash ? { hash: langHash, langKey } : { langKey };
    },
    [stateRef],
  );

  const playMediaHash = useCallback(
    async (hash: string, rate = 1.0): Promise<boolean> => {
      const normHash = hash.trim().toLowerCase();
      const player = platform.audioPlayer;
      if (!normHash || !player) return false;

      platform.deviceSpeech?.stop();
      const reqId = ++requestIdRef.current;

      // Synchronous RAM hit (zero await — preserves iOS Safari user gesture)
      if (player.hasPreloaded(normHash)) {
        return player.playPreloaded(normHash, rate);
      }

      const blob = await platform.storage.getMedia(normHash);
      if (requestIdRef.current !== reqId || !blob) return false;
      player.preload(normHash, blob.bytes, blob.mime);
      return player.playPreloaded(normHash, rate);
    },
    [platform.audioPlayer, platform.deviceSpeech, platform.storage],
  );

  const getOrCreateTtsProvider = useCallback(async (): Promise<TtsProvider | null> => {
    const cfg = ttsConfigRef.current;
    if (!isCloudTtsConfigured(cfg) || !platform.createTtsProvider) return null;
    const voices = stateRef.current.preferences.tts_voices;
    const sig = JSON.stringify([
      cfg.provider,
      cfg.apiKey ?? '',
      cfg.azureRegion ?? '',
      voices ?? {},
    ]);
    if (providerCacheRef.current && providerCacheRef.current.signature === sig) {
      return providerCacheRef.current.provider;
    }
    const created = await platform.createTtsProvider({
      ...cfg,
      ...(voices ? { voices } : {}),
    });
    if (created) {
      providerCacheRef.current = { signature: sig, provider: created };
    }
    return created;
  }, [platform, stateRef]);

  const speakTargetInternal = useCallback(
    async (
      target: CardAudioTarget,
      rate = 1.0,
      override?: TtsVoiceTestOverride,
    ): Promise<AudioSpeakResult> => {
      const player = platform.audioPlayer;
      const reqId = ++requestIdRef.current;
      const isStale = () => requestIdRef.current !== reqId;

      platform.deviceSpeech?.stop();

      const playBlobHash = async (hash: string): Promise<boolean> => {
        if (!player) return false;
        const normHash = hash.toLowerCase();
        if (player.hasPreloaded(normHash)) {
          return player.playPreloaded(normHash, rate);
        }
        player.stop();
        const blob = await platform.storage.getMedia(normHash);
        if (isStale() || !blob) return false;
        player.preload(normHash, blob.bytes, blob.mime);
        return player.playPreloaded(normHash, rate);
      };

      // Step 1: Attached note audio (`media:<sha256>`)
      if (target.attachedMediaHash && player) {
        const ok = await playBlobHash(target.attachedMediaHash);
        if (isStale()) return { source: 'none', played: false };
        if (ok) return { source: 'attached', played: true };
      }

      if (!target.normalizedText) {
        player?.stop();
        return { source: 'none', played: false };
      }

      // Step 2: Cached TTS clip (exact voice key, or language fallback on key-less/offline devices)
      const cached = resolveCachedTtsHash(target.normalizedText, target.lang, override);
      if (cached.hash && player) {
        const ok = await playBlobHash(cached.hash);
        if (isStale()) return { source: 'none', played: false };
        if (ok) return { source: 'cached_tts', played: true };
      }

      // Stop any previously playing HTMLAudioElement before slow Cloud TTS or Step 4 Device TTS
      player?.stop();

      // Step 3: BYO Cloud TTS (Google Cloud TTS / Azure AI Speech), synthesized online at 1.0x
      let cloudWarning: string | undefined;
      const cfg = override?.config ?? ttsConfigRef.current;
      const normLang = normalizeAudioLang(target.lang);
      const ttsLangKey = cached.langKey;

      const createTtsProvider = platform.createTtsProvider;
      if (
        (cfg.provider === 'google' || cfg.provider === 'azure') &&
        isCloudTtsConfigured(cfg) &&
        isNavigatorOnline() &&
        createTtsProvider &&
        player
      ) {
        const voiceOverride =
          override !== undefined
            ? override.voiceOverride?.trim() || undefined
            : stateRef.current.preferences.tts_voices?.[normLang];
        const voice = resolveCanonicalVoiceId(cfg.provider, normLang, voiceOverride);
        const ttsKey = computeTtsCacheKey(target.normalizedText, voice.canonicalVoiceId);

        const synthesizeOnce = async (): Promise<{
          audio: ProcessedAudio | null;
          warning?: string;
        }> => {
          try {
            const provider = override
              ? await createTtsProvider({
                  ...cfg,
                  ...(voiceOverride ? { voices: { [normLang]: voiceOverride } } : {}),
                })
              : await getOrCreateTtsProvider();
            if (!provider) return { audio: null };
            const synth = await provider.synthesize(target.normalizedText, normLang, {
              ...(voiceOverride ? { voiceOverride } : {}),
            });
            const hash = sha256Hex(synth.bytes);
            await addMedia({
              hash,
              ext: synth.ext,
              mime: synth.mime,
              size: synth.bytes.byteLength,
              bytes: synth.bytes,
              tts_key: ttsKey,
              tts_lang_key: ttsLangKey,
            });
            player.preload(hash, synth.bytes, synth.mime);
            return {
              audio: {
                hash,
                ext: synth.ext,
                mime: synth.mime,
                size: synth.bytes.byteLength,
                bytes: synth.bytes,
              },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const warning = `Cloud TTS failed — falling back (${msg})`;
            setLastAudioWarning(warning);
            return { audio: null, warning };
          }
        };

        let pending = override ? undefined : inFlightTtsRef.current.get(ttsKey);
        if (!pending) {
          pending = synthesizeOnce();
          if (!override) {
            inFlightTtsRef.current.set(ttsKey, pending);
            void pending.finally(() => {
              if (inFlightTtsRef.current.get(ttsKey) === pending) {
                inFlightTtsRef.current.delete(ttsKey);
              }
            });
          }
        }

        const synthRes = await pending;
        if (synthRes.warning) {
          cloudWarning = synthRes.warning;
        }
        if (isStale()) return { source: 'none', played: false };
        if (synthRes.audio) {
          const ok = await player.playPreloaded(synthRes.audio.hash, rate);
          if (ok) {
            setLastAudioWarning(null);
            return { source: 'cloud_tts', played: true };
          }
        } else if (!override) {
          // Online Cloud TTS failed after a voice switch: prefer an existing synced neural clip
          // from `ttsMediaByLangKey` over degrading straight to device speechSynthesis.
          const fallbackHash = stateRef.current.ttsMediaByLangKey.get(ttsLangKey);
          if (fallbackHash && fallbackHash !== cached.hash) {
            const ok = await playBlobHash(fallbackHash);
            if (isStale()) return { source: 'none', played: false };
            if (ok) {
              return {
                source: 'cached_tts',
                played: true,
                ...(cloudWarning ? { warning: cloudWarning } : {}),
              };
            }
          }
        }
      }

      // Step 4: Device TTS (`speechSynthesis`) — strictly `localService === true` when offline
      if (isStale()) return { source: 'none', played: false };
      if (!platform.deviceSpeech) {
        return {
          source: 'none',
          played: false,
          ...(cloudWarning ? { warning: cloudWarning } : {}),
        };
      }

      const speechRes = platform.deviceSpeech.speak(target.normalizedText, target.lang, {
        rate,
        isOnline: isNavigatorOnline(),
      });

      if (speechRes.status === 'spoken') {
        return {
          source: 'device_tts',
          played: true,
          ...(cloudWarning ? { warning: cloudWarning } : {}),
        };
      }

      if (speechRes.status === 'missing_local_voice') {
        const missingLang = speechRes.lang;
        if (!dismissedLangsRef.current.has(missingLang)) {
          const alreadyPrompted = await platform.storage.getKv<boolean>(
            `${MISSING_VOICE_PROMPTED_KV_PREFIX}${missingLang}`,
          );
          if (alreadyPrompted) {
            dismissedLangsRef.current.add(missingLang);
          } else if (!isStale()) {
            const nextPrompt: MissingVoicePromptState = {
              lang: missingLang,
              message:
                speechRes.message ??
                `No offline voice installed for "${missingLang}". Install a local voice pack in OS settings.`,
            };
            missingVoicePromptRef.current = nextPrompt;
            setMissingVoicePrompt(nextPrompt);
          }
        }
        return {
          source: 'none',
          played: false,
          missingLocalVoice: true,
          ...(cloudWarning ? { warning: cloudWarning } : {}),
        };
      }

      return {
        source: 'none',
        played: false,
        ...(cloudWarning ? { warning: cloudWarning } : {}),
      };
    },
    [
      addMedia,
      getOrCreateTtsProvider,
      platform.audioPlayer,
      platform.createTtsProvider,
      platform.deviceSpeech,
      platform.storage,
      resolveCachedTtsHash,
      stateRef,
    ],
  );

  const speakTarget = useCallback(
    (target: CardAudioTarget, rate = 1.0): Promise<AudioSpeakResult> =>
      speakTargetInternal(target, rate),
    [speakTargetInternal],
  );

  const speakCard = useCallback(
    async (
      _card: Card,
      note: Note,
      layout: Layout,
      noteType: NoteType | undefined,
      deck: Deck,
      rate = 1.0,
    ): Promise<AudioSpeakResult> => {
      const target = resolveCardAudioTarget(note, layout, noteType, deck);
      return speakTarget(target, rate);
    },
    [speakTarget],
  );

  const speakText = useCallback(
    async (rawText: string, lang: string, rate = 1.0): Promise<AudioSpeakResult> => {
      const normLang = normalizeAudioLang(lang);
      const target: CardAudioTarget = {
        rawText,
        normalizedText: normalizeTtsText(rawText),
        lang: normLang,
        bcp47Lang: toBcp47SpeechTag(normLang),
      };
      return speakTarget(target, rate);
    },
    [speakTarget],
  );

  /**
   * 2–3 card RAM lookahead preloader (§7.2): keeps `ObjectURL`s for the current card + next 3 cards
   * warmed in RAM so auto-play on card flip/advance fires synchronously with zero IndexedDB latency.
   */
  const preloadCards = useCallback(
    (cards: readonly Card[]) => {
      const player = platform.audioPlayer;
      if (!player) return;

      const st = stateRef.current;
      const keepHashes = new Set<string>();
      const windowCards = cards.slice(0, 4);

      for (const card of windowCards) {
        const note = st.notes.get(card.note_id);
        const deck = st.decks.get(card.deck_id);
        const layout = st.layouts.get(card.layout_id);
        if (!note || !deck || !layout) continue;
        const noteType = st.noteTypes.get(deck.note_type_id);
        const target = resolveCardAudioTarget(note, layout, noteType, deck);

        if (target.attachedMediaHash) {
          keepHashes.add(target.attachedMediaHash);
        } else if (target.normalizedText) {
          const cached = resolveCachedTtsHash(target.normalizedText, target.lang);
          if (cached.hash) {
            keepHashes.add(cached.hash);
          }
        }
      }

      preloadKeepHashesRef.current = keepHashes;
      player.retainOnly(keepHashes);

      for (const hash of keepHashes) {
        if (player.hasPreloaded(hash)) continue;
        void platform.storage
          .getMedia(hash)
          .then((blob) => {
            if (blob && preloadKeepHashesRef.current.has(hash)) {
              player.preload(hash, blob.bytes, blob.mime);
            }
          })
          .catch(() => {
            // Ignore transient IndexedDB read errors during background lookahead
          });
      }
    },
    [platform.audioPlayer, platform.storage, resolveCachedTtsHash, stateRef],
  );

  const testTtsVoice = useCallback(
    async (
      lang: string,
      draftOverride?: TtsVoiceTestOverride,
    ): Promise<{ ok: boolean; source: string; message: string }> => {
      unlock();
      const normLang = normalizeAudioLang(lang);
      const phrase = TEST_PHRASES_BY_LANG[normLang] ?? TEST_PHRASES_BY_LANG['en'] ?? 'Voice test';

      if (draftOverride) {
        const { provider, apiKey, azureRegion } = draftOverride.config;
        if (provider === 'google' && !apiKey?.trim()) {
          return { ok: false, source: 'none', message: 'Enter a Google Cloud TTS API key first.' };
        }
        if (provider === 'azure') {
          if (!apiKey?.trim()) {
            return {
              ok: false,
              source: 'none',
              message: 'Enter an Azure Speech subscription key first.',
            };
          }
          if (!/^[a-z0-9-]{2,32}$/i.test((azureRegion ?? '').trim())) {
            return {
              ok: false,
              source: 'none',
              message: 'Enter a valid Azure region (e.g. eastus or koreacentral).',
            };
          }
        }
      }

      const target: CardAudioTarget = {
        rawText: phrase,
        normalizedText: normalizeTtsText(phrase),
        lang: normLang,
        bcp47Lang: toBcp47SpeechTag(normLang),
      };
      const result = await speakTargetInternal(target, 1.0, draftOverride);
      if (result.played) {
        const label =
          result.source === 'cloud_tts'
            ? 'Cloud TTS (newly cached & synced)'
            : result.source === 'cached_tts'
              ? 'Cached TTS clip (offline)'
              : result.source === 'attached'
                ? 'Attached audio'
                : 'Device speech synthesis';
        return {
          ok: true,
          source: result.source,
          message: result.warning
            ? `Played "${phrase}" via ${label}. (${result.warning})`
            : `Played "${phrase}" via ${label}.`,
        };
      }
      return {
        ok: false,
        source: result.source,
        message:
          result.warning ??
          (result.missingLocalVoice
            ? `No offline voice pack installed for ${normLang}.`
            : 'Audio playback was blocked or unavailable in this browser.'),
      };
    },
    [speakTargetInternal, unlock],
  );

  const canPlayAnyAudio = useCallback(
    (target?: CardAudioTarget): boolean => {
      const st = stateRef.current;
      if (target?.attachedMediaHash && st.media.has(target.attachedMediaHash)) {
        return true;
      }
      if (target?.normalizedText) {
        const cached = resolveCachedTtsHash(target.normalizedText, target.lang);
        if (cached.hash) return true;
      }
      if (isCloudTtsConfigured(ttsConfigRef.current) && isNavigatorOnline()) {
        return true;
      }
      if (platform.deviceSpeech?.isAvailable()) {
        return true;
      }
      return false;
    },
    [platform.deviceSpeech, resolveCachedTtsHash, stateRef],
  );

  return useMemo(
    () => ({
      ttsConfig,
      ttsConfigLoaded,
      missingVoicePrompt,
      lastAudioWarning,
      saveTtsConfig,
      clearTtsKey,
      resetLocalState,
      dismissMissingVoicePrompt,
      dismissAudioWarning,
      unlock,
      stop,
      playMediaHash,
      speakTarget,
      speakCard,
      speakText,
      preloadCards,
      testTtsVoice,
      canPlayAnyAudio,
    }),
    [
      ttsConfig,
      ttsConfigLoaded,
      missingVoicePrompt,
      lastAudioWarning,
      saveTtsConfig,
      clearTtsKey,
      resetLocalState,
      dismissMissingVoicePrompt,
      dismissAudioWarning,
      unlock,
      stop,
      playMediaHash,
      speakTarget,
      speakCard,
      speakText,
      preloadCards,
      testTtsVoice,
      canPlayAnyAudio,
    ],
  );
}
