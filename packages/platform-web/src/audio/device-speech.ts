import { normalizeAudioLang, normalizeTtsText, toBcp47SpeechTag } from '@flash/core/audio';
import type { DeviceSpeechPlayer, DeviceSpeechResult, DeviceVoiceInfo } from '@flash/platform';

const LANG_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ja: 'Japanese',
  'zh-Hans': 'Mandarin Chinese (Simplified)',
  'zh-Hant': 'Mandarin Chinese (Traditional)',
  ko: 'Korean',
  en: 'English',
};

/**
 * Returns concise, platform-specific instructions for installing an offline OS speech voice pack (§7.1).
 */
export function getMissingVoiceInstructions(
  lang: string,
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): string {
  const norm = normalizeAudioLang(lang);
  const label = LANG_DISPLAY_NAMES[norm] ?? norm;
  const ua = userAgent.toLowerCase();

  if (/iphone|ipad|ipod/.test(ua)) {
    return `No offline ${label} voice found. On iOS, open Settings → Accessibility → Spoken Content → Voices → ${label} and download a voice for offline playback.`;
  }
  if (/android/.test(ua)) {
    return `No offline ${label} voice found. On Android, open Settings → System → Languages & input → Text-to-speech output → Speech Services by Google → Install voice data → ${label}.`;
  }
  if (/mac os x|macintosh/.test(ua)) {
    return `No offline ${label} voice found. On macOS, open System Settings → Accessibility → Spoken Content → System Voice → Manage Voices and download a ${label} voice.`;
  }
  if (/windows/.test(ua)) {
    return `No offline ${label} voice found. On Windows, open Settings → Time & language → Speech → Manage voices → Add voices and install ${label}.`;
  }
  return `No offline ${label} voice is installed on this device. Install a ${label} text-to-speech voice pack in your OS Accessibility / Language settings for offline playback.`;
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
  voices: readonly SpeechSynthesisVoice[],
  targetCanonical: string,
): SpeechSynthesisVoice | undefined {
  if (voices.length === 0) return undefined;
  const targetBcp47 = toBcp47SpeechTag(targetCanonical).toLowerCase();
  const exact = voices.find((v) => v.lang.trim().toLowerCase().replace(/_/g, '-') === targetBcp47);
  if (exact) return exact;
  return voices[0];
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1.0;
  return Math.max(0.5, Math.min(2.0, rate));
}

/**
 * Web `speechSynthesis` adapter enforcing strict offline `localService === true` voices (§7.1).
 */
export class WebDeviceSpeechPlayer implements DeviceSpeechPlayer {
  private cachedVoices: SpeechSynthesisVoice[] = [];
  private subscribed = false;

  private ensureSubscribed(): void {
    if (this.subscribed || !this.isAvailable()) return;
    this.subscribed = true;
    const synth = window.speechSynthesis;
    const refresh = () => {
      try {
        this.cachedVoices = synth.getVoices();
      } catch {
        this.cachedVoices = [];
      }
    };
    refresh();
    try {
      if (typeof synth.addEventListener === 'function') {
        synth.addEventListener('voiceschanged', refresh);
      } else {
        synth.onvoiceschanged = refresh;
      }
    } catch {
      // Ignore restricted environments
    }
  }

  private getRawVoices(): SpeechSynthesisVoice[] {
    if (!this.isAvailable()) return [];
    this.ensureSubscribed();
    try {
      const live = window.speechSynthesis.getVoices();
      if (live && live.length > 0) {
        this.cachedVoices = live;
        return live;
      }
    } catch {
      // Fall back to cached
    }
    return this.cachedVoices;
  }

  isAvailable(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.speechSynthesis !== 'undefined' &&
      typeof SpeechSynthesisUtterance !== 'undefined'
    );
  }

  listVoices(langFilter?: string): DeviceVoiceInfo[] {
    const raw = this.getRawVoices();
    const normFilter = langFilter ? normalizeAudioLang(langFilter) : null;
    const filtered = normFilter ? raw.filter((v) => voiceMatchesLanguage(v.lang, normFilter)) : raw;
    return filtered.map((v) => ({
      name: v.name,
      lang: v.lang,
      localService: Boolean(v.localService),
      ...(v.default !== undefined ? { default: v.default } : {}),
    }));
  }

  speak(
    text: string,
    lang: string,
    opts?: { rate?: number; isOnline?: boolean },
  ): DeviceSpeechResult {
    const normLang = normalizeAudioLang(lang);
    const bcp47 = toBcp47SpeechTag(normLang);

    if (!this.isAvailable()) {
      return {
        status: 'unavailable',
        lang: normLang,
        message: 'Device speech synthesis is unavailable in this browser.',
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

    const isOnline =
      opts?.isOnline ??
      (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
        ? navigator.onLine
        : true);

    const allVoices = this.getRawVoices();
    const matchingVoices = allVoices.filter((v) => voiceMatchesLanguage(v.lang, normLang));
    const localMatching = matchingVoices.filter((v) => v.localService === true);

    let chosenVoice: SpeechSynthesisVoice | undefined;
    if (!isOnline) {
      // §7.1: Offline uses ONLY `localService === true` voices
      chosenVoice = pickBestVoice(localMatching, normLang);
      if (!chosenVoice) {
        return {
          status: 'missing_local_voice',
          lang: normLang,
          message: getMissingVoiceInstructions(normLang),
        };
      }
    } else {
      // Online: prefer localService voice, fall back to network voice or browser default
      chosenVoice =
        pickBestVoice(localMatching, normLang) ?? pickBestVoice(matchingVoices, normLang);
    }

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(cleaned);
      utterance.lang = bcp47;
      utterance.rate = clampRate(opts?.rate ?? 1.0);
      if (chosenVoice) {
        utterance.voice = chosenVoice;
      }
      window.speechSynthesis.speak(utterance);
      return { status: 'spoken', lang: normLang };
    } catch (err) {
      return {
        status: 'error',
        lang: normLang,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  stop(): void {
    if (!this.isAvailable()) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore restricted context errors
    }
  }
}
