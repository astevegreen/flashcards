// @vitest-environment happy-dom
// Panels cleared from REACT_COMPILER_BASELINE (#108): state that used to be reset by an effect is
// now reset during render, and render-time ref reads became state. These pin the behaviour the
// rewrites must keep: drafts follow a new prop, a new request re-targets, a cleared box drops its
// preview, and a media URL switch shows the right image.
import { type Note, type NoteType } from '@flash/core';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindReplacePanel } from '../src/browse/FindReplacePanel.tsx';
import { MediaImage } from '../src/components/MediaImage.tsx';
import { NoteEditDialog } from '../src/components/NoteEditDialog.tsx';
import { DeckOrganizationPanel } from '../src/library/DeckOrganizationPanel.tsx';
import ImportExportPanel from '../src/library/ImportExportPanel.tsx';
import {
  CloudFilePickerPanel,
  type CloudBrowseItem,
  type CloudPickerProvider,
  type CloudPickerSession,
} from '../src/sources/CloudFilePickerPanel.tsx';
import GoogleDriveFileLinkPanel from '../src/sources/GoogleDriveFileLinkPanel.tsx';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  sampleEvents,
  typeInto,
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
    await flush();
    const shownHash = () => byTestId(must(mounted), 'media-image')?.getAttribute('data-media-hash');
    expect(shownHash()).toBe(A);

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
    await flush();
    expect(shownHash()).toBe(B);

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
    await flush();
    expect(byTestId(mounted, 'media-image-missing')).not.toBeNull();
    await mounted.rerender(<MediaImage src={`media:${B}`} />);
    await flush();
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
    for (let i = 0; i < 50 && !q(mounted, '[role="alert"]'); i += 1) await flush(1);
    expect(q(mounted, '[role="alert"]')).not.toBeNull();
    await click(byTestId(mounted, 'gdrive-file-skip-btn'));
    await flush();
    expect(onClose).toHaveBeenCalled();
  });
});
