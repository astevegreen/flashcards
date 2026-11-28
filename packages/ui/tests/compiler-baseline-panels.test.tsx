// @vitest-environment happy-dom
// Panels cleared from REACT_COMPILER_BASELINE (#108): state that used to be reset by an effect is
// now reset during render, and render-time ref reads became state. These pin the behaviour the
// rewrites must keep: drafts follow a new prop, a new request re-targets, a cleared box drops its
// preview, and a media URL switch shows the right image.
import { type Note, type NoteType } from '@flash/core';
import type { BackupStore, PlatformServices, StoredBackupInfo } from '@flash/platform';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_STATUS_KV_KEY } from '../src/backups/backupRunner.ts';
import { BackupsPanel } from '../src/backups/BackupsPanel.tsx';
import { FindReplacePanel } from '../src/browse/FindReplacePanel.tsx';
import { MediaImage } from '../src/components/MediaImage.tsx';
import { NoteEditDialog } from '../src/components/NoteEditDialog.tsx';
import { SourcesPanel } from '../src/components/SourcesPanel.tsx';
import { DeckOrganizationPanel } from '../src/library/DeckOrganizationPanel.tsx';
import ImportExportPanel from '../src/library/ImportExportPanel.tsx';
import { SettingsScreen } from '../src/screens/SettingsScreen.tsx';
import {
  CloudFilePickerPanel,
  type CloudBrowseItem,
  type CloudPickerProvider,
  type CloudPickerSession,
} from '../src/sources/CloudFilePickerPanel.tsx';
import GoogleDriveFileLinkPanel from '../src/sources/GoogleDriveFileLinkPanel.tsx';
import { AppProvider } from '../src/state/AppContext.tsx';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  newCard,
  sampleEvents,
  testMeta,
  typeInto,
  type MemoryStorage,
  type Mounted,
} from './helpers/app-harness.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const q = <T extends Element = HTMLElement>(m: Mounted, selector: string): T | null =>
  m.container.querySelector<T>(selector);
const byTestId = <T extends Element = HTMLElement>(m: Mounted, id: string): T | null =>
  q<T>(m, `[data-testid="${id}"]`);

/**
 * Flushes React and the event loop until `check` holds: async work (a lazy import, a storage
 * read) can take many turns, more so under coverage. Fails with `what` after `timeoutMs`.
 */
async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await flush(1);
  }
}

async function click(el: Element | null): Promise<void> {
  await act(async () => {
    must(el, 'element to click').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function pressEnter(el: Element | null): Promise<void> {
  await act(async () => {
    must(el, 'element').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}

/** Two notes of one deck with their note type, from the sample collection. */
function twoNotes(m: Mounted): { a: Note; b: Note; noteType: NoteType } {
  const { state } = m.app();
  for (const deck of state.decks.values()) {
    const notes = [...state.notes.values()].filter((n) => n.deck_id === deck.id);
    const noteType = state.noteTypes.get(deck.note_type_id);
    const [a, b] = notes;
    if (a && b && noteType) return { a, b, noteType };
  }
  throw new Error('no deck with two notes in the sample collection');
}

describe('NoteEditDialog drafts follow the note prop', () => {
  it('fills the fields from each note it is given and saves only what changed', async () => {
    mounted = await mountWithApp(null, { initialEvents: sampleEvents() });
    const { a, b, noteType } = twoNotes(mounted);
    const firstField = must(noteType.fields[0], 'a note type field');
    const onSave = vi.fn();
    const onClose = vi.fn();
    const render = (note: Note | null) => (
      <NoteEditDialog note={note} noteType={noteType} onSave={onSave} onClose={onClose} />
    );
    const fieldInput = () =>
      must(
        q<HTMLInputElement | HTMLTextAreaElement>(
          must(mounted),
          `dialog [aria-label="${firstField.label}"], dialog input, dialog textarea`,
        ),
        'the first field input',
      );

    await mounted.rerender(render(a));
    expect(fieldInput().value).toBe(a.fields[firstField.key] ?? '');

    // A different note replaces the drafts, even ones the user had typed into.
    await typeInto(fieldInput() as HTMLInputElement, 'typed into A');
    await mounted.rerender(render(b));
    expect(fieldInput().value).toBe(b.fields[firstField.key] ?? '');

    // Escape with no changes closes without asking.
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const dialog = must(q<HTMLDialogElement>(mounted, 'dialog'), 'the dialog');
    const clean = new Event('cancel', { cancelable: true });
    await act(async () => void dialog.dispatchEvent(clean));
    expect(confirm).not.toHaveBeenCalled();
    expect(clean.defaultPrevented).toBe(false);

    // With an edit, Escape asks first, and a "no" keeps the dialog open.
    await typeInto(fieldInput() as HTMLInputElement, 'edited B');
    const dirty = new Event('cancel', { cancelable: true });
    await act(async () => void dialog.dispatchEvent(dirty));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dirty.defaultPrevented).toBe(true);

    await act(async () => {
      must(q(must(mounted), 'dialog form'), 'the form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const [savedNote, fields, tags] = onSave.mock.calls[0] as [
      Note,
      Record<string, string>,
      unknown,
    ];
    expect(savedNote.id).toBe(b.id);
    expect(fields).toEqual({ [firstField.key]: 'edited B' });
    expect(tags).toBeUndefined();
  });
});

describe('MediaImage shows the image for the current src', () => {
  const A = 'aa'.repeat(32);
  const B = 'bb'.repeat(32);

  it('switches between hashes and back without a stale image or a second read', async () => {
    const storage = createMemoryStorage();
    storage.media.set(A, { hash: A, mime: 'image/png', bytes: new Uint8Array([1]) });
    storage.media.set(B, { hash: B, mime: 'image/png', bytes: new Uint8Array([2]) });
    const getMedia = vi.spyOn(storage, 'getMedia');
    mounted = await mountWithApp(<MediaImage src={`media:${A}`} />, {
      platform: createTestPlatform(storage),
    });
    const shownHash = () => byTestId(must(mounted), 'media-image')?.getAttribute('data-media-hash');
    await waitFor(() => shownHash() === A, 'image A');

    // A new hash shows Loading until its read lands, never the old image.
    let release: () => void = () => undefined;
    getMedia.mockImplementationOnce(
      (hash) =>
        new Promise((resolve) => {
          release = () => resolve(storage.media.get(hash));
        }),
    );
    await mounted.rerender(<MediaImage src={`media:${B}`} />);
    expect(byTestId(mounted, 'media-image')).toBeNull();
    expect(byTestId(mounted, 'media-image-loading')).not.toBeNull();
    await act(async () => release());
    await waitFor(() => shownHash() === B, 'image B');

    // An unsafe src is blocked at once; the image comes back when the src does, unread.
    await mounted.rerender(<MediaImage src="javascript:alert(1)" />);
    expect(byTestId(mounted, 'media-image-blocked')).not.toBeNull();
    const reads = getMedia.mock.calls.length;
    await mounted.rerender(<MediaImage src={`media:${B}`} />);
    await flush();
    expect(shownHash()).toBe(B);
    expect(getMedia.mock.calls).toHaveLength(reads);
  });

  it('a hash found missing shows "pending sync", and another src replaces it', async () => {
    const storage = createMemoryStorage();
    storage.media.set(B, { hash: B, mime: 'image/png', bytes: new Uint8Array([2]) });
    mounted = await mountWithApp(<MediaImage src={`media:${A}`} />, {
      platform: createTestPlatform(storage),
    });
    await waitFor(() => byTestId(must(mounted), 'media-image-missing') !== null, 'A missing');
    await mounted.rerender(<MediaImage src={`media:${B}`} />);
    await waitFor(
      () => byTestId(must(mounted), 'media-image')?.getAttribute('data-media-hash') === B,
      'image B',
    );
    expect(byTestId(mounted, 'media-image-missing')).toBeNull();
    expect(byTestId(mounted, 'media-image')?.getAttribute('data-media-hash')).toBe(B);
  });
});

describe('FindReplacePanel preview', () => {
  it('clearing Find drops the preview, and retyping waits for the new plan', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mounted = await mountWithApp(null, { initialEvents: sampleEvents() });
    const noteIds = [...mounted.app().state.notes.keys()];
    await mounted.rerender(<FindReplacePanel noteIds={noteIds} onClose={() => undefined} />);
    await flush();
    const find = must(byTestId<HTMLInputElement>(mounted, 'find-replace-find'), 'Find');
    const summary = () => byTestId(must(mounted), 'find-replace-summary')?.textContent ?? '';

    await typeInto(find, 'zzzz-no-such-text');
    await act(async () => void vi.advanceTimersByTime(250));
    const firstSummary = summary();
    expect(firstSummary).not.toBe('');

    await typeInto(find, '');
    expect(summary()).not.toBe(firstSummary);
    await act(async () => void vi.advanceTimersByTime(250));
    expect(summary()).not.toBe(firstSummary);

    // Typing again: the old plan does not come back before the delay.
    await typeInto(find, 'zzzz-no-such-text');
    await act(async () => void vi.advanceTimersByTime(250));
    expect(summary()).toBe(firstSummary);
  });
});

describe('DeckOrganizationPanel drafts follow the stored value', () => {
  it('a rename or a limit saved elsewhere replaces the draft; an invalid entry snaps back', async () => {
    const Two = () => (
      <>
        <div data-testid="first">
          <DeckOrganizationPanel />
        </div>
        <div data-testid="second">
          <DeckOrganizationPanel />
        </div>
      </>
    );
    mounted = await mountWithApp(<Two />, { initialEvents: sampleEvents() });
    for (const toggle of mounted.container.querySelectorAll(
      '[data-testid="toggle-deck-organization-btn"]',
    )) {
      await click(toggle);
    }
    const inPanel = <T extends Element = HTMLElement>(panel: string, selector: string) =>
      must(q<T>(must(mounted), `[data-testid="${panel}"] ${selector}`), `${panel} ${selector}`);

    await typeInto(inPanel<HTMLInputElement>('first', '[data-testid="new-folder-name"]'), 'Korean');
    await click(inPanel('first', '[data-testid="create-folder-btn"]'));
    const folderSelector = '[data-testid^="folder-name-"]';
    expect(inPanel<HTMLInputElement>('second', folderSelector).value).toBe('Korean');

    await typeInto(inPanel<HTMLInputElement>('first', folderSelector), 'Hangul');
    await pressEnter(inPanel('first', folderSelector));
    expect(inPanel<HTMLInputElement>('second', folderSelector).value).toBe('Hangul');

    await typeInto(inPanel<HTMLInputElement>('first', '[data-testid="new-preset-name"]'), 'Vocab');
    await click(inPanel('first', '[data-testid="create-preset-btn"]'));
    const limitSelector = '[data-testid^="preset-new-per-day-"]';
    await typeInto(inPanel<HTMLInputElement>('first', limitSelector), '7');
    await pressEnter(inPanel('first', limitSelector));
    expect(inPanel<HTMLInputElement>('second', limitSelector).value).toBe('7');

    await typeInto(inPanel<HTMLInputElement>('second', limitSelector), '5000');
    await pressEnter(inPanel('second', limitSelector));
    expect(inPanel<HTMLInputElement>('second', limitSelector).value).toBe('7');
    expect(inPanel<HTMLInputElement>('first', limitSelector).value).toBe('7');
  });
});

describe('ImportExportPanel follows each open request', () => {
  it('switches tab when the host re-targets it, even to the tab it opened on', async () => {
    const noop = async () => undefined;
    const panel = (initialTab: 'import' | 'export', requestNonce: number) => (
      <ImportExportPanel
        initialTab={initialTab}
        requestNonce={requestNonce}
        onImportFlashpkg={noop}
        onExportAll={noop}
        onExportDeck={noop}
        onExportScoped={noop}
        collectMediaBlobs={async () => new Map()}
        onStatus={() => undefined}
        onError={() => undefined}
      />
    );
    mounted = await mountWithApp(panel('import', 0), { initialEvents: sampleEvents() });
    const selected = () =>
      q(must(mounted), '[role="tab"][aria-selected="true"]')?.getAttribute('data-testid');
    expect(selected()).toBe('import-export-tab-import');

    await mounted.rerender(panel('export', 0));
    expect(selected()).toBe('import-export-tab-export');

    await click(byTestId(mounted, 'import-export-tab-import'));
    expect(selected()).toBe('import-export-tab-import');
    // Same tab prop, new nonce: the request wins over the user's switch.
    await mounted.rerender(panel('export', 1));
    expect(selected()).toBe('import-export-tab-export');
    // An unrelated re-render keeps the user's choice.
    await click(byTestId(mounted, 'import-export-tab-import'));
    await mounted.rerender(panel('export', 1));
    expect(selected()).toBe('import-export-tab-import');
  });
});

describe('CloudFilePickerPanel listing', () => {
  interface Item extends CloudBrowseItem {
    folder?: string;
  }
  it('each folder shows Loading with no stale error, then its items', async () => {
    const pending = new Map<string, { resolve: (v: Item[]) => void; reject: (e: Error) => void }>();
    const listFolder = vi.fn(
      (folder?: string) =>
        new Promise<Item[]>((resolve, reject) => {
          pending.set(folder ?? 'root', { resolve, reject });
        }),
    );
    const session: CloudPickerSession<Item> = {
      hasAccess: async () => true,
      requestAccess: async () => true,
      listFolder,
      downloadFile: () => Promise.reject(new Error('not in this test')),
    };
    const provider: CloudPickerProvider<Item> = {
      key: 'fake',
      label: 'Fake Drive',
      rootName: 'Fake Drive',
      open: async () => session,
      folderOf: (item) => item.folder ?? item.id,
      sourceKind: 'onedrive_file',
      link: () => Promise.reject(new Error('not in this test')),
      accessText: 'Allow access',
      accessButton: { label: 'Allow', testId: 'fake-access-btn' },
      emptyText: 'Nothing here',
    };
    mounted = await mountWithApp(
      <CloudFilePickerPanel
        provider={provider}
        onStatusMessage={() => undefined}
        onErrorMessage={() => undefined}
        onClose={() => undefined}
      />,
    );
    const settle = async (
      folder: string,
      run: (p: { resolve: (v: Item[]) => void; reject: (e: Error) => void }) => void,
    ) => {
      await act(async () => run(must(pending.get(folder), `listing of ${folder}`)));
      await flush();
    };
    const empty = () => (must(mounted).container.textContent ?? '').includes('Nothing here');

    await waitFor(() => pending.has('root'), 'the root listing');
    expect(listFolder).toHaveBeenCalledWith(undefined);
    expect(empty()).toBe(false);
    await settle('root', (p) =>
      p.resolve([{ id: 'f1', name: 'Decks', kind: 'folder', size: 0, folder: 'decks' }]),
    );
    expect(byTestId(mounted, 'fake-folder-Decks')).not.toBeNull();

    await click(byTestId(mounted, 'fake-folder-Decks'));
    expect(listFolder).toHaveBeenLastCalledWith('decks');
    await settle('decks', (p) => p.reject(new Error('Drive said no')));
    expect(q(mounted, '[role="alert"]')?.textContent).toContain('Drive said no');

    // Going back lists the root again: the old error is gone at once, and Loading shows.
    await click(byTestId(mounted, 'fake-up-btn'));
    expect(q(mounted, '[role="alert"]')).toBeNull();
    expect(empty()).toBe(false);
    await settle('root', (p) => p.resolve([]));
    expect(empty()).toBe(true);
  });
});

describe('GoogleDriveFileLinkPanel steps', () => {
  it('a package starts at its link step and the next file starts reading', async () => {
    const files = [
      { id: 'p', name: 'deck.flashpkg', mimeType: 'application/zip', format: 'flashpkg' as const },
      { id: 'c', name: 'words.csv', mimeType: 'text/csv', format: 'table' as const },
    ];
    const onClose = vi.fn();
    mounted = await mountWithApp(
      <GoogleDriveFileLinkPanel
        files={files}
        onClose={onClose}
        onStatusMessage={() => undefined}
        onErrorMessage={() => undefined}
        onPendingReconciliation={() => undefined}
        onRegistry={() => undefined}
      />,
    );
    expect(byTestId(mounted, 'gdrive-package-link-btn')).not.toBeNull();

    const skip = [...mounted.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Skip',
    );
    await click(skip ?? null);
    // The csv is read from Drive; this test platform has no Google, so the read fails.
    expect(q(mounted, '[role="status"]')?.textContent).toContain('words.csv');
    await waitFor(() => q(must(mounted), '[role="alert"]') !== null, 'the Drive read to fail');
    await click(byTestId(mounted, 'gdrive-file-skip-btn'));
    await waitFor(() => onClose.mock.calls.length > 0, 'the panel to close');
  }, 20_000);
});

/** Bumps the collection with a real local change (one rating). */
async function rateOne(m: Mounted): Promise<void> {
  await act(async () => m.app().rateCard(newCard(m), 3, 1000));
}

async function choose(select: HTMLSelectElement | null, value: string): Promise<void> {
  await act(async () => {
    const el = must(select, 'select');
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** An in-memory backup store, so the panel renders and "Back up now" has somewhere to write. */
function withBackupStore(storage: MemoryStorage): MemoryStorage {
  const infos: StoredBackupInfo[] = [];
  const bytes = new Map<string, Uint8Array>();
  const store: BackupStore = {
    list: async () => [...infos].reverse(),
    put: async (info, data) => {
      infos.push(info);
      bytes.set(info.backup_id, data);
    },
    getBytes: async (id) => bytes.get(id),
    delete: async (id) => {
      bytes.delete(id);
    },
  };
  return Object.assign(storage, { openBackupStore: async () => store });
}

describe('BackupsPanel restore preview and refresh', () => {
  it('lists what was saved, shows the last error, and re-plans an open preview after a change', async () => {
    const storage = withBackupStore(createMemoryStorage());
    storage.kv.set(BACKUP_STATUS_KV_KEY, { lastError: 'Disk was full.', at: 1 });
    mounted = await mountWithApp(<BackupsPanel />, {
      platform: createTestPlatform(storage),
      initialEvents: sampleEvents(),
    });
    // The refresh chain: the list (empty) and the stored error both land.
    await waitFor(
      () => byTestId(must(mounted), 'backup-last-error') !== null,
      'the last backup error',
    );
    expect(byTestId(mounted, 'backup-last-error')?.textContent).toContain('Disk was full.');

    const button = (text: string) =>
      [...must(mounted).container.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').startsWith(text),
      ) ?? null;
    await click(button('Back up now'));
    await waitFor(() => byTestId(must(mounted), 'backup-row') !== null, 'the new backup row');
    // A successful backup clears the stored error, and the refresh shows that.
    await waitFor(() => byTestId(must(mounted), 'backup-last-error') === null, 'error cleared');

    await click(button('Restore…'));
    await waitFor(() => byTestId(must(mounted), 'restore-confirm') !== null, 'the preview');
    const preview = () => byTestId(must(mounted), 'restore-confirm')?.textContent ?? '';
    expect(preview()).toContain('already matches this backup');

    // A review after the backup: the open preview re-plans and says it is kept.
    expect(preview()).not.toContain('review made after');
    await rateOne(mounted);
    expect(preview()).toContain('1 review made after this backup stay in your history');
  }, 20_000);
});

describe('SettingsScreen TTS drafts follow the saved values', () => {
  it('a new saved config or synced voice replaces the drafts; other changes keep typing', async () => {
    mounted = await mountWithApp(<SettingsScreen />, { initialEvents: sampleEvents() });
    await waitFor(
      () => byTestId(must(mounted), 'tts-provider-select') !== null,
      'the TTS provider select',
    );
    await choose(byTestId<HTMLSelectElement>(mounted, 'tts-provider-select'), 'google');
    const apiKey = () => must(byTestId<HTMLInputElement>(must(mounted), 'tts-api-key-input'));
    const voiceKo = () => must(byTestId<HTMLInputElement>(must(mounted), 'tts-voice-ko'));

    await typeInto(apiKey(), 'draft-key');
    await typeInto(voiceKo(), 'my-voice');
    await rateOne(mounted);
    expect(apiKey().value).toBe('draft-key');
    expect(voiceKo().value).toBe('my-voice');

    await act(async () => {
      await must(mounted).app().audio.saveTtsConfig({ provider: 'azure', apiKey: 'saved-key' });
    });
    expect(byTestId<HTMLSelectElement>(mounted, 'tts-provider-select')?.value).toBe('azure');
    expect(apiKey().value).toBe('saved-key');
    // The voice drafts follow synced preferences, not the device config.
    expect(voiceKo().value).toBe('my-voice');

    await act(async () =>
      must(mounted)
        .app()
        .updatePreferences({ tts_voices: { ko: 'synced' } }),
    );
    expect(voiceKo().value).toBe('synced');
  }, 20_000);
});

describe('SourcesPanel starter catalog', () => {
  // The app picks its platform once per boot (`apps/web/src/main.tsx` renders `FlashcardsApp`
  // once), so a new platform means a new page: a fresh root and `AppProvider` over the same
  // device storage. Each boot here is one such page load.
  it('each boot checks the catalog again: an old error is gone, a cached catalog shows', async () => {
    const URL = 'https://a.test/index.json';
    const storage = createMemoryStorage();
    const catalog = {
      notModified: false,
      rawJson: JSON.stringify({
        format_version: 1,
        name: 'Family Starters',
        description: 'Decks for the family.',
        packages: [],
      }),
    };
    const boot = async (fetchCatalog: () => Promise<unknown>) => {
      const platform = createTestPlatform(storage, {
        starterCatalogUrl: URL,
        getPackageFetcher: async () => ({ fetchCatalog }) as never,
      } as Partial<PlatformServices>);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () =>
        root.render(
          <AppProvider platform={platform} initialMeta={testMeta()}>
            <SourcesPanel onStatusMessage={() => undefined} onErrorMessage={() => undefined} />
          </AppProvider>,
        ),
      );
      return {
        text: () => container.textContent ?? '',
        close: async () => {
          await act(async () => root.unmount());
          container.remove();
        },
      };
    };
    const hang = () => new Promise<never>(() => {});

    // Boot 1: the catalog can't load and nothing is cached, so the error shows.
    const first = await boot(() => Promise.reject(new Error('catalog down')));
    try {
      await waitFor(() => first.text().includes('catalog down'), 'the first catalog to fail');
      expect(first.text()).not.toContain('Checking catalog');
    } finally {
      await first.close();
    }

    // Boot 2: still checking. The last boot's error is not carried over.
    const second = await boot(hang);
    try {
      expect(second.text()).toContain('Checking catalog');
      expect(second.text()).not.toContain('catalog down');
    } finally {
      await second.close();
    }

    // Boot 3: the catalog loads, and is cached on the device.
    const third = await boot(async () => catalog);
    try {
      await waitFor(() => third.text().includes('Family Starters'), 'the catalog to load');
      await waitFor(() => !third.text().includes('Checking catalog'), 'the check to finish');
      expect(await storage.getKv(`starter_catalog_cache_v1:${URL}`)).toMatchObject({
        name: 'Family Starters',
      });
    } finally {
      await third.close();
    }

    // Boot 4: while it checks again, the cached catalog shows.
    const fourth = await boot(hang);
    try {
      await waitFor(() => fourth.text().includes('Family Starters'), 'the cached catalog');
      expect(fourth.text()).toContain('Checking catalog');
    } finally {
      await fourth.close();
    }

    // Boot 5: a failed check over a cached catalog keeps it and shows no error.
    const fifth = await boot(() => Promise.reject(new Error('catalog down')));
    try {
      await waitFor(() => !fifth.text().includes('Checking catalog'), 'the check to fail');
      expect(fifth.text()).toContain('Family Starters');
      expect(fifth.text()).not.toContain('catalog down');
    } finally {
      await fifth.close();
    }
  }, 30_000);
});
