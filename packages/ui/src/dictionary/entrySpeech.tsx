/**
 * The dictionary's speaker button (§6.3, §7.1). It speaks the headword through the same chain as
 * study cards (`audio.speakText`: cached clip, the user's own cloud TTS, then device speech), so no
 * dictionary audio files are used. Part of the lazy dictionary chunk.
 */
import { computeTtsLangCacheKey, normalizeAudioLang, normalizeTtsText } from '@flash/core';
import type { DeviceSpeechPlayer } from '@flash/platform';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { isNavigatorOnline } from '../state/syncShell.ts';
import { isCloudTtsConfigured } from '../state/useAudioController.ts';

/** Offline, only a voice installed on the device counts (§7.1), as in device speech itself. */
function hasDeviceVoice(
  speech: DeviceSpeechPlayer | undefined,
  lang: string,
  online: boolean,
): boolean {
  if (!speech?.isAvailable()) return false;
  return speech.listVoices(lang).some((voice) => online || voice.localService);
}

/**
 * Answers "can `text` be spoken in `lang` right now?": a cached clip, cloud TTS while online, or a
 * device voice for the language. Re-renders when the OS voice list or the network changes.
 */
export function useCanSpeak(langs: readonly string[]): (text: string, lang: string) => boolean {
  const { platform, state, audio } = useApp();
  const speech = platform.deviceSpeech;

  const subscribe = useCallback(
    (onChange: () => void) => {
      const offVoices = speech?.onVoicesChanged?.(onChange);
      globalThis.addEventListener?.('online', onChange);
      globalThis.addEventListener?.('offline', onChange);
      return () => {
        offVoices?.();
        globalThis.removeEventListener?.('online', onChange);
        globalThis.removeEventListener?.('offline', onChange);
      };
    },
    [speech],
  );
  // One string, so React can tell whether anything changed: network, then the languages with a voice.
  const snapshot = useSyncExternalStore(subscribe, () => {
    const online = isNavigatorOnline();
    const voiced = langs.filter((lang) => hasDeviceVoice(speech, lang, online));
    return [online ? 'online' : 'offline', ...voiced].join(' ');
  });
  const [network, ...voicedLangs] = snapshot.split(' ');
  const cloud =
    network === 'online' &&
    Boolean(platform.createTtsProvider) &&
    isCloudTtsConfigured(audio.ttsConfig);

  return (text, lang) => {
    const spoken = normalizeTtsText(text);
    if (!spoken) return false;
    if (voicedLangs.includes(lang)) return true;
    // Cloud audio and cached clips play through the audio player.
    if (!platform.audioPlayer) return false;
    return (
      cloud || state.ttsMediaByLangKey.has(computeTtsLangCacheKey(spoken, normalizeAudioLang(lang)))
    );
  };
}

/**
 * The dictionary's own speech warning, kept apart from the study banner's lastAudioWarning so a
 * failure in one never shows in the other. Module state: every speaker button writes it and the
 * panel's one SpeechWarning reads it.
 */
let speechWarning: string | null = null;
/** Bumped by each press and by closing the panel, so only the latest press's result counts. */
let latestPress = 0;
const warningListeners = new Set<() => void>();

function setSpeechWarning(next: string | null): void {
  if (speechWarning === next) return;
  speechWarning = next;
  for (const listener of warningListeners) listener();
}

function subscribeWarning(onChange: () => void): () => void {
  warningListeners.add(onChange);
  return () => warningListeners.delete(onChange);
}

export function EntrySpeakerButton({
  headword,
  lang,
}: Readonly<{ headword: string; lang: string }>) {
  const { audio } = useApp();
  return (
    <button
      type="button"
      data-testid={`dict-speak-${headword}`}
      aria-label={`Play pronunciation of ${headword}`}
      title="Play pronunciation"
      onClick={() => {
        audio.unlock();
        const press = ++latestPress;
        void audio.speakText(headword, lang).then((result) => {
          if (press === latestPress) setSpeechWarning(result.warning ?? null);
        });
      }}
      className="inline-flex min-h-9 min-w-9 select-none items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-sm hover:border-[var(--accent)] active:scale-95"
    >
      <span aria-hidden="true">🔊</span>
    </button>
  );
}

/** Why the last press fell back or stayed silent (a cloud TTS failure, say), so it says so. */
export function SpeechWarning() {
  const warning = useSyncExternalStore(subscribeWarning, () => speechWarning);
  // A warning belongs to the panel it came from; closing the panel drops it.
  useEffect(
    () => () => {
      latestPress += 1;
      setSpeechWarning(null);
    },
    [],
  );
  if (!warning) return null;
  return (
    <output
      data-testid="dict-audio-warning"
      className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-xs text-[var(--muted)]"
    >
      <span className="min-w-0 flex-1 break-words">{warning}</span>
      <button
        type="button"
        onClick={() => setSpeechWarning(null)}
        className="font-semibold underline"
      >
        Dismiss
      </button>
    </output>
  );
}
