import { describe, expect, it } from 'vitest';
import {
  buildDeckFolderSavedPayload,
  buildDeckPresetSavedPayload,
  buildPresetParamsPayloads,
  getDeckFolder,
  getDeckOrganization,
  getDeckPreset,
  getEffectiveDeckSettings,
  listDeckFolders,
  listDeckPresets,
  listFolderDecks,
  listPresetDeckIds,
  ownSettingsFromPreset,
  presetSeedFromDeck,
} from '../src/decks/organization.ts';
import {
  applyEvents,
  createEventFactory,
  replayAllEvents,
  resolveDeckFsrsConfig,
  type EventFactory,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import { isKnownEventType, type FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import {
  collectOptimizerDataset,
  collectPooledOptimizerDataset,
} from '../src/optimizer/fsrs-optimizer.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import { buildStudyQueue } from '../src/study/queue.ts';

const KO = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
const JA = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ja-vocab');
const ZH = uuidv5(FLASH_NAMESPACE_UUID, 'sample-zh-vocab');
const T0 = SAMPLE_SEED_EPOCH_MS + 60_000;
const NOW = SAMPLE_SEED_EPOCH_MS + 3 * 86_400_000;
const SCOPE = { nowMs: NOW, tzOffsetMinutes: 540 };
const W21 = Array.from({ length: 21 }, (_, i) => Math.round((0.1 + i * 0.05) * 1e4) / 1e4);

function setup(device = 'dev-a'): { factory: EventFactory; events: FlashEvent[] } {
  const factory = createEventFactory(device, 0, createHlcState(device, SAMPLE_SEED_EPOCH_MS));
  return { factory, events: buildSampleDeckEvents(factory) };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function snapshotOf(events: readonly FlashEvent[]) {
  const state = replayAllEvents(events);
  const org = getDeckOrganization(state);
  return JSON.stringify({
    presets: [...org.presets.entries()].sort(),
    folders: [...org.folders.entries()].sort(),
    presetByDeck: [...org.presetByDeck.entries()].sort(),
    folderByDeck: [...org.folderByDeck.entries()].sort(),
  });
}

describe('deck organization fold', () => {
  it('is empty and leaves every deck on its own settings without organization events', () => {
    const { events } = setup();
    const state = replayAllEvents(events);
    expect(listDeckPresets(state)).toEqual([]);
    expect(listDeckFolders(state)).toEqual([]);
    const deck = state.decks.get(KO);
    expect(deck).toBeDefined();
    if (!deck) return;
    expect(getEffectiveDeckSettings(state, deck)).toBe(deck.settings);
  });

  it('keeps the new event types log-retained (older builds and snapshots preserve them)', () => {
    for (const type of [
      'DeckPresetSaved',
      'DeckPresetDeleted',
      'DeckFolderSaved',
      'DeckFolderDeleted',
      'DeckGroupingChanged',
    ]) {
      expect(isKnownEventType(type)).toBe(false);
    }
  });

  it('applies a preset’s limits to every member deck, each deck on its own count', () => {
    const { factory, events } = setup();
    events.push(
      factory.create(
        'DeckPresetSaved',
        { preset_id: 'p1', name: 'Slow', settings: { new_cards_per_day: 2 } },
        T0,
      ),
      factory.create('DeckGroupingChanged', { deck_id: KO, preset_id: 'p1' }, T0 + 1),
      factory.create('DeckGroupingChanged', { deck_id: JA, preset_id: 'p1' }, T0 + 2),
    );
    const state = replayAllEvents(events);
    const baseline = replayAllEvents(setup().events);
    const before = buildStudyQueue(baseline, { ...SCOPE, deckId: ZH });
    const newIn = (id: string) => buildStudyQueue(baseline, { ...SCOPE, deckId: id }).counts.new;
    const othersNew = buildStudyQueue(baseline, SCOPE).counts.new - newIn(KO) - newIn(JA);
    expect(buildStudyQueue(state, { ...SCOPE, deckId: KO }).counts.new).toBe(2);
    expect(buildStudyQueue(state, { ...SCOPE, deckId: JA }).counts.new).toBe(2);
    expect(buildStudyQueue(state, { ...SCOPE, deckId: ZH }).counts.new).toBe(before.counts.new);
    expect(buildStudyQueue(state, SCOPE).counts.new).toBe(4 + othersNew);
    expect(listPresetDeckIds(state, 'p1')).toEqual([KO, JA].sort());
    const preset = getDeckPreset(state, KO);
    expect(preset?.settings).toEqual({
      new_cards_per_day: 2,
      max_reviews_per_day: 200,
      target_retention: 0.9,
    });
  });

  it('resolves every field by last-writer-wins under any delivery order', () => {
    const a = setup('dev-a');
    const b = setup('dev-b');
    // Each device's HLC only moves forward, so every factory creates its events in time order.
    const extra: FlashEvent[] = [
      a.factory.create('DeckPresetSaved', { preset_id: 'p1', name: 'One' }, T0),
      a.factory.create('DeckFolderSaved', { folder_id: 'f1', name: 'Korean' }, T0 + 1),
      b.factory.create('DeckGroupingChanged', { deck_id: KO, folder_id: 'f1' }, T0 + 2),
      a.factory.create('DeckGroupingChanged', { deck_id: KO, preset_id: 'p1' }, T0 + 3),
      a.factory.create('DeckGroupingChanged', { deck_id: JA, folder_id: 'f1' }, T0 + 4),
      b.factory.create(
        'DeckPresetSaved',
        { preset_id: 'p1', settings: { max_reviews_per_day: 50 } },
        T0 + 5,
      ),
      b.factory.create('DeckGroupingChanged', { deck_id: KO, preset_id: null }, T0 + 7),
      a.factory.create('DeckPresetSaved', { preset_id: 'p1', name: 'Renamed' }, T0 + 9),
    ];
    const base = [...a.events];
    const reference = snapshotOf([...base, ...extra]);
    for (let seed = 1; seed <= 8; seed++) {
      expect(snapshotOf([...base, ...shuffled(extra, seed)])).toBe(reference);
    }
    const state = replayAllEvents([...base, ...extra]);
    expect(listDeckPresets(state).map((p) => [p.name, p.settings.max_reviews_per_day])).toEqual([
      ['Renamed', 50],
    ]);
    expect(getDeckPreset(state, KO)).toBeUndefined();
    expect(listFolderDecks(state, 'f1').map((d) => d.id)).toEqual(
      [KO, JA].sort((x, y) => {
        const nx = state.decks.get(x)?.name ?? '';
        const ny = state.decks.get(y)?.name ?? '';
        return nx < ny ? -1 : nx > ny ? 1 : 0;
      }),
    );
  });

  it('drops deleted presets and folders, and a later save brings them back', () => {
    const { factory, events } = setup();
    events.push(
      factory.create(
        'DeckPresetSaved',
        { preset_id: 'p1', name: 'P', settings: { new_cards_per_day: 1 } },
        T0,
      ),
      factory.create('DeckFolderSaved', { folder_id: 'f1', name: 'F' }, T0 + 1),
      factory.create(
        'DeckGroupingChanged',
        { deck_id: KO, preset_id: 'p1', folder_id: 'f1' },
        T0 + 2,
      ),
      factory.create('DeckPresetDeleted', { preset_id: 'p1' }, T0 + 3),
      factory.create('DeckFolderDeleted', { folder_id: 'f1' }, T0 + 4),
    );
    let state = replayAllEvents(events);
    const deck = state.decks.get(KO);
    expect(deck && getEffectiveDeckSettings(state, deck)).toEqual(deck?.settings);
    expect(getDeckFolder(state, KO)).toBeUndefined();
    expect(listDeckPresets(state)).toEqual([]);

    events.push(
      factory.create('DeckPresetSaved', { preset_id: 'p1', name: 'Back' }, T0 + 5),
      factory.create('DeckFolderSaved', { folder_id: 'f1', name: 'F again' }, T0 + 6),
    );
    state = replayAllEvents(events);
    expect(getDeckPreset(state, KO)?.settings.new_cards_per_day).toBe(1);
    expect(getDeckFolder(state, KO)?.name).toBe('F again');
  });

  it('ignores malformed payloads', () => {
    const { factory, events } = setup();
    events.push(
      factory.create(
        'DeckPresetSaved',
        {
          preset_id: 'p1',
          name: '   ',
          settings: { new_cards_per_day: -3, target_retention: 2 },
          w: [1, 2],
        },
        T0,
      ),
      factory.create('DeckFolderSaved', { folder_id: '', name: 'x' }, T0 + 1),
      factory.create('DeckGroupingChanged', { deck_id: KO, preset_id: 'missing' }, T0 + 2),
    );
    const state = replayAllEvents(events);
    expect(listDeckPresets(state)).toEqual([]);
    expect(listDeckFolders(state)).toEqual([]);
    expect(getDeckPreset(state, KO)).toBeUndefined();
  });

  it('survives a snapshot round trip and refreshes its cache when events arrive', () => {
    const { factory, events } = setup();
    events.push(factory.create('DeckFolderSaved', { folder_id: 'f1', name: 'F' }, T0));
    const state = replayAllEvents(events);
    expect(listDeckFolders(state).map((f) => f.name)).toEqual(['F']);
    applyEvents(state, [factory.create('DeckFolderSaved', { folder_id: 'f2', name: 'A' }, T0 + 1)]);
    expect(listDeckFolders(state).map((f) => f.name)).toEqual(['A', 'F']);
    const restored = deserializeCollectionState(serializeCollectionState(state));
    expect(listDeckFolders(restored).map((f) => f.name)).toEqual(['A', 'F']);
  });
});

describe('preset payload builders', () => {
  it('keeps only valid fields', () => {
    expect(buildDeckPresetSavedPayload({ presetId: 'p', name: '  Daily  mix ' })).toEqual({
      preset_id: 'p',
      name: 'Daily mix',
    });
    expect(buildDeckPresetSavedPayload({ presetId: 'p', name: ' ' })).toBeUndefined();
    expect(
      buildDeckPresetSavedPayload({
        presetId: 'p',
        settings: { new_cards_per_day: 1.5, max_reviews_per_day: 30, target_retention: 0.5 },
        w: [1],
      }),
    ).toEqual({ preset_id: 'p', settings: { max_reviews_per_day: 30 } });
    expect(buildDeckFolderSavedPayload('f', '')).toBeUndefined();
  });

  it('seeds a preset from a deck and gives the settings back when the deck leaves', () => {
    const { events } = setup();
    const state = replayAllEvents(events);
    const deck = state.decks.get(KO);
    if (!deck) throw new Error('missing deck');
    const seed = presetSeedFromDeck(state, deck, NOW);
    expect(seed).toEqual({
      settings: { new_cards_per_day: 20, max_reviews_per_day: 200, target_retention: 0.9 },
    });
    expect(ownSettingsFromPreset({ id: 'p', name: 'P', settings: seed.settings })).toEqual(
      seed.settings,
    );
  });
});

describe('preset FSRS fan-out', () => {
  it('writes one params version per drifted deck and nothing once they match', () => {
    const { factory, events } = setup();
    events.push(factory.create('DeckGroupingChanged', { deck_id: KO, preset_id: 'p1' }, T0));
    let state = replayAllEvents(events);
    const preset = {
      settings: { new_cards_per_day: 20, max_reviews_per_day: 200, target_retention: 0.85 },
    };
    const payloads = buildPresetParamsPayloads(state, preset, [KO, JA], NOW);
    expect(payloads.map((p) => [p.deck_id, p.params.request_retention, p.params.w])).toEqual(
      [JA, KO].sort().map((id) => [id, 0.85, undefined]),
    );
    for (const payload of payloads) {
      events.push(factory.create('DeckFSRSParamsChanged', payload, NOW));
    }
    state = replayAllEvents(events);
    expect(resolveDeckFsrsConfig(state, KO, NOW + 1).request_retention).toBe(0.85);
    expect(buildPresetParamsPayloads(state, preset, [KO, JA], NOW + 1)).toEqual([]);

    // Shared weights replace each deck's own; a reschedule writes every deck.
    const withW = { ...preset, w: W21 };
    const second = buildPresetParamsPayloads(state, withW, [KO, JA], NOW + 2);
    expect(second.map((p) => p.params.w)).toEqual([W21, W21]);
    expect(second.every((p) => p.params_version === 2)).toBe(true);
    const all = buildPresetParamsPayloads(state, preset, [KO], NOW + 2, {
      rescheduleExisting: true,
    });
    expect(all).toHaveLength(1);
    expect(all[0]?.reschedule_existing).toBe(true);
  });

  it('keeps a deck’s own weights when the preset has none', () => {
    const { factory, events } = setup();
    events.push(
      factory.create(
        'DeckFSRSParamsChanged',
        {
          deck_id: KO,
          params_version: 1,
          effective_from: T0,
          params: { request_retention: 0.9, w: W21 },
        },
        T0,
      ),
    );
    const state = replayAllEvents(events);
    const out = buildPresetParamsPayloads(
      state,
      { settings: { new_cards_per_day: 5, max_reviews_per_day: 50, target_retention: 0.8 } },
      [KO],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.params.w).toEqual(W21);
    expect(out[0]?.params_version).toBe(2);
  });
});

describe('pooled optimizer dataset', () => {
  it('pools every deck’s histories, independent of deck order', () => {
    const { factory, events } = setup();
    const state0 = replayAllEvents(events);
    let n = 0;
    for (const deckId of [KO, JA]) {
      for (const cardId of [...(state0.cardIdsByDeck.get(deckId) ?? [])].slice(0, 3)) {
        for (let day = 0; day < 3; day++) {
          n += 1;
          events.push(
            factory.create(
              'ReviewRecorded',
              {
                review_id: `r-${n}`,
                card_id: cardId,
                rating: 3,
                reviewed_at: T0 + day * 86_400_000 + n,
                tz_offset: 540,
                duration_ms: 1000,
                answer_mode: 'flip',
                fsrs_params_version: 0,
                resulting_due_at: T0 + (day + 1) * 86_400_000,
              },
              T0 + day * 86_400_000 + n,
            ),
          );
        }
      }
    }
    const state = replayAllEvents(events);
    const ko = collectOptimizerDataset(state, KO);
    const ja = collectOptimizerDataset(state, JA);
    const pooled = collectPooledOptimizerDataset(state, [KO, JA], 'preset:p1');
    expect(pooled.deck_id).toBe('preset:p1');
    expect(pooled.review_count).toBe(ko.review_count + ja.review_count);
    expect(pooled.eligible_review_count).toBe(ko.eligible_review_count + ja.eligible_review_count);
    expect(collectPooledOptimizerDataset(state, [JA, KO, JA], 'preset:p1')).toEqual(pooled);
  });
});
