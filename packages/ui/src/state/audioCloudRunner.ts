import {
  computeTtsCacheKey,
  normalizeAudioLang,
  normalizeTtsText,
  resolveCanonicalVoiceId,
  sha256Hex,
  toBcp47SpeechTag,
  type CardAudioTarget,
  type CollectionState,
} from '@flash/core';
import type {
  AudioPlayer,
  PlatformServices,
  ProcessedAudio,
  TtsProvider,
  TtsProviderConfig,
} from '@flash/platform';
import type { MutableRefObject } from 'react';
import type { AudioSpeakResult, TtsVoiceTestOverride } from './useAudioController.ts';

const TEST_PHRASES_BY_LANG: Readonly<Record<string, string>> = {
  ja: 'こんにちは、日本語のテストです。',
  'zh-Hans': '你好，这是中文语音测试。',
  'zh-Hant': '你好，這是中文語音測試。',
  ko: '안녕하세요, 한국어 음성 테스트입니다.',
  en: 'Hello, this is a voice test.',
};

export interface CloudTtsSynthParams {
  platform: PlatformServices;
  player: AudioPlayer;
  stateRef: MutableRefObject<CollectionState>;
  providerCacheRef: MutableRefObject<{ signature: string; provider: TtsProvider } | null>;
  inFlightTtsRef: MutableRefObject<
    Map<string, Promise<{ audio: ProcessedAudio | null; warning?: string }>>
  >;
  cfg: TtsProviderConfig;
  target: CardAudioTarget;
  ttsLangKey: string;
  override?: TtsVoiceTestOverride;
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

export async function runCloudTtsSynthesis(
  params: CloudTtsSynthParams,
): Promise<{ audio: ProcessedAudio | null; warning?: string }> {
  const {
    platform,
    player,
    stateRef,
    providerCacheRef,
    inFlightTtsRef,
    cfg,
    target,
    ttsLangKey,
    override,
    addMedia,
  } = params;

  const createTtsProvider = platform.createTtsProvider;
  if (!createTtsProvider) return { audio: null };

  const normLang = normalizeAudioLang(target.lang);
  const voiceOverride =
    override !== undefined
      ? override.voiceOverride?.trim() || undefined
      : stateRef.current.preferences.tts_voices?.[normLang];
  const voice = resolveCanonicalVoiceId(
    cfg.provider as 'google' | 'azure',
    normLang,
    voiceOverride,
  );
  const ttsKey = computeTtsCacheKey(target.normalizedText, voice.canonicalVoiceId);

  const getOrCreateProvider = async (): Promise<TtsProvider | null> => {
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
    const created = await createTtsProvider({
      ...cfg,
      ...(voices ? { voices } : {}),
    });
    if (created) {
      providerCacheRef.current = { signature: sig, provider: created };
    }
    return created;
  };

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
        : await getOrCreateProvider();
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

  return pending;
}

export async function runTestTtsVoice(
  lang: string,
  speakTargetInternal: (
    target: CardAudioTarget,
    rate?: number,
    override?: TtsVoiceTestOverride,
  ) => Promise<AudioSpeakResult>,
  draftOverride?: TtsVoiceTestOverride,
): Promise<{ ok: boolean; source: string; message: string }> {
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
  // No banner setter: Settings shows the warning in its own message, not on the study banner.
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
}
