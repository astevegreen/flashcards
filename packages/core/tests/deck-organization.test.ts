import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildDeckFolderSavedPayload,
  buildDeckPresetSavedPayload,
  buildPresetParamsPayloads,
  buildPresetSettingsPayloads,
  getDeckFolder,
  getDeckOrganization,
  getDeckPreset,
  listDeckFolders,
  listDeckPresets,
  listFolderDecks,
  listPresetDeckIds,
  buildPresetCatchUp,
  nextPresetParamsVersion,
  presetSeedFromDeck,
  type PresetField,
} from '../src/decks/organization.ts';
import {
  applyEvents,
  createEventFactory,
  getActiveFsrsParamsVersion,
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
const DEV_A = { deviceId: 'dev-a' };
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
    expect(getDeckPreset(state, KO)).toBeUndefined();
    expect(getDeckFolder(state, KO)).toBeUndefined();
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

  it('a preset’s limits reach the queue only through its settings fan-out, per deck', () => {
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
    let state = replayAllEvents(events);
    // Grouping alone changes nothing the queue reads.
    expect(buildStudyQueue(state, { ...SCOPE, deckId: KO }).counts.new).toBeGreaterThan(2);
    const preset = getDeckPreset(state, KO);
    if (!preset) throw new Error('missing preset');
    const patches = buildPresetSettingsPayloads(state, preset, listPresetDeckIds(state, 'p1'));
    expect(patches.map((p) => p.deck_id)).toEqual([KO, JA].sort());
    for (const payload of patches) {
      events.push(factory.create('DeckSettingsChanged', payload, T0 + 3));
    }
    state = replayAllEvents(events);
    expect(buildPresetSettingsPayloads(state, preset, [KO, JA])).toEqual([]);
    const baseline = replayAllEvents(setup().events);
    const before = buildStudyQueue(baseline, { ...SCOPE, deckId: ZH });
    const newIn = (id: string) => buildStudyQueue(baseline, { ...SCOPE, deckId: id }).counts.new;
    const othersNew = buildStudyQueue(baseline, SCOPE).counts.new - newIn(KO) - newIn(JA);
    expect(buildStudyQueue(state, { ...SCOPE, deckId: KO }).counts.new).toBe(2);
    expect(buildStudyQueue(state, { ...SCOPE, deckId: JA }).counts.new).toBe(2);
    expect(buildStudyQueue(state, { ...SCOPE, deckId: ZH }).counts.new).toBe(before.counts.new);
    expect(buildStudyQueue(state, SCOPE).counts.new).toBe(4 + othersNew);
    expect(listPresetDeckIds(state, 'p1')).toEqual([KO, JA].sort());
    expect(preset.settings).toEqual({
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

  it('drops deleted presets and folders for good: a later save does not bring them back', () => {
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
    expect(getDeckPreset(state, KO)).toBeUndefined();
    expect(getDeckFolder(state, KO)).toBeUndefined();
    expect(listDeckPresets(state)).toEqual([]);

    events.push(
      factory.create('DeckPresetSaved', { preset_id: 'p1', name: 'Back' }, T0 + 5),
      factory.create('DeckFolderSaved', { folder_id: 'f1', name: 'F again' }, T0 + 6),
    );
    state = replayAllEvents(events);
    expect(getDeckPreset(state, KO)).toBeUndefined();
    expect(getDeckFolder(state, KO)).toBeUndefined();
    expect(listDeckPresets(state)).toEqual([]);
    expect(listDeckFolders(state)).toEqual([]);
  });

  it('a delete never undoes a concurrent move to another folder or preset', () => {
    const a = setup('dev-a');
    const b = setup('dev-b');
    const shared: FlashEvent[] = [
      a.factory.create('DeckFolderSaved', { folder_id: 'f1', name: 'Old' }, T0),
      a.factory.create('DeckFolderSaved', { folder_id: 'f2', name: 'New' }, T0 + 1),
      a.factory.create('DeckPresetSaved', { preset_id: 'p1', name: 'Old' }, T0 + 2),
      a.factory.create('DeckPresetSaved', { preset_id: 'p2', name: 'New' }, T0 + 3),
      a.factory.create(
        'DeckGroupingChanged',
        { deck_id: KO, folder_id: 'f1', preset_id: 'p1' },
        T0 + 4,
      ),
    ];
    // B moves the deck (earlier), A deletes the old folder and preset (later), concurrently.
    const bMoves = b.factory.create(
      'DeckGroupingChanged',
      { deck_id: KO, folder_id: 'f2', preset_id: 'p2' },
      T0 + 10,
    );
    const aDeletes = [
      a.factory.create('DeckFolderDeleted', { folder_id: 'f1' }, T0 + 20),
      a.factory.create('DeckPresetDeleted', { preset_id: 'p1' }, T0 + 21),
    ];
    const extra = [bMoves, ...aDeletes];
    for (let seed = 1; seed <= 6; seed++) {
      const state = replayAllEvents([...a.events, ...shared, ...shuffled(extra, seed)]);
      expect(getDeckFolder(state, KO)?.id).toBe('f2');
      expect(getDeckPreset(state, KO)?.id).toBe('p2');
    }
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

  it('seeds a preset from a deck, so the deck needs no settings fan-out', () => {
    const { events } = setup();
    const state = replayAllEvents(events);
    const deck = state.decks.get(KO);
    if (!deck) throw new Error('missing deck');
    const seed = presetSeedFromDeck(state, deck, NOW);
    expect(seed).toEqual({
      settings: { new_cards_per_day: 20, max_reviews_per_day: 200, target_retention: 0.9 },
    });
    expect(buildPresetSettingsPayloads(state, seed, [KO])).toEqual([]);
    expect(buildPresetParamsPayloads(state, seed, [KO], NOW, DEV_A)).toEqual([]);
  });

  it('copies only the given fields, and only where they differ', () => {
    const state = replayAllEvents(setup().events);
    const preset = {
      settings: { new_cards_per_day: 5, max_reviews_per_day: 200, target_retention: 0.85 },
    };
    expect(buildPresetSettingsPayloads(state, preset, [KO])).toEqual([
      { deck_id: KO, settings: { new_cards_per_day: 5, target_retention: 0.85 } },
    ]);
    expect(buildPresetSettingsPayloads(state, preset, [KO], ['new_cards_per_day'])).toEqual([
      { deck_id: KO, settings: { new_cards_per_day: 5 } },
    ]);
    expect(
      buildPresetParamsPayloads(state, preset, [KO], NOW, { ...DEV_A, fields: ['w'] }),
    ).toEqual([]);
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
    const payloads = buildPresetParamsPayloads(state, preset, [KO, JA], NOW, DEV_A);
    expect(payloads.map((p) => [p.deck_id, p.params.request_retention, p.params.w])).toEqual(
      [JA, KO].sort().map((id) => [id, 0.85, undefined]),
    );
    for (const payload of payloads) {
      events.push(factory.create('DeckFSRSParamsChanged', payload, NOW));
    }
    state = replayAllEvents(events);
    expect(resolveDeckFsrsConfig(state, KO, NOW + 1).request_retention).toBe(0.85);
    expect(buildPresetParamsPayloads(state, preset, [KO, JA], NOW + 1, DEV_A)).toEqual([]);

    // Shared weights replace each deck's own; a reschedule writes every deck.
    const withW = { ...preset, w: W21 };
    const second = buildPresetParamsPayloads(state, withW, [KO, JA], NOW + 2, DEV_A);
    expect(second.map((p) => p.params.w)).toEqual([W21, W21]);
    for (const p of second) {
      expect(p.params_version).toBe(nextPresetParamsVersion(state, p.deck_id, NOW + 2, 'dev-a'));
      expect(p.params_version).toBeGreaterThan(getActiveFsrsParamsVersion(state, p.deck_id));
    }
    const all = buildPresetParamsPayloads(state, preset, [KO], NOW + 2, {
      ...DEV_A,
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
      DEV_A,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.params.w).toEqual(W21);
    expect(out[0]?.params_version).toBeGreaterThan(1);
  });
});

/** What the Library does for a preset edit on one device: save the patch, copy only its fields. */
function editPreset(
  view: FlashEvent[],
  factory: EventFactory,
  presetId: string,
  patch: { settings?: Partial<DeckPresetSettingsShape>; w?: number[] },
  nowMs: number,
): FlashEvent[] {
  const state = replayAllEvents(view);
  const current = getDeckOrganization(state).presets.get(presetId);
  const payload = buildDeckPresetSavedPayload({ presetId, ...patch });
  if (!current || !payload) throw new Error('bad edit');
  const next = {
    settings: { ...current.settings, ...payload.settings },
    ...((payload.w ?? current.w) ? { w: payload.w ?? current.w } : {}),
  };
  const fields = [
    ...Object.keys(payload.settings ?? {}),
    ...(payload.w ? ['w'] : []),
  ] as PresetField[];
  const deckIds = listPresetDeckIds(state, presetId);
  return [
    factory.create('DeckPresetSaved', payload, nowMs),
    ...buildPresetSettingsPayloads(state, next, deckIds, fields).map((p) =>
      factory.create('DeckSettingsChanged', p, nowMs),
    ),
    ...buildPresetParamsPayloads(state, next, deckIds, nowMs, {
      deviceId: factory.deviceId,
      fields,
    }).map((p) => factory.create('DeckFSRSParamsChanged', p, nowMs)),
  ];
}

type DeckPresetSettingsShape = {
  new_cards_per_day: number;
  max_reviews_per_day: number;
  target_retention: number;
};

/** One catch-up pass on a device's view, as the Library runs it. */
function catchUp(view: readonly FlashEvent[], factory: EventFactory, nowMs: number): FlashEvent[] {
  const { settings, params } = buildPresetCatchUp(replayAllEvents(view), nowMs, factory.deviceId);
  return [
    ...settings.map((p) => factory.create('DeckSettingsChanged', p, nowMs)),
    ...params.map((p) => factory.create('DeckFSRSParamsChanged', p, nowMs)),
  ];
}

/** Every member deck's own settings and active retention/weights equal its preset's. */
function membersMatch(events: readonly FlashEvent[], nowMs: number): boolean {
  const state = replayAllEvents(events);
  for (const preset of listDeckPresets(state)) {
    for (const deckId of listPresetDeckIds(state, preset.id)) {
      const own = state.decks.get(deckId)?.settings;
      const fsrs = resolveDeckFsrsConfig(state, deckId, nowMs);
      if (
        own?.new_cards_per_day !== preset.settings.new_cards_per_day ||
        own.max_reviews_per_day !== preset.settings.max_reviews_per_day ||
        own.target_retention !== preset.settings.target_retention ||
        fsrs.request_retention !== preset.settings.target_retention ||
        (preset.w !== undefined && JSON.stringify(fsrs.w) !== JSON.stringify(preset.w))
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Two devices that share a preset with the Korean and Japanese decks. */
function twoDevices() {
  const a = setup('dev-a');
  const b = createEventFactory('dev-b', 0, createHlcState('dev-b', SAMPLE_SEED_EPOCH_MS));
  const shared: FlashEvent[] = [...a.events];
  shared.push(
    a.factory.create('DeckPresetSaved', { preset_id: 'p1', name: 'Shared' }, T0),
    a.factory.create('DeckGroupingChanged', { deck_id: KO, preset_id: 'p1' }, T0 + 1),
    a.factory.create('DeckGroupingChanged', { deck_id: JA, preset_id: 'p1' }, T0 + 2),
  );
  return { a: a.factory, b, shared };
}

const settingsField = fc.constantFrom<keyof DeckPresetSettingsShape>(
  'new_cards_per_day',
  'max_reviews_per_day',
  'target_retention',
);
const valueFor = (field: keyof DeckPresetSettingsShape) =>
  field === 'target_retention'
    ? fc.constantFrom(0.8, 0.85, 0.95)
    : fc.integer({ min: 1, max: 400 });
const edit = settingsField.chain((field) => valueFor(field).map((value) => ({ field, value })));

describe('presets across devices', () => {
  it('two devices’ concurrent edits reach every member deck, in any delivery order', () => {
    fc.assert(
      fc.property(
        edit,
        edit,
        fc.boolean(),
        fc.integer({ min: 0, max: 1_000 }),
        (ea, eb, w, seed) => {
          const { a, b, shared } = twoDevices();
          // Both edit from the same synced view, A first; B also applies optimized weights.
          const aEvents = editPreset(
            shared,
            a,
            'p1',
            { settings: { [ea.field]: ea.value } },
            T0 + 100,
          );
          const bEvents = [
            ...editPreset(shared, b, 'p1', { settings: { [eb.field]: eb.value } }, T0 + 200),
          ];
          if (w) {
            bEvents.push(...editPreset([...shared, ...bEvents], b, 'p1', { w: W21 }, T0 + 300));
          }
          const merged = [...shared, ...shuffled([...aEvents, ...bEvents], seed + 1)];
          const state = replayAllEvents(merged);
          const preset = getDeckPreset(state, KO);
          expect(preset?.settings[eb.field]).toBe(eb.value);
          if (ea.field !== eb.field) expect(preset?.settings[ea.field]).toBe(ea.value);
          // Copies carry only the edited fields and deck settings merge per field, so the decks'
          // own settings already match the merged preset without catch-up.
          for (const deckId of [KO, JA]) {
            expect(state.decks.get(deckId)?.settings).toMatchObject(preset?.settings ?? {});
          }
          // An FSRS version carries retention and weights together, so a retention copy racing a
          // weights copy can leave the active version one field behind: one catch-up pass fixes it,
          // and a second pass writes nothing.
          const healed = [...merged, ...catchUp(merged, a, NOW)];
          expect(membersMatch(healed, NOW + 1)).toBe(true);
          expect(catchUp(healed, b, NOW + 1)).toEqual([]);
          // Nothing an edit wrote was lost: every FSRS version written is still kept.
          const versions = (deckId: string) =>
            (state.deckFsrsParams.get(deckId) ?? []).map((v) => v.params_version);
          const written = [...aEvents, ...bEvents].filter(
            (e) => e.type === 'DeckFSRSParamsChanged',
          );
          for (const deckId of [KO, JA]) {
            expect(versions(deckId)).toHaveLength(
              written.filter((e) => (e.payload as { deck_id: string }).deck_id === deckId).length,
            );
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('concurrent retention and weight copies keep both versions; reviews keep their own', () => {
    const { a, b, shared } = twoDevices();
    const aEvents = editPreset(shared, a, 'p1', { settings: { target_retention: 0.8 } }, T0 + 100);
    const bEvents = editPreset(shared, b, 'p1', { w: W21 }, T0 + 100);
    const state = replayAllEvents([...shared, ...aEvents, ...bEvents]);
    const kept = state.deckFsrsParams.get(KO) ?? [];
    expect(kept).toHaveLength(2);
    const aVersion = aEvents.find((e) => e.type === 'DeckFSRSParamsChanged')?.payload as {
      params_version: number;
    };
    expect(resolveDeckFsrsConfig(state, KO, NOW, aVersion.params_version).request_retention).toBe(
      0.8,
    );
    // Whichever version is active, catch-up brings the deck to the merged preset, once.
    const healed = [...shared, ...aEvents, ...bEvents];
    healed.push(...catchUp(healed, b, NOW));
    expect(membersMatch(healed, NOW + 1)).toBe(true);
    expect(catchUp(healed, a, NOW + 2)).toEqual([]);
    expect(resolveDeckFsrsConfig(replayAllEvents(healed), KO, NOW + 1)).toMatchObject({
      request_retention: 0.8,
      w: W21,
    });
  });

  it('catch-up heals a deck that joined during an edit, and an older build’s deck edit', () => {
    const { a, b, shared } = twoDevices();
    const aEdit = editPreset(shared, a, 'p1', { settings: { new_cards_per_day: 7 } }, T0 + 100);
    // B adds the Chinese deck without having seen A's edit: it copies the old values.
    const bView = replayAllEvents(shared);
    const bPreset = getDeckOrganization(bView).presets.get('p1');
    if (!bPreset) throw new Error('missing preset');
    const bJoin = [
      b.create('DeckGroupingChanged', { deck_id: ZH, preset_id: 'p1' }, T0 + 200),
      ...buildPresetSettingsPayloads(bView, bPreset, [ZH]).map((p) =>
        b.create('DeckSettingsChanged', p, T0 + 200),
      ),
    ];
    // An older build that knows nothing of presets edits a member deck's own settings.
    const old = createEventFactory('dev-old', 0, createHlcState('dev-old', T0 + 300));
    const oldEdit = [
      old.create(
        'DeckSettingsChanged',
        { deck_id: KO, settings: { new_cards_per_day: 50, target_retention: 0.75 } },
        T0 + 300,
      ),
      old.create(
        'DeckFSRSParamsChanged',
        {
          deck_id: KO,
          params_version: 1,
          effective_from: T0 + 300,
          params: { request_retention: 0.75 },
        },
        T0 + 300,
      ),
    ];
    const merged = [...shared, ...aEdit, ...bJoin, ...oldEdit];
    expect(membersMatch(merged, NOW)).toBe(false);

    // Both devices run catch-up at once on the merged log, then sync again.
    const fixA = catchUp(merged, a, NOW);
    const fixB = catchUp(merged, b, NOW + 5);
    expect(fixA.length).toBeGreaterThan(0);
    for (const order of [
      [...fixA, ...fixB],
      [...fixB, ...fixA],
    ]) {
      const healed = [...merged, ...order];
      expect(membersMatch(healed, NOW + 10)).toBe(true);
      expect(catchUp(healed, a, NOW + 10)).toEqual([]);
      expect(catchUp(healed, b, NOW + 10)).toEqual([]);
    }
    const state = replayAllEvents([...merged, ...fixA]);
    expect(state.decks.get(ZH)?.settings.new_cards_per_day).toBe(7);
    expect(state.decks.get(KO)?.settings.new_cards_per_day).toBe(7);
    expect(state.decks.get(KO)?.settings.target_retention).toBe(0.9);
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
