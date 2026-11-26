import { describe, expect, it, vi } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type CollectionState,
  type KnownEvent,
} from '../../core/src/index.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../../core/src/samples/decks.ts';
import {
  buildStarterDeckEvents,
  findStarterDeck,
  loadStarterDeck,
  STARTER_SEED_EPOCH_MS,
} from '../../core/src/starters/index.ts';
import {
  legacyStarterFields,
  loadStarterLegacyGlosses,
  starterDeckVersion,
} from '../../core/src/starters/upgrade.ts';
import * as starterUpgrade from '../src/onboarding/starterUpgrade.ts';
import {
  hasStarterDeck,
  runStarterDeckUpgradeAtLaunch,
} from '../src/onboarding/starterUpgradeLaunch.ts';
import { isLeechBackfillReady } from '../src/state/leechBackfillGate.ts';

const SLUG = 'starter-zh-common';
const newFactory = () =>
  createEventFactory('dev-a', 0, createHlcState('dev-a', STARTER_SEED_EPOCH_MS));

/** A collection holding the Mandarin starter deck as 1.1.0 seeded it. */
async function seeded110(): Promise<CollectionState> {
  const info = findStarterDeck(SLUG);
  if (!info) throw new Error('missing deck');
  const content = await loadStarterDeck(SLUG);
  const legacy = await loadStarterLegacyGlosses();
  const old = content.notes.map((n) => ({
    ...n,
    fields: legacyStarterFields(SLUG, n, legacy, '1.1.0') ?? n.fields,
  }));
  return applyEvents(
    createEmptyState(),
    buildStarterDeckEvents(newFactory(), { ...info, version: '1.1.0' }, { slug: SLUG, notes: old }),
  );
}

function launchOn(state: CollectionState) {
  const factory = newFactory();
  const emitted: (readonly KnownEvent[])[] = [];
  const emit = (events: readonly KnownEvent[]) => {
    emitted.push(events);
    applyEvents(state, events);
  };
  return {
    emitted,
    launch: { getState: () => state, factory: { current: factory }, emitEvents: { current: emit } },
  };
}

describe('starter-deck upgrade at launch', () => {
  it('upgrades a deck seeded from 1.1.0 once, through emitEvents', async () => {
    const info = findStarterDeck(SLUG);
    if (!info) throw new Error('missing deck');
    const content = await loadStarterDeck(SLUG);
    const state = await seeded110();
    const { emitted, launch } = launchOn(state);

    await expect(runStarterDeckUpgradeAtLaunch(launch)).resolves.toBe(true);
    expect(emitted).toHaveLength(1);
    expect(starterDeckVersion(state, info)).toBe(info.version);
    for (const n of content.notes) {
      const ev = emitted[0]?.find(
        (e) => e.type === 'NoteUpserted' && e.payload.source_key === n.key,
      );
      expect(ev, n.key).toBeDefined();
    }
    for (const note of state.notes.values()) {
      const current = content.notes.find((n) => n.key === note.source_key);
      expect(note.fields).toEqual(current?.fields);
    }

    // A relaunch loads the upgrade again but writes nothing.
    await expect(runStarterDeckUpgradeAtLaunch(launch)).resolves.toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it('only loads the upgrade when a deck came from the starter catalog', async () => {
    const load = vi.fn(() => Promise.resolve(starterUpgrade));
    const empty = createEmptyState();
    const samples = applyEvents(
      createEmptyState(),
      buildSampleDeckEvents(newFactory(), SAMPLE_SEED_EPOCH_MS),
    );
    expect(samples.decks.size).toBeGreaterThan(0);
    for (const state of [empty, samples]) {
      expect(hasStarterDeck(state)).toBe(false);
      await expect(runStarterDeckUpgradeAtLaunch(launchOn(state).launch, load)).resolves.toBe(
        false,
      );
    }
    expect(load).not.toHaveBeenCalled();

    const starter = await seeded110();
    expect(hasStarterDeck(starter)).toBe(true);
    await runStarterDeckUpgradeAtLaunch(launchOn(starter).launch, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('passes a chunk that fails to load on to the caller, which logs it', async () => {
    const state = await seeded110();
    const { emitted, launch } = launchOn(state);
    const failed = runStarterDeckUpgradeAtLaunch(launch, () =>
      Promise.reject(new Error('offline')),
    );
    await expect(failed).rejects.toThrow('offline');
    expect(emitted).toHaveLength(0);
  });

  it('runs behind the leech-backfill sync gate: never before this launch’s sync completes', () => {
    const at = 1_800_000_000_000;
    const gate = (sync: Parameters<typeof isLeechBackfillReady>[0]) =>
      isLeechBackfillReady(sync, at);
    expect(gate({ provider: 'none', status: 'disconnected', readOnly: false })).toBe(true);
    const synced = { provider: 'google_drive', status: 'synced', readOnly: false } as const;
    expect(gate({ ...synced, lastSyncedAt: at - 1 })).toBe(false);
    expect(gate({ ...synced, lastSyncedAt: at + 1 })).toBe(true);
    expect(gate({ ...synced, readOnly: true, lastSyncedAt: at + 1 })).toBe(false);
  });
});
