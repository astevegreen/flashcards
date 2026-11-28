// @vitest-environment happy-dom
// C9: Check Update on a package whose new version drops notes asks first; Cancel writes nothing.
import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveNoteId,
  type FlashEvent,
} from '@flash/core';
import { exportFlashpkg, importFlashpkg } from '@flash/core/flashpkg';
import type { PackageSubscription, SourcesRegistry } from '@flash/platform';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourcesPanel } from '../src/components/SourcesPanel.tsx';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  type Mounted,
} from './helpers/app-harness.tsx';

const DECK = 'pkg-deck';
const URL = 'https://example.com/words.flashpkg';

function packageBytes(keys: readonly string[], version: string): Uint8Array {
  const pkgState = createEmptyState();
  const f = createEventFactory('cli', 0, createHlcState('cli', 500));
  applyEvents(pkgState, [
    f.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: 'Words',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      500,
    ),
    ...keys.map((k) =>
      f.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(DECK, k),
          deck_id: DECK,
          source_key: k,
          fields: { word: k, meaning: k },
        },
        500,
      ),
    ),
  ]);
  return exportFlashpkg(pkgState, { packageId: 'pkg:words', name: 'Words', version });
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** The Sources panel with one package subscription at v1; the server now serves v2. */
async function mountSubscribed() {
  const v1Events: FlashEvent[] = importFlashpkg(
    packageBytes(['k1', 'k2', 'k3'], '1.0.0'),
    createEmptyState(),
    createEventFactory('other', 0, createHlcState('other', 1000)),
    { nowMs: 1000, sourceOverride: { kind: 'package_url', uri: URL } },
  ).events;
  const storage = createMemoryStorage();
  const sub: PackageSubscription = {
    id: 'sub-1',
    url: URL,
    title: 'Words',
    packageId: 'pkg:words',
    version: '1.0.0',
  };
  const registry: SourcesRegistry = {
    googleSources: [],
    localFolders: [],
    packageSubscriptions: [sub],
    catalogs: [],
  };
  storage.kv.set('linked_sources_v1', registry);
  const v2 = packageBytes(['k1', 'k4'], '2.0.0');
  const platform = createTestPlatform(storage, {
    getPackageFetcher: async () =>
      ({
        fetchPackage: async () => ({ bytes: v2, notModified: false }),
      }) as never,
  });
  const onError = vi.fn();
  const onStatus = vi.fn();
  mounted = await mountWithApp(
    <SourcesPanel onStatusMessage={onStatus} onErrorMessage={onError} />,
    { platform, initialEvents: v1Events },
  );
  await flush(6);
  return { m: mounted, onError, onStatus };
}

function activeWords(m: Mounted): string[] {
  return [...m.app().state.notes.values()]
    .filter((n) => !n.archived)
    .map((n) => n.fields['word'] ?? '')
    .sort();
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  return must(
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text),
    `button "${text}"`,
  );
}

/** Flushes until `find` returns something (the panel loads the source runner lazily). */
async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const found = find();
    if (found) return found;
    await flush(1);
  }
  return must(find(), what);
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush(8);
}

async function openPreview(m: Mounted): Promise<HTMLDialogElement> {
  const row = await waitFor(
    () => m.container.querySelector('[data-testid="pkg-sub-row-pkg:words"]'),
    'package row',
  );
  await click(buttonByText(row, 'Check Update'));
  const dialog = await waitFor(
    () => document.querySelector<HTMLDialogElement>('[data-testid="archive-preview-dialog"]'),
    'archive preview dialog',
  );
  expect(dialog.textContent).toContain('Archive 2 notes?');
  return dialog;
}

describe('archive-count preview in the Sources panel (C9)', () => {
  it('Cancel closes the step and writes nothing', async () => {
    const { m, onError } = await mountSubscribed();
    const before = activeWords(m);
    expect(before).toEqual(['k1', 'k2', 'k3']);

    const dialog = await openPreview(m);
    await click(buttonByText(dialog, 'Cancel'));

    expect(document.querySelector('[data-testid="archive-preview-dialog"]')).toBeNull();
    expect(activeWords(m)).toEqual(before);
    expect(onError).toHaveBeenLastCalledWith(expect.stringMatching(/cancelled/));
  });

  it('Continue applies the update and archives the counted notes', async () => {
    const { m, onStatus } = await mountSubscribed();
    const dialog = await openPreview(m);
    await click(buttonByText(dialog, 'Continue'));
    await waitFor(() => (activeWords(m).includes('k4') ? true : null), 'the update');

    expect(document.querySelector('[data-testid="archive-preview-dialog"]')).toBeNull();
    expect(activeWords(m)).toEqual(['k1', 'k4']);
    expect(onStatus).toHaveBeenLastCalledWith(expect.stringMatching(/v2\.0\.0/));
  });
});
