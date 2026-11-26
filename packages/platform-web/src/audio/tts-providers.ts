import { normalizeAudioLang, resolveCanonicalVoiceId } from '@flash/core/audio';
import type {
  AbortSignalLike,
  TtsProvider,
  TtsProviderConfig,
  TtsSynthesisResult,
} from '@flash/platform';

export class TtsProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TtsProviderError';
    if (status !== undefined) {
      this.status = status;
    }
  }
}

const AZURE_REGION_RE = /^[a-z0-9-]{2,32}$/i;

function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  let out = text.split(secret).join('[REDACTED]');
  const encoded = encodeURIComponent(secret);
  if (encoded && encoded !== secret) {
    out = out.split(encoded).join('[REDACTED]');
  }
  return out;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/\s+/g, '');
  if (!cleaned) return new Uint8Array(0);
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function escapeSsmlXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface GoogleCloudTtsOptions {
  apiKey: string;
  voices?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * BYO Google Cloud Text-to-Speech provider (§7.1).
 * Always synthesizes online at 1.0x MP3 so clips can be cached in IndexedDB and synced across devices.
 */
export class GoogleCloudTtsProvider implements TtsProvider {
  readonly id = 'google';
  private readonly apiKey: string;
  private readonly voices: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleCloudTtsOptions) {
    const key = options.apiKey.trim();
    if (!key) {
      throw new TtsProviderError('Google Cloud TTS API key is required.');
    }
    this.apiKey = key;
    this.voices = { ...(options.voices ?? {}) };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  resolveVoiceId(lang: string, voiceOverride?: string): string {
    const norm = normalizeAudioLang(lang);
    const effectiveOverride = voiceOverride ?? this.voices[norm];
    return resolveCanonicalVoiceId('google', norm, effectiveOverride).canonicalVoiceId;
  }

  async synthesize(
    text: string,
    lang: string,
    opts?: { voiceOverride?: string; signal?: AbortSignalLike },
  ): Promise<TtsSynthesisResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new TtsProviderError('Cannot synthesize empty text.');
    }

    const norm = normalizeAudioLang(lang);
    const resolved = resolveCanonicalVoiceId(
      'google',
      norm,
      opts?.voiceOverride ?? this.voices[norm],
    );

    // The key goes in a header, not `?key=`, so it stays out of URLs and request logs (S11).
    const endpoint = 'https://texttospeech.googleapis.com/v1/text:synthesize';
    const body = {
      input: { text: trimmed },
      voice: resolved.voiceName
        ? { languageCode: resolved.languageCode, name: resolved.voiceName }
        : { languageCode: resolved.languageCode },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 1.0,
      },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey },
        body: JSON.stringify(body),
        ...(opts?.signal ? { signal: opts.signal as AbortSignal } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TtsProviderError(
        `Google Cloud TTS network error: ${redactSecret(msg, this.apiKey)}`,
      );
    }

    if (!res.ok) {
      let detail = '';
      try {
        const errText = await res.text();
        if (errText) {
          detail = `: ${redactSecret(errText.slice(0, 240), this.apiKey)}`;
        }
      } catch {
        // Ignore body read errors
      }
      throw new TtsProviderError(
        `Google Cloud TTS request failed (${res.status})${detail}`,
        res.status,
      );
    }

    let payload: { audioContent?: unknown };
    try {
      payload = (await res.json()) as { audioContent?: unknown };
    } catch {
      throw new TtsProviderError('Google Cloud TTS returned invalid JSON.');
    }

    if (typeof payload.audioContent !== 'string' || !payload.audioContent.trim()) {
      throw new TtsProviderError('Google Cloud TTS returned empty audioContent.');
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64ToBytes(payload.audioContent);
    } catch {
      throw new TtsProviderError('Google Cloud TTS returned malformed base64 audioContent.');
    }

    if (bytes.byteLength === 0) {
      throw new TtsProviderError('Google Cloud TTS decoded 0 bytes of audio.');
    }

    return {
      bytes,
      mime: 'audio/mpeg',
      ext: 'mp3',
      voiceId: resolved.canonicalVoiceId,
    };
  }
}

export interface AzureSpeechTtsOptions {
  apiKey: string;
  region: string;
  voices?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * BYO Azure AI Speech TTS provider (§7.1).
 * Validates Azure region strictly to prevent host injection and escapes SSML XML entities.
 */
export class AzureSpeechTtsProvider implements TtsProvider {
  readonly id = 'azure';
  private readonly apiKey: string;
  private readonly region: string;
  private readonly voices: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AzureSpeechTtsOptions) {
    const key = options.apiKey.trim();
    const region = options.region.trim().toLowerCase();
    if (!key) {
      throw new TtsProviderError('Azure AI Speech subscription key is required.');
    }
    if (!AZURE_REGION_RE.test(region)) {
      throw new TtsProviderError(
        `Invalid Azure region "${options.region}". Expected a region slug like "eastus" or "koreacentral".`,
      );
    }
    this.apiKey = key;
    this.region = region;
    this.voices = { ...(options.voices ?? {}) };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  resolveVoiceId(lang: string, voiceOverride?: string): string {
    const norm = normalizeAudioLang(lang);
    const effectiveOverride = voiceOverride ?? this.voices[norm];
    return resolveCanonicalVoiceId('azure', norm, effectiveOverride).canonicalVoiceId;
  }

  async synthesize(
    text: string,
    lang: string,
    opts?: { voiceOverride?: string; signal?: AbortSignalLike },
  ): Promise<TtsSynthesisResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new TtsProviderError('Cannot synthesize empty text.');
    }

    const norm = normalizeAudioLang(lang);
    const resolved = resolveCanonicalVoiceId(
      'azure',
      norm,
      opts?.voiceOverride ?? this.voices[norm],
    );

    const voiceName = resolved.voiceName || resolved.languageCode;
    const ssml = `<speak version="1.0" xml:lang="${escapeSsmlXml(resolved.languageCode)}"><voice name="${escapeSsmlXml(voiceName)}">${escapeSsmlXml(trimmed)}</voice></speak>`;
    const endpoint = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.apiKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        },
        body: ssml,
        ...(opts?.signal ? { signal: opts.signal as AbortSignal } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TtsProviderError(
        `Azure Speech TTS network error: ${redactSecret(msg, this.apiKey)}`,
      );
    }

    if (!res.ok) {
      let detail = '';
      try {
        const errText = await res.text();
        if (errText) {
          detail = `: ${redactSecret(errText.slice(0, 240), this.apiKey)}`;
        }
      } catch {
        // Ignore
      }
      throw new TtsProviderError(
        `Azure Speech TTS request failed (${res.status})${detail}`,
        res.status,
      );
    }

    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) {
      throw new TtsProviderError('Azure Speech TTS returned empty audio body.');
    }

    return {
      bytes,
      mime: 'audio/mpeg',
      ext: 'mp3',
      voiceId: resolved.canonicalVoiceId,
    };
  }
}

export function createWebTtsProvider(config: TtsProviderConfig): TtsProvider | null {
  if (config.provider === 'none') return null;
  const apiKey = config.apiKey?.trim() ?? '';
  if (!apiKey) return null;

  if (config.provider === 'google') {
    return new GoogleCloudTtsProvider({
      apiKey,
      ...(config.voices ? { voices: config.voices } : {}),
    });
  }
  if (config.provider === 'azure') {
    const region = config.azureRegion?.trim() ?? '';
    if (!region) return null;
    return new AzureSpeechTtsProvider({
      apiKey,
      region,
      ...(config.voices ? { voices: config.voices } : {}),
    });
  }
  return null;
}
