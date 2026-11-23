import { validatePackageManifest } from '@flash/content-schema';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  packBackup,
  buildBackup,
  planBackupRestore,
  readBackupArchive,
  restoreStepsToEvents,
} from '../src/backup/index.ts';
import { getDeckDescription } from '../src/decks/description.ts';
import {
  getDeckFolder,
  getDeckOrganization,
  getDeckPreset,
  listDeckFolders,
  listDeckPresets,
} from '../src/decks/organization.ts';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  replayAllEvents,
  resolveDeckFsrsConfig,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { decodeUtf8 } from '../src/utf8-decode.ts';
import { FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';

const KO = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
const JA = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ja-vocab');
const T0 = SAMPLE_SEED_EPOCH_MS + 60_000;
const DAY = 86_400_000;
const W21 = Array.from({ length: 21 }, (_, i) => Math.round((0.1 + i * 0.05) * 1e4) / 1e4);
const PKG = 'pkg:travel';

function factoryFor(device: string): EventFactory {
  return createEventFactory(device, 0, createHlcState(device, SAMPLE_SEED_EPOCH_MS));
}

/** Sample decks; KO in preset "Daily" (with weights) and folder "Korean", with a description. */
function organized(): { factory: EventFactory; events: FlashEvent[]; state: CollectionState } {
  const factory = factoryFor('dev-a');
  const events: FlashEvent[] = [...buildSampleDeckEvents(factory)];
  events.push(
    factory.create(
      'DeckPresetSaved',
      {
        preset_id: 'preset-daily',
        name: 'Daily',
        settings: { new_cards_per_day: 7, max_reviews_per_day: 70, target_retention: 0.85 },
        w: W21,
      },
      T0,
    ),
    factory.create('DeckFolderSaved', { folder_id: 'folder-ko', name: 'Korean' }, T0),
    factory.create(
      'DeckGroupingChanged',
      { deck_id: KO, preset_id: 'preset-daily', folder_id: 'folder-ko' },
      T0,
    ),
    factory.create(
      'DeckSettingsChanged',
      {
        deck_id: KO,
        settings: { new_cards_per_day: 7, max_reviews_per_day: 70, target_retention: 0.85 },
      },
      T0,
    ),
    factory.create('DeckDescriptionChanged', { deck_id: KO, description: 'Airport words.' }, T0),
  );
  return { factory, events, state: replayAllEvents(events) };
}

function manifestOf(pkg: Uint8Array): unknown {
  const files = unzipSync(pkg);
  return JSON.parse(decodeUtf8(files['manifest.json'] ?? new Uint8Array()));
}

/** Imports into `state` (mutated) and returns the import's events. */
function importInto(state: CollectionState, pkg: Uint8Array, factory: EventFactory) {
  const result = importFlashpkg(pkg, state, factory, { nowMs: T0 + DAY });
  applyEvents(state, result.events);
  return result;
}

describe('.flashpkg presets and folders: export', () => {
  it('writes the presets and folders the exported decks use (golden manifest)', async () => {
    const { state } = organized();
    const manifest = manifestOf(exportFlashpkg(state, { deckId: KO, packageId: PKG }));
    expect(validatePackageManifest(manifest).ok).toBe(true);
    await expect(JSON.stringify(manifest, null, 2) + '\n').toMatchFileSnapshot(
      './__golden__/flashpkg-groups-manifest.json.snap',
    );
  });

  it('leaves both out for decks on their own settings and unfiled', () => {
    const { state } = organized();
    const manifest = manifestOf(exportFlashpkg(state, { deckId: JA })) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('presets');
    expect(manifest).not.toHaveProperty('folders');
    const decks = manifest['decks'] as Array<Record<string, unknown>>;
    expect(decks[0]).not.toHaveProperty('preset_id');
    expect(decks[0]).not.toHaveProperty('folder_id');
  });

  it('keeps older packages valid: the new fields are optional', () => {
    const old = {
      package_id: 'pkg:old',
      name: 'Old',
      version: '1.0.0',
      format_version: 1,
      decks: [{ id: 'd', name: 'D', file: 'decks/d.jsonl', note_type_id: 'nt' }],
    };
    expect(validatePackageManifest(old).ok).toBe(true);
  });
});

describe('.flashpkg presets and folders: import', () => {
  it('round-trips into an empty collection: preset, folder, settings, weights, description', () => {
    const { state } = organized();
    const pkg = exportFlashpkg(state, { deckId: KO, packageId: PKG });
    const fresh = createEmptyState();
    importInto(fresh, pkg, factoryFor('dev-b'));
    const deckId = [...fresh.decks.keys()][0] ?? '';
    expect(getDeckPreset(fresh, deckId)).toEqual(getDeckPreset(state, KO));
    expect(getDeckFolder(fresh, deckId)).toEqual(getDeckFolder(state, KO));
    expect(fresh.decks.get(deckId)?.settings).toMatchObject({
      new_cards_per_day: 7,
      max_reviews_per_day: 70,
      target_retention: 0.85,
    });
    const fsrs = resolveDeckFsrsConfig(fresh, deckId, T0 + 2 * DAY);
    expect(fsrs.w).toEqual(W21);
    expect(fsrs.request_retention).toBe(0.85);
    expect(getDeckDescription(fresh, deckId)).toBe('Airport words.');

    // A second import of the same package writes no preset, folder or grouping events.
    const again = importFlashpkg(pkg, fresh, factoryFor('dev-b'), { nowMs: T0 + 2 * DAY });
    const types = new Set(again.events.map((e) => e.type));
    for (const t of ['DeckPresetSaved', 'DeckFolderSaved', 'DeckGroupingChanged'] as const) {
      expect(types.has(t)).toBe(false);
    }
  });

  it('never overwrites a preset or folder the user has with the same id', () => {
    const { state, factory } = organized();
    const pkg = exportFlashpkg(state, { deckId: KO, packageId: PKG });
    // The user edits the preset and renames the folder after exporting.
    applyEvents(state, [
      factory.create(
        'DeckPresetSaved',
        { preset_id: 'preset-daily', name: 'Mine', settings: { new_cards_per_day: 3 } },
        T0 + 10,
      ),
      factory.create('DeckFolderSaved', { folder_id: 'folder-ko', name: 'Mine too' }, T0 + 10),
    ]);
    const result = importInto(state, pkg, factory);
    expect(result.events.some((e) => e.type === 'DeckPresetSaved')).toBe(false);
    expect(result.events.some((e) => e.type === 'DeckFolderSaved')).toBe(false);
    expect(listDeckPresets(state).map((p) => [p.name, p.settings.new_cards_per_day])).toEqual([
      ['Mine', 3],
    ]);
    expect(listDeckFolders(state).map((f) => f.name)).toEqual(['Mine too']);
  });

  it('joins a preset or folder with the same name, else creates one with the package id', () => {
    const { state } = organized();
    const pkg = exportFlashpkg(state, { deckId: KO, packageId: PKG });
    const b = factoryFor('dev-b');
    const other = replayAllEvents(buildSampleDeckEvents(b));
    applyEvents(other, [
      b.create(
        'DeckPresetSaved',
        { preset_id: 'b-preset', name: ' Daily ', settings: { new_cards_per_day: 2 } },
        T0,
      ),
    ]);
    importInto(other, pkg, b);
    // KO exists on B (same sample id), has no grouping history, so it joins.
    expect(getDeckPreset(other, KO)?.id).toBe('b-preset');
    expect(other.decks.get(KO)?.settings.new_cards_per_day).toBe(2);
    expect(getDeckFolder(other, KO)).toEqual({ id: 'folder-ko', name: 'Korean' });
  });

  it('never brings back a preset or folder the user deleted', () => {
    const { state } = organized();
    const pkg = exportFlashpkg(state, { deckId: KO, packageId: PKG });
    // Device B once had (synced) the preset and folder and deleted them; the deck is new there.
    const b = factoryFor('dev-b');
    const other = createEmptyState();
    applyEvents(other, [
      b.create('DeckPresetDeleted', { preset_id: 'preset-daily' }, T0 + 10),
      b.create('DeckFolderDeleted', { folder_id: 'folder-ko' }, T0 + 10),
    ]);
    const result = importInto(other, pkg, b);
    expect(result.events.some((e) => e.type === 'DeckPresetSaved')).toBe(false);
    expect(result.events.some((e) => e.type === 'DeckFolderSaved')).toBe(false);
    expect(result.decksImported).toBe(1);
    expect(getDeckOrganization(other).presets.size).toBe(0);
    expect(getDeckOrganization(other).folders.size).toBe(0);
    expect(getDeckOrganization(other).presetByDeck.size).toBe(0);
  });

  it('never moves a deck the user placed, even one the user took out of a folder', () => {
    const { state, factory } = organized();
    const pkg = exportFlashpkg(state, { deckId: KO, packageId: PKG });
    applyEvents(state, [
      factory.create(
        'DeckGroupingChanged',
        { deck_id: KO, preset_id: null, folder_id: null },
        T0 + 10,
      ),
    ]);
    const result = importInto(state, pkg, factory);
    expect(result.events.some((e) => e.type === 'DeckGroupingChanged')).toBe(false);
    expect(getDeckPreset(state, KO)).toBeUndefined();
    expect(getDeckFolder(state, KO)).toBeUndefined();
  });

  it('ignores a deck entry pointing at a preset or folder the package lacks', () => {
    const { state } = organized();
    const files = unzipSync(exportFlashpkg(state, { deckId: KO, packageId: PKG }));
    const manifest = JSON.parse(decodeUtf8(files['manifest.json'] ?? new Uint8Array()));
    delete manifest.presets;
    delete manifest.folders;
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    const fresh = createEmptyState();
    const result = importInto(fresh, zipSync(files), factoryFor('dev-b'));
    expect(result.decksImported).toBe(1);
    expect(getDeckOrganization(fresh).presets.size).toBe(0);
    expect(getDeckOrganization(fresh).presetByDeck.size).toBe(0);
  });
});

describe('backup restore: presets, folders and descriptions', () => {
  function backupOf(state: CollectionState) {
    const nowMs = T0 + DAY;
    return readBackupArchive(
      packBackup(
        buildBackup(state, {
          backupId: `b-${nowMs}`,
          kind: 'daily',
          reason: 'auto',
          nowMs,
          deviceId: 'dev-a',
          collectionId: 'col-1',
        }),
        { withMedia: false },
      ).bytes,
    ).state;
  }

  function restore(current: CollectionState, backup: CollectionState, factory: EventFactory) {
    const nowMs = T0 + 10 * DAY;
    const plan = planBackupRestore(current, backup, { nowMs });
    applyEvents(current, restoreStepsToEvents(plan.steps, factory, nowMs));
    return plan;
  }

  function orgView(state: CollectionState) {
    return {
      preset: getDeckPreset(state, KO) && { ...getDeckPreset(state, KO), id: undefined },
      folder: getDeckFolder(state, KO)?.name,
      description: getDeckDescription(state, KO),
      settings: state.decks.get(KO)?.settings,
    };
  }

  it('brings back edited ones under their own ids, as they were at backup time', () => {
    const { state, factory } = organized();
    const backup = backupOf(state);
    const before = orgView(state);
    applyEvents(state, [
      factory.create(
        'DeckPresetSaved',
        { preset_id: 'preset-daily', name: 'Edited', settings: { new_cards_per_day: 1 } },
        T0 + 2 * DAY,
      ),
      factory.create('DeckFolderSaved', { folder_id: 'folder-ko', name: 'Renamed' }, T0 + 2 * DAY),
      factory.create('DeckGroupingChanged', { deck_id: JA, folder_id: 'folder-ko' }, T0 + 2 * DAY),
      factory.create('DeckDescriptionChanged', { deck_id: KO, description: '' }, T0 + 2 * DAY),
    ]);
    const plan = restore(state, backup, factory);
    expect(plan.summary).toMatchObject({
      presetsChanged: 1,
      foldersChanged: 1,
      groupingsChanged: 1,
      descriptionsChanged: 1,
    });
    expect(orgView(state)).toEqual(before);
    expect(getDeckPreset(state, KO)?.id).toBe('preset-daily');
    expect(getDeckFolder(state, JA)).toBeUndefined();
    expect(planBackupRestore(state, backup).steps).toHaveLength(0);
  });

  it('brings deleted ones back under new, stable ids and puts the decks back in them', () => {
    const { state, factory } = organized();
    const backup = backupOf(state);
    const before = orgView(state);
    applyEvents(state, [
      factory.create('DeckPresetDeleted', { preset_id: 'preset-daily' }, T0 + 2 * DAY),
      factory.create('DeckFolderDeleted', { folder_id: 'folder-ko' }, T0 + 2 * DAY),
      factory.create(
        'DeckDescriptionChanged',
        { deck_id: KO, description: 'Package text', from_package: true },
        T0 + 2 * DAY,
      ),
    ]);
    restore(state, backup, factory);
    expect(orgView(state)).toEqual(before);
    expect(getDeckPreset(state, KO)?.id).not.toBe('preset-daily');
    expect(getDeckFolder(state, KO)?.id).not.toBe('folder-ko');
    expect(planBackupRestore(state, backup).steps).toHaveLength(0);
  });

  it('rebuilds them on an empty device', () => {
    const { state } = organized();
    const backup = backupOf(state);
    const fresh = createEmptyState();
    restore(fresh, backup, factoryFor('dev-new'));
    expect(orgView(fresh)).toEqual(orgView(state));
    expect(getDeckPreset(fresh, KO)?.id).toBe('preset-daily');
    expect(planBackupRestore(fresh, backup).steps).toHaveLength(0);
  });

  it('puts a preset without weights back in place of one optimized since', () => {
    const { factory, events } = organized();
    events.push(
      factory.create('DeckPresetSaved', { preset_id: 'preset-plain', name: 'Plain' }, T0 + 1),
      factory.create('DeckGroupingChanged', { deck_id: JA, preset_id: 'preset-plain' }, T0 + 1),
    );
    const state = replayAllEvents(events);
    const backup = backupOf(state);
    applyEvents(state, [
      factory.create('DeckPresetSaved', { preset_id: 'preset-plain', w: W21 }, T0 + 2 * DAY),
    ]);
    restore(state, backup, factory);
    const preset = getDeckPreset(state, JA);
    expect(preset?.name).toBe('Plain');
    expect(preset?.w).toBeUndefined();
    expect(planBackupRestore(state, backup).steps).toHaveLength(0);
  });
});
