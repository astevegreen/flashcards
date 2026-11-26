import { noteTypeForDeck } from '../model/deck-note-type.ts';
import { noteField } from '../model/note-fields.ts';
import type { Deck, Layout, Note, NoteType, RubyDisplay, SpeakTiming } from '../model/types.ts';
import { stripCloze } from '../parsers/cloze.ts';
import { stripRichText } from '../parsers/rich-text.ts';
import { stripRuby } from '../parsers/ruby.ts';
import { sha256Hex, sha256String } from '../sources/hash.ts';

export { sha256Hex };

export type CloudTtsProviderId = 'google' | 'azure';

export const DEFAULT_GOOGLE_VOICES: Readonly<Record<string, string>> = {
  ja: 'ja-JP-Neural2-B',
  'zh-Hans': 'cmn-CN-Wavenet-A',
  'zh-Hant': 'cmn-TW-Wavenet-A',
  ko: 'ko-KR-Neural2-A',
  en: 'en-US-Neural2-F',
};

export const DEFAULT_AZURE_VOICES: Readonly<Record<string, string>> = {
  ja: 'ja-JP-NanamiNeural',
  'zh-Hans': 'zh-CN-XiaoxiaoNeural',
  'zh-Hant': 'zh-TW-HsiaoChenNeural',
  ko: 'ko-KR-SunHiNeural',
  en: 'en-US-JennyNeural',
};

const MEDIA_URI_RE = /^media:([0-9a-f]{64})$/i;

/**
 * Validates and extracts a lowercase 64-character SHA-256 hex digest from a `media:<sha256>` URI.
 */
export function parseMediaHashUri(value: string | undefined): string | null {
  if (!value) return null;
  const match = MEDIA_URI_RE.exec(value.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * Canonicalizes language codes into stable app language keys (`ja`, `zh-Hans`, `zh-Hant`, `ko`, `en`).
 */
export function normalizeAudioLang(lang: string): string {
  const trimmed = lang.trim();
  if (!trimmed) return 'en';
  const lower = trimmed.toLowerCase().replace(/_/g, '-');

  if (lower === 'ja' || lower.startsWith('ja-')) return 'ja';
  if (lower === 'ko' || lower.startsWith('ko-')) return 'ko';
  if (
    lower === 'zh-hant' ||
    lower.startsWith('zh-hant-') ||
    lower === 'zh-tw' ||
    lower === 'zh-hk' ||
    lower === 'zh-mo' ||
    lower === 'cmn-tw' ||
    lower === 'cmn-hant'
  ) {
    return 'zh-Hant';
  }
  if (
    lower === 'zh' ||
    lower === 'zh-hans' ||
    lower.startsWith('zh-hans-') ||
    lower === 'zh-cn' ||
    lower === 'zh-sg' ||
    lower.startsWith('zh-latn') ||
    lower.startsWith('cmn-') ||
    lower === 'cmn'
  ) {
    return 'zh-Hans';
  }
  if (lower === 'en' || lower.startsWith('en-')) return 'en';

  return trimmed;
}

/**
 * Maps an app or raw language code to a canonical BCP 47 speech tag (`ja-JP`, `zh-CN`, `zh-TW`, `ko-KR`, `en-US`).
 */
export function toBcp47SpeechTag(lang: string): string {
  const canonical = normalizeAudioLang(lang);
  switch (canonical) {
    case 'ja':
      return 'ja-JP';
    case 'zh-Hans':
      return 'zh-CN';
    case 'zh-Hant':
      return 'zh-TW';
    case 'ko':
      return 'ko-KR';
    case 'en':
      return 'en-US';
    default:
      return canonical || 'en-US';
  }
}

/**
 * Normalizes raw note/page text for deterministic TTS synthesis & cache keying (§7.1).
 * Strips bold/italic/colour markup (`{b:...}`), cloze markers (`{{c1::...}}`) and inline ruby readings (`漢字[かんじ]`, `{今日|きょう}`),
 * applies NFKC normalization, and collapses whitespace. A layout with `ruby_display: 'readings'`
 * speaks the readings instead of the bases.
 */
export function normalizeTtsText(rawText: string, rubyDisplay?: RubyDisplay): string {
  if (!rawText) return '';
  return stripRuby(stripCloze(stripRichText(rawText)), rubyDisplay)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic TTS clip cache key (§7.1): `sha256(normalized_text + '\0' + canonical_voice_id)`.
 */
export function computeTtsCacheKey(normalizedText: string, voiceId: string): string {
  return sha256String(`${normalizedText}\0${voiceId.trim()}`);
}

/**
 * Secondary language-level TTS cache key: `sha256(normalized_text + '\0' + normalized_lang)`
 * so secondary devices without a BYO cloud API key still hit synced neural clips offline.
 */
export function computeTtsLangCacheKey(normalizedText: string, lang: string): string {
  return sha256String(`${normalizedText}\0${normalizeAudioLang(lang)}`);
}

export interface ResolvedCloudVoice {
  provider: CloudTtsProviderId;
  lang: string;
  languageCode: string;
  voiceName: string;
  canonicalVoiceId: string;
}

/**
 * Resolves the concrete provider voice name, BCP 47 `languageCode`, and canonical `<provider>:<voice>`
 * cache-key voice ID for Google Cloud TTS or Azure AI Speech.
 */
export function resolveCanonicalVoiceId(
  provider: CloudTtsProviderId,
  lang: string,
  override?: string,
): ResolvedCloudVoice {
  const normLang = normalizeAudioLang(lang);
  const defaults = provider === 'google' ? DEFAULT_GOOGLE_VOICES : DEFAULT_AZURE_VOICES;

  let voiceName = (override ?? '').trim();
  const prefix = `${provider}:`;
  if (voiceName.toLowerCase().startsWith(prefix)) {
    voiceName = voiceName.slice(prefix.length).trim();
  }
  if (!voiceName) {
    voiceName = defaults[normLang] ?? '';
  }

  let languageCode = toBcp47SpeechTag(normLang);
  if (voiceName) {
    // Derive API languageCode from voice prefix when present (e.g. `cmn-CN-Wavenet-A` -> `cmn-CN`, `en-GB-Neural2-A` -> `en-GB`)
    const voiceLangMatch = /^([a-z]{2,3}-[A-Z]{2})(?=-|$)/.exec(voiceName);
    if (voiceLangMatch?.[1]) {
      languageCode = voiceLangMatch[1];
    }
  } else if (provider === 'google' && normLang === 'zh-Hans') {
    languageCode = 'cmn-CN';
  } else if (provider === 'google' && normLang === 'zh-Hant') {
    languageCode = 'cmn-TW';
  }

  const canonicalVoiceId = voiceName ? `${provider}:${voiceName}` : `${provider}:${languageCode}`;
  return {
    provider,
    lang: normLang,
    languageCode,
    voiceName,
    canonicalVoiceId,
  };
}

export interface CardAudioTarget {
  /** Attached `media:<sha256>` hash on the note's audio field (Resolution Step 1). */
  attachedMediaHash?: string;
  /** Raw text selected for TTS (Resolution Steps 2–4). */
  rawText: string;
  /** Normalized text ready for TTS cache key computation & synthesis. */
  normalizedText: string;
  /** Canonical app language (`ja`, `zh-Hans`, `zh-Hant`, `ko`, `en`, ...). */
  lang: string;
  /** BCP 47 speech tag (`ja-JP`, `zh-CN`, `zh-TW`, `ko-KR`, `en-US`, ...). */
  bcp47Lang: string;
  /** Field key that supplied the TTS text (or `'speech_override'`). */
  sourceField?: string;
}

/**
 * Resolves a study card's audio target per blueprint §7.1:
 * 1. First populated `kind === 'audio'` field (or `note.fields['audio']`) containing a valid `media:<sha256>` URI.
 * 2. TTS text priority: `note.fields['speech_override']` → `layout.speak_field` → first `tts: true` field → `layout.front_fields[0]`.
 * 3. Language derived from the chosen field's `lang` (for `speech_override`, falls back to `speak_field` lang → first `tts` field lang → `deck.language`).
 */
export function resolveCardAudioTarget(
  note: Note,
  layout: Layout,
  deckNoteType: NoteType | undefined,
  deck: Deck,
): CardAudioTarget {
  const noteType = deckNoteType ? noteTypeForDeck(deckNoteType, deck.language) : undefined;
  // 1. Check attached audio fields (`kind === 'audio'` or fallback `'audio'` key)
  let attachedMediaHash: string | undefined;
  if (noteType) {
    for (const field of noteType.fields) {
      if (field.kind !== 'audio') continue;
      const hash = parseMediaHashUri(noteField(note, field.key));
      if (hash) {
        attachedMediaHash = hash;
        break;
      }
    }
  }
  if (!attachedMediaHash) {
    const fallbackHash = parseMediaHashUri(noteField(note, 'audio'));
    if (fallbackHash) {
      attachedMediaHash = fallbackHash;
    }
  }

  const fieldByKey = new Map<string, { lang: string; kind: string; tts?: boolean }>();
  if (noteType) {
    for (const f of noteType.fields) {
      fieldByKey.set(f.key, {
        lang: f.lang,
        kind: f.kind,
        ...(f.tts !== undefined ? { tts: f.tts } : {}),
      });
    }
  }

  const pickUsableText = (key: string | undefined): string => {
    if (!key) return '';
    const val = noteField(note, key)?.trim() ?? '';
    if (!val) return '';
    // Never pass raw `media:<sha256>` URIs into TTS engines
    if (parseMediaHashUri(val)) return '';
    return val;
  };

  let rawText = '';
  let sourceField: string | undefined;
  let chosenLang: string | undefined;

  const overrideVal = pickUsableText('speech_override');
  if (overrideVal) {
    rawText = overrideVal;
    sourceField = 'speech_override';
    const speakFieldLang = layout.speak_field
      ? fieldByKey.get(layout.speak_field)?.lang
      : undefined;
    const firstTtsLang = noteType?.fields.find((f) => f.tts)?.lang;
    chosenLang = speakFieldLang ?? firstTtsLang ?? deck.language;
  } else {
    const candidateKeys: string[] = [];
    if (layout.speak_field) candidateKeys.push(layout.speak_field);
    if (noteType) {
      for (const f of noteType.fields) {
        if (f.tts && !candidateKeys.includes(f.key)) {
          candidateKeys.push(f.key);
        }
      }
    }
    const firstFront = layout.front_fields[0];
    if (firstFront && !candidateKeys.includes(firstFront)) {
      candidateKeys.push(firstFront);
    }

    for (const key of candidateKeys) {
      const val = pickUsableText(key);
      if (val) {
        rawText = val;
        sourceField = key;
        const fieldMeta = fieldByKey.get(key);
        // Avoid passing phonetic transcription tags like `zh-Latn-pinyin` as speech lang if deck has a speech lang
        if (fieldMeta?.lang && !fieldMeta.lang.toLowerCase().includes('-latn')) {
          chosenLang = fieldMeta.lang;
        } else {
          chosenLang = deck.language;
        }
        break;
      }
    }
  }

  const normalizedText = normalizeTtsText(rawText, layout.ruby_display);
  const lang = normalizeAudioLang(chosenLang ?? deck.language);
  const bcp47Lang = toBcp47SpeechTag(lang);

  return {
    ...(attachedMediaHash !== undefined ? { attachedMediaHash } : {}),
    rawText,
    normalizedText,
    lang,
    bcp47Lang,
    ...(sourceField !== undefined ? { sourceField } : {}),
  };
}

/**
 * Resolves when a layout should auto-speak (when auto-play is enabled, or always for `listen` mode).
 */
export function resolveLayoutSpeakTiming(layout: Layout): SpeakTiming {
  if (layout.answer_mode === 'listen') {
    return 'front';
  }
  if (layout.speak_on) {
    return layout.speak_on;
  }
  if (!layout.speak_field) {
    return 'front';
  }
  if (layout.front_fields.includes(layout.speak_field)) {
    return 'front';
  }
  if (layout.speak_field === 'reading' && layout.front_fields.includes('word')) {
    return 'front';
  }
  if (layout.speak_field === 'eumhun' && layout.front_fields.includes('character')) {
    return 'front';
  }
  return 'reveal';
}
