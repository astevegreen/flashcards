// @vitest-environment happy-dom
// The launch check in AppContext: with nothing saved in `linked_sources_v1`, a deck synced from
// another device that carries a linked source still starts the background refresh.
import {
  BUILTIN_NOTE_TYPE_IDS,
  createEventFactory,
  createHlcState,
  type FlashEvent,
  type SourceRef,
} from '@flash/core';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  type Mounted,
} from './helpers/app-harness.tsx';

const refreshAllSources = vi.fn(async () => ({}));
vi.mock('../src/sources/sourceRunner.ts', () => ({ refreshAllSources }));
// The launch check's own promise, so a test waits for the check to finish rather than for a guessed delay (a
// fixed 80 ms plus five ticks timed out when parallel gates loaded the machine).
const check = vi.hoisted(() => ({ runs: [] as Promise<void>[] }));
vi.mock('../src/sources/launchSourceCheck.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/launchSourceCheck.ts')>();
  return {
    ...actual,
    runLaunchSourceCheck: (...args: Parameters<typeof actual.runLaunchSourceCheck>) => {
      const run = actual.runLaunchSourceCheck(...args);
      check.runs.push(run);
      return run;
    },
  };
});

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  refreshAllSources.mockClear();
  check.runs.length = 0;
});

/** One deck created on another device, optionally carrying `source`. */
function deckFromOtherDevice(source?: SourceRef): FlashEvent[] {
  const factory = createEventFactory('other', 0, createHlcState('other', 1000));
  return [
    factory.create(
      'DeckCreated',
      {
        deck_id: 'deck-synced',
        name: 'Synced deck',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        ...(source ? { source } : {}),
        created_at: 1000,
      },
      1000,
    ),
  ];
}

async function launch(events: FlashEvent[]): Promise<void> {
  const storage = createMemoryStorage();
  storage.kv.set('linked_sources_v1', {
    googleSources: [],
    oneDriveSources: [],
    dropboxSources: [],
    localFolders: [],
    packageSubscriptions: [],
    catalogs: [],
  });
  mounted = await mountWithApp(null, {
    platform: createTestPlatform(storage),
    initialEvents: events,
  });
  // The check starts 50 ms after first paint and lazy-loads its modules; wait until it has started, then for it to
  // finish.
  await vi.waitFor(
    async () => {
      await flush(1);
      expect(check.runs).toHaveLength(1);
    },
    { timeout: 4_000, interval: 20 },
  );
  await act(async () => {
    await check.runs[0];
  });
}

describe('launch refresh of linked sources', () => {
  it('runs for a synced deck that carries a linked source, with an empty saved registry', async () => {
    await launch(
      deckFromOtherDevice({ kind: 'dropbox_file', external_id: 'file-1', read_only: true }),
    );
    expect(refreshAllSources).toHaveBeenCalledTimes(1);
  });

  it('does not run when no deck carries a linked source', async () => {
    await launch(deckFromOtherDevice());
    expect(refreshAllSources).not.toHaveBeenCalled();
  });
});
