// @vitest-environment happy-dom
import { BUILTIN_NOTE_TYPE_IDS } from '@flash/core';
import type { OneDriveBrowseItem, PickedFile } from '@flash/platform';
import { zipSync } from 'fflate';
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryScreen } from '../src/screens/LibraryScreen.tsx';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  sampleEvents,
  type Mounted,
} from './helpers/app-harness.tsx';

/** A `.flashpkg` with two records sharing one id, which the importer keeps once and warns about (C9). */
function duplicateIdPackage(): Uint8Array {
  const enc = (text: string) => new TextEncoder().encode(text);
  const records = [
    { id: 'n1', fields: { word: '물', meaning: 'water' } },
    { id: 'n1', fields: { word: '눈', meaning: 'snow' } },
  ];
  return zipSync({
    'manifest.json': enc(
      JSON.stringify({
        package_id: 'pkg:status-warnings',
        name: 'Warned',
        version: '1.0.0',
        format_version: 1,
        languages: ['ko', 'en'],
        decks: [
          {
            id: 'deck-warned',
            name: 'Warned KO',
            file: 'decks/ko.jsonl',
            note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
            language: 'ko',
          },
        ],
      }),
    ),
    'decks/ko.jsonl': enc(records.map((r) => JSON.stringify(r)).join('\n') + '\n'),
  });
}

const picked = (): PickedFile => ({ name: 'warned.flashpkg', bytes: duplicateIdPackage() });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

async function mountLibrary(overrides: Record<string, unknown>): Promise<HTMLElement> {
  const platform = createTestPlatform(createMemoryStorage(), overrides as never);
  mounted = await mountWithApp(createElement(LibraryScreen, { onStudyDeck: () => undefined }), {
    platform,
    initialEvents: sampleEvents(),
  });
  return mounted.container;
}

/**
 * Flushes React work until `read` returns something, so lazy chunks, the picker's listing and the
 * import (all async) can take as long as a loaded CI machine needs. Fails naming `what` after 10 s.
 */
async function waitFor<T>(read: () => T | null | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await flush(1);
  }
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = await waitFor(
    () => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`),
    `button ${testId}`,
  );
  await act(async () => button.click());
}

/** The status line once an import has written to it. */
const importStatus = (container: HTMLElement) =>
  waitFor(() => {
    const text = container.querySelector('[data-testid="library-status"]')?.textContent ?? '';
    return text.startsWith('Imported') ? text : undefined;
  }, 'the import status line');

describe('package warnings reach the Library status line (C9)', () => {
  it('a .flashpkg picked from the Import / Export panel', async () => {
    const pickFile = vi.fn(async () => picked());
    const container = await mountLibrary({ files: { pickFile } });
    await click(container, 'import-export-btn');
    await click(container, 'import-mode-flashpkg');
    await click(container, 'import-flashpkg-btn');
    const status = await importStatus(container);
    expect(pickFile).toHaveBeenCalled();
    expect(status).toContain('Imported "Warned"');
    expect(status).toContain('1 warning:');
    expect(status).toContain('reuse an id');
  });

  it('a .flashpkg picked from OneDrive', async () => {
    const item: OneDriveBrowseItem = {
      id: 'file-1',
      name: 'warned.flashpkg',
      kind: 'file',
      size: 100,
    };
    const picker = {
      hasFileAccess: async () => true,
      requestFileAccess: async () => true,
      listFolder: async () => [item],
      downloadFile: vi.fn(async () => picked()),
    };
    const container = await mountLibrary({
      oneDriveConfigured: true,
      getOneDrivePicker: async () => picker,
    });
    await click(container, 'onedrive-import-btn');
    await click(container, 'onedrive-file-warned.flashpkg');
    const status = await importStatus(container);
    expect(picker.downloadFile).toHaveBeenCalledWith(item);
    expect(status).toContain('Imported "Warned" from OneDrive');
    expect(status).toContain('1 warning:');
    expect(status).toContain('reuse an id');
  });
});
