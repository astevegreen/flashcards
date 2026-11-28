// @vitest-environment happy-dom
// The wiring of the launch-time starter-deck upgrade inside SyncRuntime (#83): the hook reads the
// runtime's sync state, state ref, factory ref and emit ref, and runs the upgrade once behind the
// leech-backfill sync gate. The sync controller itself is stubbed out; it is not what is tested.
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type CollectionState,
  type KnownEvent,
} from '@flash/core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildStarterDeckEvents,
  findStarterDeck,
  loadStarterDeck,
  starterDeckId,
  STARTER_SEED_EPOCH_MS,
} from '../../core/src/starters/index.ts';
import { deriveNoteId } from '../../core/src/ids.ts';
import { legacyStarterFields, loadStarterLegacyGlosses } from '../../core/src/starters/upgrade.ts';
import { SyncRuntime, type SyncRuntimeProps } from '../src/state/SyncRuntime.tsx';
import type * as StarterUpgrade from '../src/onboarding/starterUpgrade.ts';
import type { SyncShell } from '../src/state/syncShell.ts';
import { createSyncStateStore } from '../src/state/syncStateStore.ts';
import type { SyncUiState } from '../src/state/useSyncController.ts';

vi.mock('../src/state/useSyncController.ts', () => ({
  useSyncController: () => ({}),
}));

// The real upgrade, wrapped so a test can tell whether the hook decided to run it.
const upgradeRuns = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/onboarding/starterUpgrade.ts', async (original) => {
  const actual = await original<typeof StarterUpgrade>();
  return {
    ...actual,
    runStarterDeckUpgrade: (...args: Parameters<typeof actual.runStarterDeckUpgrade>) => {
      upgradeRuns.count += 1;
      return actual.runStarterDeckUpgrade(...args);
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLUG = 'starter-zh-common';
/** The ids of the seeded deck's notes (filled by `seeded110`). */
const seededNoteIds = new Set<string>();
const factory = () =>
  createEventFactory('dev-a', 0, createHlcState('dev-a', STARTER_SEED_EPOCH_MS));

/** A collection holding the Mandarin starter deck as 1.1.0 seeded it. */
async function seeded110(): Promise<CollectionState> {
  const info = findStarterDeck(SLUG);
  if (!info) throw new Error('missing deck');
  const content = await loadStarterDeck(SLUG);
  const legacy = await loadStarterLegacyGlosses();
  const notes = content.notes.map((n) => ({
    ...n,
    fields: legacyStarterFields(SLUG, n, legacy, '1.1.0') ?? n.fields,
  }));
  for (const n of notes) seededNoteIds.add(deriveNoteId(starterDeckId(SLUG), n.key));
  return applyEvents(
    createEmptyState(),
    buildStarterDeckEvents(factory(), { ...info, version: '1.1.0' }, { slug: SLUG, notes }),
  );
}

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const sync = (over: Partial<SyncUiState>): SyncUiState =>
  ({ provider: 'none', status: 'disconnected', readOnly: false, ...over }) as SyncUiState;

/** Lets the effects and the microtasks they queue run (the gated and empty cases decide there). */
const flush = () => act(async () => undefined);

function mount(state: CollectionState, syncState: SyncUiState) {
  // The upgrade reads the state before its first await, so a read marks "past the gate".
  const reads = { count: 0 };
  const stateRef = {
    get current() {
      reads.count += 1;
      return state;
    },
  };
  const emitted: (readonly KnownEvent[])[] = [];
  const emitEventsRef = {
    current: (events: readonly KnownEvent[]) => {
      emitted.push(events);
      applyEvents(state, events);
    },
  };
  // SyncRuntime reads the sync state from AppProvider's store (P3), so a new state is a store set.
  // `satisfies` keeps every key a real prop; only the stubbed controller options are left out.
  const syncStore = createSyncStateStore(syncState);
  const props = {
    shell: { attach: () => undefined } as Partial<SyncShell> as SyncShell,
    emitEventsRef,
    syncStore,
    stateRef,
    factoryRef: { current: factory() },
  } satisfies Partial<SyncRuntimeProps>;
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root?.render(createElement(SyncRuntime, props as unknown as SyncRuntimeProps)));
  const render = (next: SyncUiState) => act(() => syncStore.set(next));
  return { emitted, render, reads };
}

/** Every emitted event belongs to the starter deck, and the upgrade rewrites its notes. */
function expectStarterUpgrade(events: readonly KnownEvent[] | undefined): void {
  expect(events?.length).toBeGreaterThan(0);
  const deckId = starterDeckId(SLUG);
  expect(events?.some((e) => e.type === 'StarterNoteUpgraded')).toBe(true);
  for (const e of events ?? []) {
    if (e.type === 'StarterNoteUpgraded') {
      expect(seededNoteIds.has(e.payload.note_id)).toBe(true);
    } else {
      expect((e.payload as { deck_id?: string }).deck_id).toBe(deckId);
    }
  }
}

describe('SyncRuntime starter-deck upgrade wiring', () => {
  beforeEach(() => {
    upgradeRuns.count = 0;
  });

  it('with no sync provider, upgrades a starter deck once through emitEvents', async () => {
    const state = await seeded110();
    const { emitted, render } = mount(state, sync({}));
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expectStarterUpgrade(emitted[0]);

    // Re-rendering (a state change, a sync tick) never runs it again within the launch.
    render(sync({ status: 'idle' }));
    await flush();
    expect(upgradeRuns.count).toBe(1);
    expect(emitted).toHaveLength(1);
  });

  it('with a sync provider, waits for a sync that completes in this launch', async () => {
    const state = await seeded110();
    const staleSync = sync({
      provider: 'google_drive',
      status: 'synced',
      lastSyncedAt: Date.now() - 60_000,
    });
    const { emitted, render, reads } = mount(state, staleSync);
    await flush();
    // The "synced" a device shows from its stored cursor says nothing about this launch: the gate
    // is closed, so the effect returned before it read the state or loaded anything.
    expect(reads.count).toBe(0);
    expect(upgradeRuns.count).toBe(0);
    expect(emitted).toHaveLength(0);

    render({ ...staleSync, lastSyncedAt: Date.now() + 1_000 });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expectStarterUpgrade(emitted[0]);
  });

  it('a read-only (upgrade required) device never upgrades', async () => {
    const state = await seeded110();
    const { emitted, reads } = mount(state, sync({ readOnly: true }));
    await flush();
    expect(reads.count).toBe(0);
    expect(upgradeRuns.count).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('a collection without a starter deck emits nothing and loads nothing', async () => {
    // The starter deck's notes, but under another package id: a copy, not a catalog deck.
    const state = await seeded110();
    for (const deck of state.decks.values()) {
      if (deck.source) deck.source = { ...deck.source, package_id: `my-copy:${SLUG}` };
    }
    const { emitted, reads } = mount(state, sync({}));
    await flush();
    // Had the hook gone on, its lazy load of the upgrade module has settled by now.
    await import('../src/onboarding/starterUpgrade.ts');
    await flush();
    await flush();
    // Past the gate (the state was read once to look for a starter deck), then stopped there:
    // the upgrade's entry point never ran.
    expect(reads.count).toBe(1);
    expect(upgradeRuns.count).toBe(0);
    expect(emitted).toHaveLength(0);
  });
});
