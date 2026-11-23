import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  replayAllEvents,
} from '../src/events/replay.ts';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import { createHlcState } from '../src/hlc.ts';
import {
  deriveActiveLanguages,
  deriveDeckLanguages,
  hasLanguageChoices,
  hasRubyMarkup,
  isLanguageActive,
  isLanguageFeatureActive,
  noteTypeLanguages,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
} from '../src/languages/active-languages.ts';
import { isPackForActiveLanguages, packLanguages } from '../src/languages/pack-languages.ts';
import { BUILTIN_NOTE_TYPE_IDS, BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';
import { buildSampleDeckEvents, sampleDeckId } from '../src/samples/decks.ts';

const noteTypes = new Map(BUILTIN_NOTE_TYPES.map((nt) => [nt.id, nt]));

describe('normalizeLanguage', () => {
  it('maps tags to app codes', () => {
    expect(normalizeLanguage('ja-JP')).toBe('ja');
    expect(normalizeLanguage(' KO ')).toBe('ko');
    expect(normalizeLanguage('zh')).toBe('zh-Hans');
    expect(normalizeLanguage('zh_CN')).toBe('zh-Hans');
    expect(normalizeLanguage('zh-Hans')).toBe('zh-Hans');
    expect(normalizeLanguage('')).toBe('');
  });

  it('every supported language is already normalized', () => {
    for (const code of SUPPORTED_LANGUAGES) expect(normalizeLanguage(code)).toBe(code);
  });
});

describe('deriveActiveLanguages', () => {
  it('is empty with no decks and no onboarding choice', () => {
    expect(deriveActiveLanguages([])).toEqual([]);
  });

  it('collects deck languages, de-duplicated and sorted', () => {
    expect(
      deriveActiveLanguages([{ language: 'ko' }, { language: 'ja' }, { language: 'ko' }]),
    ).toEqual(['ja', 'ko']);
  });

  it('counts the onboarding choice even with no decks', () => {
    expect(deriveActiveLanguages([], { onboardingLanguage: 'ko' })).toEqual(['ko']);
    expect(deriveActiveLanguages([], { onboardingLanguage: 'ja', noteTypes })).toEqual(['ja']);
    expect(deriveActiveLanguages([{ language: 'ja' }], { onboardingLanguage: 'ko' })).toEqual([
      'ja',
      'ko',
    ]);
  });

  it('ignores blank languages and accepts any iterable (a Map.values())', () => {
    const decks = new Map([
      ['a', { language: 'zh' }],
      ['b', { language: '  ' }],
    ]);
    expect(deriveActiveLanguages(decks.values())).toEqual(['zh-Hans']);
  });

  it('is order-independent', () => {
    const a = deriveActiveLanguages([{ language: 'en' }, { language: 'ja' }], {
      onboardingLanguage: 'ko',
    });
    const b = deriveActiveLanguages([{ language: 'ja' }, { language: 'en' }], {
      onboardingLanguage: 'ko',
    });
    expect(a).toEqual(b);
  });

  it('a deck tagged en on a Japanese note type still makes Japanese active', () => {
    const decks = [{ language: 'en', note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA }];
    expect(deriveActiveLanguages(decks)).toEqual(['en']);
    const active = deriveActiveLanguages(decks, { noteTypes });
    expect(active).toContain('ja');
    expect(isLanguageActive(active, 'ja')).toBe(true);
  });

  it('a Korean deck does not pull in English from its meaning field', () => {
    const decks = [{ language: 'ko', note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO }];
    expect(deriveActiveLanguages(decks, { noteTypes })).toEqual(['ko']);
  });

  it('Korean and Chinese cloze/sentence/grammar decks do not activate ja, en or ko from field tags', () => {
    const decks = [
      { language: 'ko', note_type_id: BUILTIN_NOTE_TYPE_IDS.CLOZE },
      { language: 'zh-Hans', note_type_id: BUILTIN_NOTE_TYPE_IDS.SENTENCE },
      { language: 'zh-Hans', note_type_id: BUILTIN_NOTE_TYPE_IDS.GRAMMAR },
    ];
    expect(deriveActiveLanguages(decks, { noteTypes })).toEqual(['ko', 'zh-Hans']);
    expect(
      deriveActiveLanguages([{ language: 'ja', note_type_id: BUILTIN_NOTE_TYPE_IDS.GRAMMAR }], {
        noteTypes,
      }),
    ).toEqual(['ja']);
  });

  it('drops romanisation field tags but a Chinese word field counts', () => {
    const type = {
      fields: [
        { lang: 'zh-Latn-pinyin' },
        { lang: 'en', tts: true },
        { lang: 'en' },
        { lang: 'zh-Hans' },
      ],
    };
    expect(noteTypeLanguages(type)).toEqual(['en', 'zh-Hans']);
  });
});

describe('archived decks', () => {
  const ko = { language: 'ko', note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO, archived: false };
  const ja = { language: 'ja', note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA, archived: false };

  it('archiving the only Japanese deck drops Japanese (and furigana); un-archiving brings it back', () => {
    const before = deriveActiveLanguages([ko, ja], { noteTypes });
    expect(before).toEqual(['ja', 'ko']);
    expect(isLanguageFeatureActive(before, 'ruby')).toBe(true);

    const archived = deriveActiveLanguages([ko, { ...ja, archived: true }], { noteTypes });
    expect(archived).toEqual(['ko']);
    expect(isLanguageFeatureActive(archived, 'ruby')).toBe(false);

    expect(deriveActiveLanguages([ko, { ...ja, archived: false }], { noteTypes })).toEqual(before);
  });

  it('an archived deck does not count through its note type either', () => {
    const tagged = { language: 'en', note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_JA, archived: true };
    expect(deriveDeckLanguages([tagged], noteTypes)).toEqual([]);
  });

  it('another unarchived Japanese deck keeps Japanese active', () => {
    expect(deriveActiveLanguages([ja, { ...ja, archived: true }], { noteTypes })).toEqual(['ja']);
  });

  it('archiving everything falls back to the onboarding choice', () => {
    expect(
      deriveActiveLanguages([{ ...ko, archived: true }], { onboardingLanguage: 'ko' }),
    ).toEqual(['ko']);
  });
});

describe('Settings > Languages choices', () => {
  it('a ticked language is active with no deck in it', () => {
    expect(deriveActiveLanguages([{ language: 'ko' }], { chosen: { ja: true } })).toEqual([
      'ja',
      'ko',
    ]);
    expect(deriveActiveLanguages([], { chosen: { zh: true } })).toEqual(['zh-Hans']);
  });

  it('unticking never hides a language that has decks', () => {
    expect(deriveActiveLanguages([{ language: 'ja' }], { chosen: { ja: false } })).toEqual(['ja']);
  });

  it('unticking drops the onboarding choice', () => {
    expect(
      deriveActiveLanguages([{ language: 'ko' }], {
        onboardingLanguage: 'ja',
        chosen: { ja: false },
      }),
    ).toEqual(['ko']);
  });

  it('ticking brings furigana back after the only Japanese deck is archived', () => {
    const decks = [
      { language: 'ko', archived: false },
      { language: 'ja', archived: true },
    ];
    expect(isLanguageFeatureActive(deriveActiveLanguages(decks), 'ruby')).toBe(false);
    expect(
      isLanguageFeatureActive(deriveActiveLanguages(decks, { chosen: { ja: true } }), 'ruby'),
    ).toBe(true);
  });

  it('ignores non-boolean values from older or foreign data', () => {
    const chosen = { ja: 'yes', ko: true } as unknown as Record<string, boolean>;
    expect(deriveActiveLanguages([], { chosen })).toEqual(['ko']);
  });

  it('is stored as an appended PreferencesChanged event, per-language last-writer-wins, and survives a snapshot', () => {
    const state = createEmptyState();
    const a = createEventFactory('dev-a', 0, createHlcState('dev-a', 1000));
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', 1000));
    applyEvents(state, [
      a.create('PreferencesChanged', { preferences: { languages: { ja: true } } }, 1000),
      b.create('PreferencesChanged', { preferences: { languages: { 'zh-Hans': true } } }, 1001),
      a.create('PreferencesChanged', { preferences: { languages: { ja: false } } }, 1002),
    ]);
    expect(state.preferences.languages).toEqual({ ja: false, 'zh-Hans': true });
    const { languages: _languages, ...others } = state.preferences;
    const { languages: _none, ...defaults } = createEmptyState().preferences;
    expect(others).toEqual(defaults);

    const restored = deserializeCollectionState(serializeCollectionState(state));
    expect(restored.preferences.languages).toEqual({ ja: false, 'zh-Hans': true });
  });
});

describe('Settings > Languages choices converge', () => {
  function choiceEvents() {
    const a = createEventFactory('dev-a', 0, createHlcState('dev-a', 1000));
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', 1000));
    return [
      a.create(
        'PreferencesChanged',
        { preferences: { languages: { ja: false, 'ja-JP': true } } },
        1000,
      ),
      b.create('PreferencesChanged', { preferences: { languages: { JA: false } } }, 1001),
      b.create('PreferencesChanged', { preferences: { languages: { 'zh-CN': true } } }, 1002),
      a.create('PreferencesChanged', { preferences: { languages: { zh: false, ko: true } } }, 1003),
      a.create('PreferencesChanged', { preferences: { languages: { 'ko-KR': false } } }, 1004),
    ];
  }

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, i) =>
      permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
    );
  }

  it('normalizes keys before last-writer-wins, so every delivery order and a snapshot agree', () => {
    const events = choiceEvents();
    const expected = replayAllEvents(events).preferences.languages;
    expect(expected).toEqual({ ja: false, 'zh-Hans': false, ko: false });

    for (const order of permutations(events)) {
      const state = createEmptyState();
      for (const event of order) applyEvents(state, [event]);
      expect(state.preferences.languages).toEqual(expected);
    }

    // Half applied, snapshotted and restored, then the rest (in reverse) on top.
    for (let cut = 0; cut <= events.length; cut += 1) {
      const head = createEmptyState();
      applyEvents(head, events.slice(0, cut));
      const restored = deserializeCollectionState(serializeCollectionState(head));
      applyEvents(restored, [...events.slice(cut)].reverse());
      expect(restored.preferences.languages).toEqual(expected);
    }
  });

  it('aliases inside one event resolve the same way everywhere (code-unit-last raw key wins)', () => {
    const f = createEventFactory('dev', 0, createHlcState('dev', 1000));
    const forward = replayAllEvents([
      f.create(
        'PreferencesChanged',
        { preferences: { languages: { ja: false, 'ja-JP': true } } },
        1,
      ),
    ]);
    const g = createEventFactory('dev', 0, createHlcState('dev', 1000));
    const backward = replayAllEvents([
      g.create(
        'PreferencesChanged',
        { preferences: { languages: { 'ja-JP': true, ja: false } } },
        1,
      ),
    ]);
    expect(forward.preferences.languages).toEqual({ ja: true });
    expect(backward.preferences.languages).toEqual({ ja: true });
  });

  it('survives a computeStatePatch / mergeStatePatch round trip (Worker to main thread)', () => {
    const worker = createEmptyState();
    const main = createEmptyState();
    const events = choiceEvents();
    const patch = computeStatePatch(worker, events);
    expect(patch.preferences?.languages).toEqual({ ja: false, 'zh-Hans': false, ko: false });
    mergeStatePatch(main, patch);
    expect(main.preferences.languages).toEqual(worker.preferences.languages);
    // The merged copy is independent of the patch object.
    const patched = patch.preferences?.languages;
    if (patched) patched['ja'] = true;
    expect(patched?.['ja']).toBe(true);
    expect(main.preferences.languages?.['ja']).toBe(false);
  });
});

describe('every box unticked', () => {
  it('shows no language-specific options; only "no information at all" shows everything', () => {
    const chosen = { ja: false, ko: false, 'zh-Hans': false, en: false };
    const active = deriveActiveLanguages([{ language: 'ja', archived: true }], {
      onboardingLanguage: 'ko',
      chosen,
    });
    expect(active).toEqual([]);
    const known = active.length > 0 || hasLanguageChoices(chosen);
    expect(known).toBe(true);
    for (const feature of ['ruby', 'pinyin', 'tones', 'handwriting'] as const) {
      expect(isLanguageFeatureActive(active, feature, known)).toBe(false);
    }
    expect(isLanguageActive(active, 'ja', known)).toBe(false);
    expect(isPackForActiveLanguages(active, { kind: 'dictionary', language: 'ko' }, known)).toBe(
      false,
    );

    // No decks, no onboarding, no choices: nothing is known, everything is offered.
    expect(hasLanguageChoices(undefined)).toBe(false);
    expect(hasLanguageChoices({})).toBe(false);
    expect(isLanguageFeatureActive([], 'ruby', hasLanguageChoices({}))).toBe(true);
    expect(isLanguageFeatureActive([], 'ruby')).toBe(true);
  });
});

describe('isLanguageFeatureActive', () => {
  it('shows everything when no language is known', () => {
    expect(isLanguageFeatureActive([], 'ruby')).toBe(true);
    expect(isLanguageActive([], 'ja')).toBe(true);
  });

  it('ruby is furigana (ja) and pinyin (zh), not Korean or English', () => {
    expect(isLanguageFeatureActive(['ja'], 'ruby')).toBe(true);
    expect(isLanguageFeatureActive(['zh-Hans'], 'ruby')).toBe(true);
    expect(isLanguageFeatureActive(['ko'], 'ruby')).toBe(false);
    expect(isLanguageFeatureActive(['en'], 'ruby')).toBe(false);
    expect(isLanguageFeatureActive(['en', 'ko'], 'ruby')).toBe(false);
  });

  it('a Korean-only collection hides ruby, pinyin and tones but keeps handwriting', () => {
    expect(isLanguageFeatureActive(['ko'], 'ruby')).toBe(false);
    expect(isLanguageFeatureActive(['ko'], 'pinyin')).toBe(false);
    expect(isLanguageFeatureActive(['ko'], 'tones')).toBe(false);
    expect(isLanguageFeatureActive(['ko'], 'handwriting')).toBe(true);
    expect(isLanguageActive(['ko'], 'ja')).toBe(false);
  });

  it('adding Chinese brings pinyin and tones back', () => {
    const active = deriveActiveLanguages([{ language: 'ko' }, { language: 'zh-Hans' }]);
    expect(isLanguageFeatureActive(active, 'pinyin')).toBe(true);
    expect(isLanguageFeatureActive(active, 'tones')).toBe(true);
  });

  it('an English-only collection has no CJK tools', () => {
    expect(isLanguageFeatureActive(['en'], 'handwriting')).toBe(false);
    expect(isLanguageActive(['en'], 'ko')).toBe(false);
    expect(isLanguageActive(['en'], 'en')).toBe(true);
  });
});

describe('offline packs by language', () => {
  const hanja = { kind: 'dictionary', language: 'ko' };
  const kanji = { kind: 'dictionary', language: 'ja' };
  const cedict = { kind: 'dictionary', language: 'zh-Hans' };
  const kanjiVg = { kind: 'strokes', language: 'ja', script: 'ja' };
  const mmah = { kind: 'strokes', language: 'zh-Hans', script: 'zh-Hans' };

  it('a dictionary serves its own language; both stroke packs also serve Hanja lookup', () => {
    expect(packLanguages(hanja)).toEqual(['ko']);
    expect(packLanguages(kanjiVg)).toEqual(['ja', 'ko']);
    expect(packLanguages(mmah)).toEqual(['zh-Hans', 'ko']);
  });

  it('a Korean-only collection keeps the Hanja dictionary and both stroke packs, not Kanji or Chinese dictionaries', () => {
    const shown = [hanja, kanji, cedict, kanjiVg, mmah].filter((p) =>
      isPackForActiveLanguages(['ko'], p),
    );
    expect(shown).toEqual([hanja, kanjiVg, mmah]);
  });

  it('shows every pack while nothing is known, and a pack with no language', () => {
    expect(isPackForActiveLanguages([], kanji)).toBe(true);
    expect(isPackForActiveLanguages(['ko'], { kind: 'dictionary', language: '' })).toBe(true);
  });
});

describe('built-in Korean content is plain (no Hangul-over-Hanja ruby)', () => {
  it('the Korean sample deck stores Hanja as plain text', () => {
    const state = replayAllEvents(
      buildSampleDeckEvents(createEventFactory('t', 0, createHlcState('t', 1000)), 1000),
    );
    const deckId = sampleDeckId('sample-ko-vocab');
    const notes = [...state.notes.values()].filter((n) => n.deck_id === deckId);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      for (const value of Object.values(note.fields)) expect(hasRubyMarkup(value)).toBe(false);
    }
    expect(notes.some((n) => n.fields['word']?.includes('學校'))).toBe(true);
  });

  it('hasRubyMarkup still sees ruby already stored in a note', () => {
    expect(hasRubyMarkup('학교 (學校[학교])')).toBe(true);
    expect(hasRubyMarkup('{今日|きょう}')).toBe(true);
    expect(hasRubyMarkup('word [formal]')).toBe(false);
    expect(hasRubyMarkup('學校')).toBe(false);
  });
});

describe('hidden preferences are kept', () => {
  it('a stored zh_ignore_tones value is untouched by which languages are active', () => {
    const state = createEmptyState();
    const factory = createEventFactory('dev', 0, createHlcState('dev', 1000));
    applyEvents(state, [
      factory.create('PreferencesChanged', { preferences: { zh_ignore_tones: true } }, 1000),
    ]);
    const before = JSON.stringify(state.preferences);
    // Chinese inactive (options hidden), then active again (options back).
    expect(isLanguageFeatureActive(deriveActiveLanguages([{ language: 'ko' }]), 'tones')).toBe(
      false,
    );
    expect(state.preferences.zh_ignore_tones).toBe(true);
    expect(isLanguageFeatureActive(deriveActiveLanguages([{ language: 'zh' }]), 'tones')).toBe(
      true,
    );
    expect(JSON.stringify(state.preferences)).toBe(before);
    expect(state.preferences.zh_ignore_tones).toBe(true);
  });
});
