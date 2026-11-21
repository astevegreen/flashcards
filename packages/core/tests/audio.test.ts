import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  BUILTIN_LAYOUTS,
  BUILTIN_NOTE_TYPE_IDS,
  BUILTIN_NOTE_TYPES,
  computeStatePatch,
  computeTtsCacheKey,
  computeTtsLangCacheKey,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deserializeCollectionState,
  exportFlashpkg,
  importFlashpkg,
  mergeStatePatch,
  normalizeAudioLang,
  normalizeTtsText,
  parseMediaHashUri,
  replayAllEvents,
  resolveCanonicalVoiceId,
  resolveCardAudioTarget,
  resolveLayoutSpeakTiming,
  serializeCollectionState,
  toBcp47SpeechTag,
  type Deck,
  type Layout,
  type Note,
} from '../src/index.ts';

describe('Core audio & TTS pure logic (§7.1)', () => {
  it('canonicalizes language codes and BCP 47 speech tags', () => {
    expect(normalizeAudioLang('ja')).toBe('ja');
    expect(normalizeAudioLang('ja-JP')).toBe('ja');
    expect(normalizeAudioLang('zh')).toBe('zh-Hans');
    expect(normalizeAudioLang('zh-CN')).toBe('zh-Hans');
    expect(normalizeAudioLang('zh_Hans')).toBe('zh-Hans');
    expect(normalizeAudioLang('zh-Latn-pinyin')).toBe('zh-Hans');
    expect(normalizeAudioLang('zh-TW')).toBe('zh-Hant');
    expect(normalizeAudioLang('zh-Hant-HK')).toBe('zh-Hant');
    expect(normalizeAudioLang('ko-KR')).toBe('ko');
    expect(normalizeAudioLang('en-GB')).toBe('en');

    expect(toBcp47SpeechTag('ja')).toBe('ja-JP');
    expect(toBcp47SpeechTag('zh-Hans')).toBe('zh-CN');
    expect(toBcp47SpeechTag('zh-Hant')).toBe('zh-TW');
    expect(toBcp47SpeechTag('ko')).toBe('ko-KR');
    expect(toBcp47SpeechTag('en')).toBe('en-US');
  });

  it('normalizes raw text for TTS by stripping cloze & ruby, applying NFKC, and collapsing spaces', () => {
    expect(normalizeTtsText('私の{{c1::日本[にほん]::Japan}}　です')).toBe('私の日本 です');
    expect(normalizeTtsText('{{c1::{今日|きょう}}}は良い天気')).toBe('今日は良い天気');
    expect(normalizeTtsText('  ＡＢＣ   123  ')).toBe('ABC 123');
    expect(normalizeTtsText('')).toBe('');
  });

  it('computes deterministic SHA-256 cache keys sensitive to text and voice ID', () => {
    const k1 = computeTtsCacheKey('食べます', 'google:ja-JP-Neural2-B');
    const k2 = computeTtsCacheKey('食べます', 'google:ja-JP-Neural2-B');
    const k3 = computeTtsCacheKey('食べます', 'google:ja-JP-Neural2-C');
    const k4 = computeTtsCacheKey('食べます', 'azure:ja-JP-NanamiNeural');
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).not.toBe(k4);

    const lk1 = computeTtsLangCacheKey('食べます', 'ja-JP');
    const lk2 = computeTtsLangCacheKey('食べます', 'ja');
    const lk3 = computeTtsLangCacheKey('食べます', 'ko');
    expect(lk1).toBe(lk2);
    expect(lk1).not.toBe(lk3);
  });

  it('validates media:<sha256> URIs and rejects invalid schemes', () => {
    const validHash = 'a'.repeat(64);
    expect(parseMediaHashUri(`media:${validHash.toUpperCase()}`)).toBe(validHash);
    expect(parseMediaHashUri(`  media:${validHash}  `)).toBe(validHash);
    expect(parseMediaHashUri('media:short')).toBeNull();
    expect(parseMediaHashUri('https://example.com/a.mp3')).toBeNull();
    expect(parseMediaHashUri('javascript:alert(1)')).toBeNull();
    expect(parseMediaHashUri(undefined)).toBeNull();
  });

  it('resolves canonical Google and Azure voice IDs and custom overrides', () => {
    const gJa = resolveCanonicalVoiceId('google', 'ja');
    expect(gJa.voiceName).toBe('ja-JP-Neural2-B');
    expect(gJa.languageCode).toBe('ja-JP');
    expect(gJa.canonicalVoiceId).toBe('google:ja-JP-Neural2-B');

    const gCustom = resolveCanonicalVoiceId('google', 'en', 'google:en-GB-Neural2-A');
    expect(gCustom.voiceName).toBe('en-GB-Neural2-A');
    expect(gCustom.languageCode).toBe('en-GB');
    expect(gCustom.canonicalVoiceId).toBe('google:en-GB-Neural2-A');

    const aKo = resolveCanonicalVoiceId('azure', 'ko');
    expect(aKo.voiceName).toBe('ko-KR-SunHiNeural');
    expect(aKo.languageCode).toBe('ko-KR');
    expect(aKo.canonicalVoiceId).toBe('azure:ko-KR-SunHiNeural');
  });

  it('resolves card audio target priority: attached audio, speech_override, speak_field, tts fallback', () => {
    const jaType = BUILTIN_NOTE_TYPES.find((nt) => nt.id === BUILTIN_NOTE_TYPE_IDS.VOCAB_JA);
    const jaRec = BUILTIN_LAYOUTS.find((l) => l.id === 'layout:vocab-ja:recognition');
    expect(jaType).toBeDefined();
    expect(jaRec).toBeDefined();
    if (!jaType || !jaRec) return;

    const deck: Deck = {
      id: 'd-ja',
      name: 'Japanese',
      note_type_id: jaType.id,
      language: 'ja',
      settings: {
        new_cards_per_day: 20,
        max_reviews_per_day: 200,
        target_retention: 0.9,
        new_card_order: 'source',
      },
      initial_retention: 0.9,
      archived: false,
      created_at: 1000,
    };

    const audioHash = 'b'.repeat(64);
    const noteWithAudioAndOverride: Note = {
      id: 'n1',
      deck_id: deck.id,
      fields: {
        word: '橋[はし]',
        reading: 'はし',
        meaning: 'bridge',
        audio: `media:${audioHash}`,
        speech_override: 'はし（橋）',
      },
      tags: [],
      source_key: 'k1',
      provenance: { source: 'user', reviewed: true },
      archived: false,
      created_order: 0,
    };

    const t1 = resolveCardAudioTarget(noteWithAudioAndOverride, jaRec, jaType, deck);
    expect(t1.attachedMediaHash).toBe(audioHash);
    expect(t1.sourceField).toBe('speech_override');
    expect(t1.normalizedText).toBe('はし(橋)');
    expect(t1.lang).toBe('ja');
    expect(t1.bcp47Lang).toBe('ja-JP');

    // Without speech_override: uses layout.speak_field ('reading')
    const noteWithReading: Note = {
      ...noteWithAudioAndOverride,
      fields: { word: '日本[にほん]', reading: 'にほん', meaning: 'Japan' },
    };
    const t2 = resolveCardAudioTarget(noteWithReading, jaRec, jaType, deck);
    expect(t2.attachedMediaHash).toBeUndefined();
    expect(t2.sourceField).toBe('reading');
    expect(t2.normalizedText).toBe('にほん');

    // Without reading: falls back to first tts: true field ('word') and strips ruby
    const noteKanaOnly: Note = {
      ...noteWithAudioAndOverride,
      fields: { word: '食[た]べる', meaning: 'to eat' },
    };
    const t3 = resolveCardAudioTarget(noteKanaOnly, jaRec, jaType, deck);
    expect(t3.sourceField).toBe('word');
    expect(t3.normalizedText).toBe('食べる');
  });

  it('resolves layout speak timing for listen, explicit speak_on, and inferred recognition/production', () => {
    const baseLayout: Layout = {
      id: 'l1',
      note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
      name: 'Custom',
      front_fields: ['word'],
      reveal_steps: [['meaning']],
      answer_mode: 'flip',
      speak_field: 'word',
      hide_furigana_on_front: false,
      enabled: true,
    };

    expect(
      resolveLayoutSpeakTiming({ ...baseLayout, answer_mode: 'listen', speak_on: 'manual' }),
    ).toBe('front');
    expect(resolveLayoutSpeakTiming({ ...baseLayout, speak_on: 'manual' })).toBe('manual');
    expect(resolveLayoutSpeakTiming({ ...baseLayout, speak_on: 'reveal' })).toBe('reveal');
    expect(resolveLayoutSpeakTiming(baseLayout)).toBe('front');
    expect(
      resolveLayoutSpeakTiming({
        ...baseLayout,
        front_fields: ['meaning'],
        reveal_steps: [['word']],
        speak_field: 'word',
      }),
    ).toBe('reveal');
  });

  it('maintains ttsMediaByKey & ttsMediaByLangKey across replay, snapshot, and Worker patches, and converges PreferencesChanged LWW', () => {
    const t0 = Date.UTC(2026, 5, 1, 10, 0, 0);
    const factoryA = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const factoryB = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 50));

    const mediaHash = 'c'.repeat(64);
    const ttsKey = computeTtsCacheKey('안녕하세요', 'google:ko-KR-Neural2-A');
    const ttsLangKey = computeTtsLangCacheKey('안녕하세요', 'ko');

    const evsA = [
      factoryA.create(
        'MediaAdded',
        {
          media: {
            hash: mediaHash,
            ext: 'mp3',
            mime: 'audio/mpeg',
            size: 1234,
            tts_key: ttsKey,
            tts_lang_key: ttsLangKey,
          },
        },
        t0,
      ),
      factoryA.create(
        'PreferencesChanged',
        {
          preferences: {
            auto_play_audio: true,
            tts_voices: { ko: 'ko-KR-Neural2-B', ja: 'ja-JP-Neural2-C' },
          },
        },
        t0 + 10,
      ),
    ];

    const evsB = [
      factoryB.create(
        'PreferencesChanged',
        {
          preferences: {
            tts_voices: { ko: 'ko-KR-Neural2-C', ja: '' }, // clear ja override back to default
          },
        },
        t0 + 60,
      ),
    ];

    const sAB = replayAllEvents([...evsA, ...evsB]);
    const sBA = replayAllEvents([...evsB, ...evsA]);

    expect(sAB.ttsMediaByKey.get(ttsKey)).toBe(mediaHash);
    expect(sAB.ttsMediaByLangKey.get(ttsLangKey)).toBe(mediaHash);
    expect(sAB.preferences.auto_play_audio).toBe(true);
    expect(sAB.preferences.tts_voices).toEqual({ ko: 'ko-KR-Neural2-C' });
    expect(sBA.preferences).toEqual(sAB.preferences);
    expect(sBA.ttsMediaByKey.get(ttsKey)).toBe(mediaHash);

    // Snapshot round-trip preserves both TTS indexes and tts_voices
    const snap = serializeCollectionState(sAB);
    const hydrated = deserializeCollectionState(snap);
    expect(hydrated.ttsMediaByKey.get(ttsKey)).toBe(mediaHash);
    expect(hydrated.ttsMediaByLangKey.get(ttsLangKey)).toBe(mediaHash);
    expect(hydrated.preferences.auto_play_audio).toBe(true);
    expect(hydrated.preferences.tts_voices).toEqual({ ko: 'ko-KR-Neural2-C' });

    // Worker state patch round-trip preserves both TTS indexes and preferences
    const workerState = createEmptyState();
    const mainState = createEmptyState();
    const patch = computeStatePatch(workerState, [...evsA, ...evsB]);
    mergeStatePatch(mainState, patch);
    expect(mainState.ttsMediaByKey.get(ttsKey)).toBe(mediaHash);
    expect(mainState.ttsMediaByLangKey.get(ttsLangKey)).toBe(mediaHash);
    expect(mainState.preferences.auto_play_audio).toBe(true);
    expect(mainState.preferences.tts_voices).toEqual({ ko: 'ko-KR-Neural2-C' });
  });

  it('preserves speak_on in .flashpkg export and import and includes audio field on all presets', () => {
    for (const nt of BUILTIN_NOTE_TYPES) {
      const audioField = nt.fields.find((f) => f.kind === 'audio');
      expect(audioField?.key).toBe('audio');
    }

    const t0 = Date.UTC(2026, 5, 1, 10, 0, 0);
    const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const state = applyEvents(createEmptyState(), [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'd1',
          name: 'Audio Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
      factory.create(
        'LayoutChanged',
        {
          layout: {
            id: 'layout:custom:manual',
            note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
            name: 'ManualSpeak',
            front_fields: ['word'],
            reveal_steps: [['meaning']],
            answer_mode: 'flip',
            speak_field: 'example',
            speak_on: 'manual',
            hide_furigana_on_front: false,
            enabled: true,
          },
        },
        t0 + 1,
      ),
    ]);

    const zip = exportFlashpkg(state, { name: 'SpeakOnTest' });
    const fresh = createEmptyState();
    const factory2 = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 100));
    const res = importFlashpkg(zip, fresh, factory2, { nowMs: t0 + 100 });
    applyEvents(fresh, res.events);

    const importedLayout = fresh.layouts.get('layout:custom:manual');
    expect(importedLayout?.speak_on).toBe('manual');
    expect(importedLayout?.speak_field).toBe('example');
  });

  it('converges ttsMediaByLangKey deterministically by HLC across out-of-order batches, snapshots, and Worker patches even when older hash sorts after newer hash', () => {
    const t0 = Date.UTC(2026, 5, 2, 10, 0, 0);
    const factoryA = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const factoryB = createEventFactory('dev-b', 0, createHlcState('dev-b', t0 + 500));

    const hashOld = 'f'.repeat(64); // lexicographically AFTER hashNew!
    const hashNew = '0'.repeat(64);
    const ttsKeyOld = computeTtsCacheKey('한국어', 'google:ko-KR-Neural2-A');
    const ttsKeyNew = computeTtsCacheKey('한국어', 'google:ko-KR-Neural2-B');
    const sharedLangKey = computeTtsLangCacheKey('한국어', 'ko');

    const evOld = factoryA.create(
      'MediaAdded',
      {
        media: {
          hash: hashOld,
          ext: 'mp3',
          mime: 'audio/mpeg',
          size: 512,
          tts_key: ttsKeyOld,
          tts_lang_key: sharedLangKey,
        },
      },
      t0,
    );
    const evNew = factoryB.create(
      'MediaAdded',
      {
        media: {
          hash: hashNew,
          ext: 'mp3',
          mime: 'audio/mpeg',
          size: 640,
          tts_key: ttsKeyNew,
          tts_lang_key: sharedLangKey,
        },
      },
      t0 + 500,
    );

    // Separate batches in opposite orders (Device A: old then new; Device B: new then old)
    const stateA = createEmptyState();
    applyEvents(stateA, [evOld]);
    applyEvents(stateA, [evNew]);

    const stateB = createEmptyState();
    applyEvents(stateB, [evNew]);
    applyEvents(stateB, [evOld]);

    expect(stateA.ttsMediaByLangKey.get(sharedLangKey)).toBe(hashNew);
    expect(stateB.ttsMediaByLangKey.get(sharedLangKey)).toBe(hashNew);
    expect(stateA.ttsMediaByKey.get(ttsKeyOld)).toBe(hashOld);
    expect(stateA.ttsMediaByKey.get(ttsKeyNew)).toBe(hashNew);

    // Snapshot round-trip MUST preserve hashNew (must NOT revert to hashOld due to hash sort order)
    const hydrated = deserializeCollectionState(serializeCollectionState(stateA));
    expect(hydrated.ttsMediaByLangKey.get(sharedLangKey)).toBe(hashNew);

    // Worker patch round-trip across out-of-order batches MUST preserve hashNew
    const workerState = createEmptyState();
    const mainState = createEmptyState();
    mergeStatePatch(mainState, computeStatePatch(workerState, [evNew]));
    mergeStatePatch(mainState, computeStatePatch(workerState, [evOld]));
    expect(mainState.ttsMediaByLangKey.get(sharedLangKey)).toBe(hashNew);
  });
});
