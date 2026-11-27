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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildStarterDeckEvents,
  findStarterDeck,
  loadStarterDeck,
  STARTER_SEED_EPOCH_MS,
} from '../../core/src/starters/index.ts';
import { legacyStarterFields, loadStarterLegacyGlosses } from '../../core/src/starters/upgrade.ts';
import { SyncRuntime, type SyncRuntimeProps } from '../src/state/SyncRuntime.tsx';
import type { SyncUiState } from '../src/state/useSyncController.ts';

vi.mock('../src/state/useSyncController.ts', () => ({
  useSyncController: () => ({}),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLUG = 'starter-zh-common';
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

/** Waits for the lazy upgrade chunk and the deck loads behind it. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 250))));

function mount(state: CollectionState, syncState: SyncUiState) {
  const emitted: (readonly KnownEvent[])[] = [];
  const emitEventsRef = {
    current: (events: readonly KnownEvent[]) => {
      emitted.push(events);
      applyEvents(state, events);
    },
  };
  const props = (next: SyncUiState): SyncRuntimeProps =>
    ({
      shell: { attach: () => undefined },
      emitEventsRef,
      syncState: next,
      stateRef: { current: state },
      factoryRef: { current: factory() },
    }) as unknown as SyncRuntimeProps;
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  const render = (next: SyncUiState) =>
    act(() => root?.render(createElement(SyncRuntime, props(next))));
  render(syncState);
  return { emitted, render };
}

describe('SyncRuntime starter-deck upgrade wiring', () => {
  it('with no sync provider, upgrades a starter deck once through emitEvents', async () => {
    const state = await seeded110();
    const { emitted, render } = mount(state, sync({}));
    await settle();
    expect(emitted).toHaveLength(1);

    // Re-rendering (a state change, a sync tick) never runs it again within the launch.
    render(sync({ status: 'idle' }));
    await settle();
    expect(emitted).toHaveLength(1);
  });

  it('with a sync provider, waits for a sync that completes in this launch', async () => {
    const state = await seeded110();
    const before = Date.now();
    const staleSync = sync({
      provider: 'google_drive',
      status: 'synced',
      lastSyncedAt: before - 60_000,
    });
    const { emitted, render } = mount(state, staleSync);
    await settle();
    // The "synced" a device shows from its stored cursor says nothing about this launch.
    expect(emitted).toHaveLength(0);

    render({ ...staleSync, lastSyncedAt: Date.now() + 1_000 });
    await settle();
    expect(emitted).toHaveLength(1);
  });

  it('a read-only (upgrade required) device never upgrades', async () => {
    const state = await seeded110();
    const { emitted } = mount(state, sync({ readOnly: true }));
    await settle();
    expect(emitted).toHaveLength(0);
  });

  it('a collection without a starter deck emits nothing', async () => {
    const { emitted } = mount(createEmptyState(), sync({}));
    await settle();
    expect(emitted).toHaveLength(0);
  });
});
