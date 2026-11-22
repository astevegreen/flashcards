import { readFileSync, writeFileSync } from 'node:fs';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  encodeUtf8,
  getEnabledLayoutsForDeck,
  type KnownEvent,
} from '@flash/core';
import {
  computeTtsCacheKey,
  computeTtsLangCacheKey,
  normalizeAudioLang,
  resolveCanonicalVoiceId,
  resolveCardAudioTarget,
  sha256Hex,
  type CloudTtsProviderId,
} from '@flash/core/audio';
import { exportFlashpkg, importFlashpkg } from '@flash/core/flashpkg';

export type AudioProviderKind = CloudTtsProviderId | 'mock';

export interface SynthesizedClip {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  voiceId: string;
}

export type AudioSynthesizeFn = (input: {
  text: string;
  lang: string;
  bcp47Lang: string;
  provider: AudioProviderKind;
  apiKey?: string;
  azureRegion?: string;
  voiceOverride?: string;
}) => Promise<SynthesizedClip>;

export interface EnrichPackageAudioOptions {
  provider: AudioProviderKind;
  apiKey?: string;
  azureRegion?: string;
  voices?: Record<string, string>;
  overwriteExisting?: boolean;
  nowMs?: number;
  synthesizeFn?: AudioSynthesizeFn;
  fetchImpl?: typeof fetch;
}

export interface EnrichPackageAudioResult {
  bytes: Uint8Array;
  generatedCount: number;
  reusedCount: number;
  skippedCount: number;
  totalMediaCount: number;
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/\s+/g, '');
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function defaultSynthesize(
  input: Parameters<AudioSynthesizeFn>[0],
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<SynthesizedClip> {
  const normLang = normalizeAudioLang(input.lang);

  if (input.provider === 'mock') {
    const voiceId = `mock:${normLang}`;
    const payload = encodeUtf8(`ID3MOCK:${voiceId}:${input.text}`);
    return { bytes: payload, mime: 'audio/mpeg', ext: 'mp3', voiceId };
  }

  const key = input.apiKey?.trim() ?? '';
  if (!key) {
    throw new Error(`API key is required for audio provider "${input.provider}".`);
  }

  if (input.provider === 'google') {
    const resolved = resolveCanonicalVoiceId('google', normLang, input.voiceOverride);
    const endpoint = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`;
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: input.text },
        voice: resolved.voiceName
          ? { languageCode: resolved.languageCode, name: resolved.voiceName }
          : { languageCode: resolved.languageCode },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
      }),
    });
    if (!res.ok) {
      throw new Error(`Google Cloud TTS request failed (${res.status}).`);
    }
    const json = (await res.json()) as { audioContent?: string };
    if (!json.audioContent) {
      throw new Error('Google Cloud TTS returned empty audioContent.');
    }
    return {
      bytes: decodeBase64Bytes(json.audioContent),
      mime: 'audio/mpeg',
      ext: 'mp3',
      voiceId: resolved.canonicalVoiceId,
    };
  }

  const region = input.azureRegion?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9-]{2,32}$/i.test(region)) {
    throw new Error('Valid Azure region (--region) is required for provider "azure".');
  }
  const resolved = resolveCanonicalVoiceId('azure', normLang, input.voiceOverride);
  const voiceName = resolved.voiceName || resolved.languageCode;
  const ssml = `<speak version="1.0" xml:lang="${escapeXml(resolved.languageCode)}"><voice name="${escapeXml(voiceName)}">${escapeXml(input.text)}</voice></speak>`;
  const res = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
    },
    body: ssml,
  });
  if (!res.ok) {
    throw new Error(`Azure Speech TTS request failed (${res.status}).`);
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    mime: 'audio/mpeg',
    ext: 'mp3',
    voiceId: resolved.canonicalVoiceId,
  };
}

/**
 * Pre-generates 1.0x neural TTS audio for notes inside a `.flashpkg` archive,
 * content-hashes clips into `media/<sha256>.mp3`, and attaches `media:<sha256>` to each note (§7.1).
 */
export async function enrichPackageWithAudio(
  pkgBytes: Uint8Array,
  options: EnrichPackageAudioOptions,
): Promise<EnrichPackageAudioResult> {
  const nowMs = options.nowMs ?? Date.now();
  const state = createEmptyState();
  const factory = createEventFactory('cli-audio', 0, createHlcState('cli-audio', nowMs));
  const imported = importFlashpkg(pkgBytes, state, factory, { nowMs });
  applyEvents(state, imported.events);

  const mediaBlobs = new Map<string, Uint8Array>();
  for (const m of imported.extractedMedia) {
    mediaBlobs.set(m.hash.toLowerCase(), m.bytes);
  }

  const synth =
    options.synthesizeFn ??
    ((input) => defaultSynthesize(input, options.fetchImpl ?? globalThis.fetch.bind(globalThis)));

  const generatedEvents: KnownEvent[] = [];
  let generatedCount = 0;
  let reusedCount = 0;
  let skippedCount = 0;

  // Deduplicate identical (normalizedText, voiceId) syntheses within one batch run
  const sessionClipCache = new Map<string, string>();

  const notes = [...state.notes.values()]
    .filter((n) => !n.archived)
    .sort((a, b) => a.created_order - b.created_order || (a.id < b.id ? -1 : 1));

  for (const note of notes) {
    const deck = state.decks.get(note.deck_id);
    if (!deck) {
      skippedCount += 1;
      continue;
    }
    const noteType = state.noteTypes.get(deck.note_type_id);
    const layouts = getEnabledLayoutsForDeck(state, deck);
    const layout = layouts[0];
    if (!layout) {
      skippedCount += 1;
      continue;
    }

    const target = resolveCardAudioTarget(note, layout, noteType, deck);
    if (target.attachedMediaHash && !options.overwriteExisting) {
      skippedCount += 1;
      continue;
    }
    if (!target.normalizedText) {
      skippedCount += 1;
      continue;
    }

    const voiceOverride = options.voices?.[target.lang];
    const resolvedVoice =
      options.provider === 'mock'
        ? `mock:${target.lang}`
        : resolveCanonicalVoiceId(options.provider, target.lang, voiceOverride).canonicalVoiceId;

    const ttsKey = computeTtsCacheKey(target.normalizedText, resolvedVoice);
    const ttsLangKey = computeTtsLangCacheKey(target.normalizedText, target.lang);

    let hash = sessionClipCache.get(ttsKey) ?? state.ttsMediaByKey.get(ttsKey);
    if (hash && mediaBlobs.has(hash)) {
      reusedCount += 1;
    } else {
      const clip = await synth({
        text: target.normalizedText,
        lang: target.lang,
        bcp47Lang: target.bcp47Lang,
        provider: options.provider,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.azureRegion !== undefined ? { azureRegion: options.azureRegion } : {}),
        ...(voiceOverride !== undefined ? { voiceOverride } : {}),
      });
      hash = sha256Hex(clip.bytes).toLowerCase();
      mediaBlobs.set(hash, clip.bytes);
      sessionClipCache.set(ttsKey, hash);
      generatedEvents.push(
        factory.create(
          'MediaAdded',
          {
            media: {
              hash,
              ext: clip.ext,
              mime: clip.mime,
              size: clip.bytes.byteLength,
              tts_key: ttsKey,
              tts_lang_key: ttsLangKey,
            },
          },
          nowMs,
        ),
      );
      generatedCount += 1;
    }

    const audioFieldKey =
      noteType?.fields.find((f) => f.kind === 'audio')?.key ??
      (noteType?.fields.some((f) => f.key === 'audio') ? 'audio' : undefined);

    if (audioFieldKey) {
      generatedEvents.push(
        factory.create(
          'NoteUpserted',
          {
            note_id: note.id,
            deck_id: note.deck_id,
            source_key: note.source_key,
            fields: {
              [audioFieldKey]: `media:${hash}`,
            },
          },
          nowMs,
        ),
      );
    }
  }

  applyEvents(state, generatedEvents);
  const outBytes = exportFlashpkg(state, {
    packageId: imported.manifest.package_id,
    name: imported.manifest.name,
    version: imported.manifest.version,
    ...(imported.manifest.author !== undefined ? { author: imported.manifest.author } : {}),
    ...(imported.manifest.license !== undefined ? { license: imported.manifest.license } : {}),
    mediaBlobs,
  });

  return {
    bytes: outBytes,
    generatedCount,
    reusedCount,
    skippedCount,
    totalMediaCount: mediaBlobs.size,
  };
}

export async function runAudioFileEnrichment(
  inPath: string,
  outPath: string,
  options: EnrichPackageAudioOptions,
): Promise<EnrichPackageAudioResult & { outPath: string }> {
  const pkgBytes = readFileSync(inPath);
  const res = await enrichPackageWithAudio(pkgBytes, options);
  writeFileSync(outPath, res.bytes);
  return { ...res, outPath };
}
