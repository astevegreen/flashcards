import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
} from '../../core/src/index.ts';
import {
  buildSampleDeckEvents,
  SAMPLE_DECKS,
  SAMPLE_SEED_EPOCH_MS,
  sampleDeckId,
} from '../../core/src/samples/decks.ts';
import { DexieStorage } from '../../platform-web/src/storage/dexie-storage.ts';
import { onboardingLanguages, starterDecksFor } from '../src/onboarding/FirstRunOnboarding.tsx';
import { isKoreanLocale, orderOnboardingLanguages } from '../src/onboarding/languageOrder.ts';
import {
  loadOnboardingRecord,
  forgetOnboardingRecord,
  ONBOARDING_KV_KEY,
  onboardingRecordResource,
  peekOnboardingRecord,
  parseOnboardingRecord,
  saveOnboardingRecord,
  wantsSyncPrompt,
} from '../src/onboarding/onboardingState.ts';

function memoryKv(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    getKv: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    setKv: (key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    },
    deleteKv: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

describe('first-run onboarding choices', () => {
  it('offers every sample-deck language, each with at least one starter deck', () => {
    const languages = onboardingLanguages();
    expect(languages).toEqual(['ko', 'ja', 'zh-Hans', 'en']);
    for (const language of languages) {
      expect(starterDecksFor(language).length).toBeGreaterThan(0);
    }
    expect(starterDecksFor('ja').map((d) => d.slug)).toEqual([
      'sample-ja-vocab',
      'sample-ja-cloze',
    ]);
  });

  it('a starter deck seeds only that deck, under its deterministic id', () => {
    const factory = createEventFactory('dev-o', 0, createHlcState('dev-o', SAMPLE_SEED_EPOCH_MS));
    const events = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS, {
      deckSlugs: ['sample-ko-vocab'],
    });
    const state = applyEvents(createEmptyState(), events);
    expect([...state.decks.keys()]).toEqual([sampleDeckId('sample-ko-vocab')]);
    const ko = SAMPLE_DECKS.find((d) => d.slug === 'sample-ko-vocab');
    expect(state.notes.size).toBe(ko?.noteCount);
    // The lesson page and course come only with the cloze deck they unlock.
    expect(state.pages.size).toBe(0);
    expect(state.courses.size).toBe(0);
    const cloze = applyEvents(
      createEmptyState(),
      buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS, { deckSlugs: ['sample-ja-cloze'] }),
    );
    expect(cloze.pages.size).toBe(1);
    expect(cloze.courses.size).toBe(1);
  });
});

describe('per-device onboarding record', () => {
  it('reads malformed or missing records as "not onboarded yet"', async () => {
    expect(parseOnboardingRecord(undefined)).toBeUndefined();
    expect(parseOnboardingRecord({ status: 'maybe' })).toBeUndefined();
    expect(parseOnboardingRecord({ status: 'skipped', at: 'x', syncPrompt: 'later' })).toEqual({
      status: 'skipped',
      at: 0,
    });
    const failing = {
      getKv: () => Promise.reject(new Error('blocked')),
      setKv: () => Promise.reject(new Error('blocked')),
    };
    await expect(loadOnboardingRecord(failing)).resolves.toBeUndefined();
    await expect(
      saveOnboardingRecord(failing, { status: 'skipped', at: 1 }),
    ).resolves.toBeUndefined();
  });

  it('saves to the device store and serves later reads from the saved record', async () => {
    const kv = memoryKv();
    expect(await onboardingRecordResource(kv)).toBeUndefined();
    const record = {
      status: 'completed' as const,
      at: 5,
      language: 'ko',
      deckSlug: 'sample-ko-vocab',
      syncPrompt: 'pending' as const,
    };
    await saveOnboardingRecord(kv, record);
    expect(kv.data.get(ONBOARDING_KV_KEY)).toEqual(record);
    expect(await onboardingRecordResource(kv)).toEqual(record);
    expect(wantsSyncPrompt(record)).toBe(true);
    expect(wantsSyncPrompt({ ...record, syncPrompt: 'dismissed' })).toBe(false);
    expect(wantsSyncPrompt({ ...record, syncPrompt: 'opened' })).toBe(false);
    expect(await loadOnboardingRecord(memoryKv({ [ONBOARDING_KV_KEY]: record }))).toEqual(record);
  });
});

describe('onboarding language order (approved 2026-11-22)', () => {
  const existing = ['ja', 'zh-Hans', 'ko', 'en', 'fr'];

  it('puts Korean first and keeps the rest in their existing order', () => {
    for (const locale of ['en-US', 'ja-JP', undefined]) {
      expect(orderOnboardingLanguages(existing, locale), String(locale)).toEqual([
        'ko',
        'ja',
        'zh-Hans',
        'en',
        'fr',
      ]);
    }
  });

  it('puts English, then Korean, first on a Korean-locale device', () => {
    for (const locale of ['ko', 'ko-KR', 'KO-kr', 'ko_KR']) {
      expect(orderOnboardingLanguages(existing, locale), locale).toEqual([
        'en',
        'ko',
        'ja',
        'zh-Hans',
        'fr',
      ]);
    }
    // Konkani ("kok") is not Korean.
    expect(isKoreanLocale('kok-IN')).toBe(false);
  });

  it('never invents a language the starter decks do not have, and never repeats one', () => {
    expect(orderOnboardingLanguages(['ja', 'ja', 'zh-Hans'], 'ko-KR')).toEqual(['ja', 'zh-Hans']);
    expect(orderOnboardingLanguages(['ja', 'ko'], 'ko-KR')).toEqual(['ko', 'ja']);
    expect(orderOnboardingLanguages([], 'en')).toEqual([]);
  });
});

describe('the one-time "Sync my devices" prompt', () => {
  it('is offered to anyone with cards who has not answered it, onboarded or not', () => {
    // A collection from before onboarding, or one that skipped it, still gets the prompt once.
    expect(wantsSyncPrompt(undefined)).toBe(true);
    expect(wantsSyncPrompt({ status: 'skipped', at: 1 })).toBe(true);
    expect(wantsSyncPrompt({ status: 'skipped', at: 1, syncPrompt: 'pending' })).toBe(true);
    expect(wantsSyncPrompt({ status: 'skipped', at: 1, syncPrompt: 'dismissed' })).toBe(false);
    expect(wantsSyncPrompt({ status: 'completed', at: 1, syncPrompt: 'opened' })).toBe(false);
  });
});

describe('Reset Local Device Data and the onboarding record', () => {
  it('forgets the record and every cached read of it at once, so onboarding is offered again', async () => {
    const kv = memoryKv();
    const record = { status: 'completed' as const, at: 9, syncPrompt: 'dismissed' as const };
    await saveOnboardingRecord(kv, record);
    expect(peekOnboardingRecord(kv)).toEqual(record);

    const forgetting = forgetOnboardingRecord(kv);
    // Synchronously: the next render already reads "not onboarded yet".
    expect(peekOnboardingRecord(kv)).toBeUndefined();
    expect(await onboardingRecordResource(kv)).toBeUndefined();
    await forgetting;
    expect(kv.data.has(ONBOARDING_KV_KEY)).toBe(false);
    expect(await loadOnboardingRecord(kv)).toBeUndefined();
  });

  it('is also wiped by the device store reset (clearAll), Dexie included', async () => {
    // fake-indexeddb keeps this database in memory for this test file only.
    const storage = new DexieStorage(`test-onboarding-reset-${Date.now()}`);
    try {
      await saveOnboardingRecord(storage, { status: 'skipped', at: 3 });
      expect(await loadOnboardingRecord(storage)).toEqual({ status: 'skipped', at: 3 });
      await storage.clearAll();
      expect(await storage.getKv(ONBOARDING_KV_KEY)).toBeUndefined();
      expect(await loadOnboardingRecord(storage)).toBeUndefined();
    } finally {
      storage.close();
    }
  });
});
