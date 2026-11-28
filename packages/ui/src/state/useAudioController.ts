import {
  computeTtsCacheKey,
  computeTtsLangCacheKey,
  normalizeAudioLang,
  normalizeTtsText,
  resolveCanonicalVoiceId,
  resolveCardAudioTarget,
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
import { isNavigatorOnline } from './syncShell.ts';

export const TTS_CONFIG_KV_KEY = 'tts_config_v1';
const MISSING_VOICE_PROMPTED_KV_PREFIX = 'missing_voice_prompted:';

interface MissingVoicePromptState {
  lang: string;
  message: string;
}

export interface AudioSpeakResult {
  source: 'attached' | 'cached_tts' | 'cloud_tts' | 'device_tts' | 'none';
  played: boolean;
  missingLocalVoice?: boolean;
  warning?: string | undefined;
}

export interface TtsVoiceTestOverride {
  config: TtsProviderConfig;
  voiceOverride?: string;
}

export interface AudioController {
  ttsConfig: TtsProviderConfig;
  ttsConfigLoaded: boolean;
  missingVoicePrompt: MissingVoicePromptState | null;
  /** The last study-card cloud TTS failure; speakText callers get theirs in the result. */
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

export function isCloudTtsConfigured(cfg: TtsProviderConfig): boolean {
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
      // Without a provider factory cloud TTS can't run here, so a clip in another voice must do.
      const cloudConfigured = isCloudTtsConfigured(cfg) && !!platform.createTtsProvider;
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
        if (!cloudConfigured || !isNavigatorOnline()) {
          const langHash = st.ttsMediaByLangKey.get(langKey);
          if (langHash) {
            return { hash: langHash, exactKey, langKey };
          }
        }
        return { exactKey, langKey };
      }

      const langHash = st.ttsMediaByLangKey.get(langKey);
      return langHash ? { hash: langHash, langKey } : { langKey };
    },
    [platform.createTtsProvider, stateRef],
  );

  const playMediaHash = useCallback(
    async (hash: string, rate = 1.0): Promise<boolean> => {
      const normHash = hash.trim().toLowerCase();
      const player = platform.audioPlayer;
      if (!normHash || !player) return false;

      platform.deviceSpeech?.stop();
      const reqId = ++requestIdRef.current;

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

  const speakTargetInternal = useCallback(
    async (
      target: CardAudioTarget,
      rate = 1.0,
      override?: TtsVoiceTestOverride,
      // Only study cards pass the banner's setter; every other caller reads its result's warning.
      report?: (warning: string | null) => void,
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

      // Step 2: Cached TTS clip
      const cached = resolveCachedTtsHash(target.normalizedText, target.lang, override);
      if (cached.hash && player) {
        const ok = await playBlobHash(cached.hash);
        if (isStale()) return { source: 'none', played: false };
        if (ok) return { source: 'cached_tts', played: true };
      }

      player?.stop();

      // Step 3: BYO Cloud TTS (lazy-loaded runner)
      let cloudWarning: string | undefined;
      const cfg = override?.config ?? ttsConfigRef.current;
      const ttsLangKey = cached.langKey;

      if (
        (cfg.provider === 'google' || cfg.provider === 'azure') &&
        isCloudTtsConfigured(cfg) &&
        isNavigatorOnline() &&
        platform.createTtsProvider &&
        player
      ) {
        const { runCloudTtsSynthesis } = await import('./audioCloudRunner.ts');
        const synthRes = await runCloudTtsSynthesis({
          platform,
          player,
          stateRef,
          providerCacheRef,
          inFlightTtsRef,
          cfg,
          target,
          ttsLangKey,
          ...(override !== undefined ? { override } : {}),
          addMedia,
        });
        cloudWarning = synthRes.warning;
        if (isStale()) return { source: 'none', played: false };
        if (cloudWarning) report?.(cloudWarning);
        if (synthRes.audio) {
          const ok = await player.playPreloaded(synthRes.audio.hash, rate);
          if (ok) {
            report?.(null);
            return { source: 'cloud_tts', played: true };
          }
        } else if (!override) {
          const fallbackHash = stateRef.current.ttsMediaByLangKey.get(ttsLangKey);
          if (fallbackHash && fallbackHash !== cached.hash) {
            const ok = await playBlobHash(fallbackHash);
            if (isStale()) return { source: 'none', played: false };
            if (ok) {
              return {
                source: 'cached_tts',
                played: true,
                warning: cloudWarning,
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
          warning: cloudWarning,
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
          warning: cloudWarning,
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
          warning: cloudWarning,
        };
      }

      const speechWarning =
        speechRes.status === 'unavailable' || speechRes.status === 'error'
          ? speechRes.message
          : undefined;
      const warning = cloudWarning ?? speechWarning;
      return {
        source: 'none',
        played: false,
        warning,
      };
    },
    [addMedia, platform, resolveCachedTtsHash, stateRef],
  );

  const speakTarget = useCallback(
    (target: CardAudioTarget, rate = 1.0): Promise<AudioSpeakResult> =>
      speakTargetInternal(target, rate, undefined, setLastAudioWarning),
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
      return speakTargetInternal(target, rate);
    },
    [speakTargetInternal],
  );

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
          .catch(() => {});
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
      const { runTestTtsVoice } = await import('./audioCloudRunner.ts');
      return runTestTtsVoice(lang, speakTargetInternal, draftOverride);
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
