import { normalizeAudioLang, normalizeTtsText, toBcp47SpeechTag } from '@flash/core/audio';
import type { DeviceSpeechPlayer, DeviceSpeechResult, DeviceVoiceInfo } from '@flash/platform';

/** Bridge contract for the native Android `AndroidTts` Capacitor plugin. */
export interface NativeTtsPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  getVoices(): Promise<{ voices: DeviceVoiceInfo[] }>;
  speak(opts: { text: string; lang: string; rate?: number; voiceName?: string }): Promise<void>;
  stop(): Promise<void>;
  addListener?(
    eventName: 'voicesChanged',
    listener: (event: { available?: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const LANG_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ja: 'Japanese',
  'zh-Hans': 'Mandarin Chinese (Simplified)',
  'zh-Hant': 'Mandarin Chinese (Traditional)',
  ko: 'Korean',
  en: 'English',
};

function missingAndroidVoiceMessage(normLang: string): string {
  const label = LANG_DISPLAY_NAMES[normLang] ?? normLang;
  return `No offline ${label} voice found. On Android, open Settings → System → Languages & input → Text-to-speech output → Speech Services by Google → Install voice data → ${label}.`;
}

function voiceMatchesLanguage(voiceLangRaw: string, targetCanonical: string): boolean {
  const v = voiceLangRaw.trim().toLowerCase().replace(/_/g, '-');
  if (!v) return false;

  if (targetCanonical === 'zh-Hant') {
    return (
      v === 'zh-tw' || v === 'zh-hk' || v === 'zh-mo' || v === 'zh-hant' || v.startsWith('zh-hant-')
    );
  }
  if (targetCanonical === 'zh-Hans') {
    return (
      v === 'zh' ||
      v === 'zh-cn' ||
      v === 'zh-sg' ||
      v === 'zh-hans' ||
      v.startsWith('zh-hans-') ||
      v === 'cmn-cn' ||
      v === 'cmn-hans-cn'
    );
  }

  const targetBcp47 = toBcp47SpeechTag(targetCanonical).toLowerCase();
  const primary = targetBcp47.split('-')[0] ?? targetBcp47;
  return v === targetBcp47 || v === primary || v.startsWith(`${primary}-`);
}

function pickBestVoice(
  voices: readonly DeviceVoiceInfo[],
  targetCanonical: string,
): DeviceVoiceInfo | undefined {
  if (voices.length === 0) return undefined;
  const targetBcp47 = toBcp47SpeechTag(targetCanonical).toLowerCase();
  const exact = voices.find((v) => v.lang.trim().toLowerCase().replace(/_/g, '-') === targetBcp47);
  return exact ?? voices[0];
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1.0;
  return Math.max(0.5, Math.min(2.0, rate));
}

/**
 * Native Android `TextToSpeech` adapter implementing `DeviceSpeechPlayer` (§7.1).
 * Preloads engine availability and installed voices asynchronously and caches them so the
 * synchronous `DeviceSpeechPlayer` contract works smoothly without blocking the UI thread.
 */
export class CapacitorDeviceSpeechPlayer implements DeviceSpeechPlayer {
  private readonly plugin: NativeTtsPlugin;
  private available = false;
  private voices: DeviceVoiceInfo[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(plugin: NativeTtsPlugin) {
    this.plugin = plugin;
    void this.refresh();
    if (plugin.addListener) {
      void plugin
        .addListener('voicesChanged', () => {
          void this.refresh();
        })
        .catch(() => undefined);
    }
  }

  /** Refreshes cached availability and voice list from the native TTS engine. */
  async refresh(): Promise<void> {
    try {
      const avail = await this.plugin.isAvailable();
      this.available = Boolean(avail.available);
      if (this.available) {
        const res = await this.plugin.getVoices();
        this.voices = Array.isArray(res.voices) ? res.voices : [];
      } else {
        this.voices = [];
      }
    } catch {
      this.available = false;
      this.voices = [];
    }
    for (const listener of this.listeners) listener();
  }

  isAvailable(): boolean {
    return this.available;
  }

  listVoices(langFilter?: string): DeviceVoiceInfo[] {
    const normFilter = langFilter ? normalizeAudioLang(langFilter) : null;
    const filtered = normFilter
      ? this.voices.filter((v) => voiceMatchesLanguage(v.lang, normFilter))
      : this.voices;
    return filtered.map((v) => ({
      name: v.name,
      lang: v.lang,
      localService: Boolean(v.localService),
      ...(v.default !== undefined ? { default: v.default } : {}),
    }));
  }

  onVoicesChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  speak(
    text: string,
    lang: string,
    opts?: { rate?: number; isOnline?: boolean },
  ): DeviceSpeechResult {
    const normLang = normalizeAudioLang(lang);
    const bcp47 = toBcp47SpeechTag(normLang);

    if (!this.available) {
      return {
        status: 'unavailable',
        lang: normLang,
        message: 'Android Text-to-Speech engine is unavailable on this device.',
      };
    }

    const cleaned = normalizeTtsText(text);
    if (!cleaned) {
      return {
        status: 'error',
        lang: normLang,
        message: 'No speakable text provided.',
      };
    }

    const isOnline = opts?.isOnline ?? true;
    const matching = this.voices.filter((v) => voiceMatchesLanguage(v.lang, normLang));
    const localMatching = matching.filter((v) => v.localService === true);

    let chosenVoice: DeviceVoiceInfo | undefined;
    if (!isOnline) {
      // §7.1: Offline uses ONLY local voices (never network-required voices).
      chosenVoice = pickBestVoice(localMatching, normLang);
      if (!chosenVoice) {
        return {
          status: 'missing_local_voice',
          lang: normLang,
          message: missingAndroidVoiceMessage(normLang),
        };
      }
    } else {
      chosenVoice = pickBestVoice(localMatching, normLang) ?? pickBestVoice(matching, normLang);
    }

    void this.plugin
      .speak({
        text: cleaned,
        lang: bcp47,
        rate: clampRate(opts?.rate ?? 1.0),
        ...(chosenVoice ? { voiceName: chosenVoice.name } : {}),
      })
      .catch(() => undefined);

    return { status: 'spoken', lang: normLang };
  }

  stop(): void {
    if (!this.available) return;
    void this.plugin.stop().catch(() => undefined);
  }
}
