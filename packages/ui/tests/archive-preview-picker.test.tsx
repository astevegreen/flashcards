// @vitest-environment happy-dom
// C9 from a picker (#137 follow-up): re-linking a Drive `.flashpkg` whose new version drops notes
// of a deck already here asks in the Sources panel's archive preview, naming the package's title
// and the file, instead of holding the link with a message. Cancel writes nothing and the next
// try asks again; Continue archives the counted notes.
import { createEmptyState, createEventFactory, createHlcState, type FlashEvent } from '@flash/core';
import { importFlashpkg } from '@flash/core/flashpkg';
import type { Auth, PlatformServices } from '@flash/platform';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Relative path: the real Drive client (no workspace export), driven by a fake Drive API.
import { WebGoogleSourcesClient } from '../../platform-web/src/sources/google-sheets-docs.ts';
import { SourcesPanel } from '../src/components/SourcesPanel.tsx';
import {
  createMemoryStorage,
  createTestPlatform,
  flush,
  mountWithApp,
  must,
  type Mounted,
} from './helpers/app-harness.tsx';
import { activeWords, packageBytes } from './helpers/package-versions.ts';

const FILE = { id: 'pkg-1', name: 'words.flashpkg', mimeType: 'application/octet-stream' };

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** A Drive v3 `files.get` (metadata and `alt=media`) serving one package file. */
function fakeDrive(bytes: Uint8Array) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith(`/${FILE.id}`)) return new Response('missing', { status: 404 });
    if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(bytes));
    return Response.json({
      id: FILE.id,
      name: FILE.name,
      mimeType: FILE.mimeType,
      size: String(bytes.byteLength),
      md5Checksum: 'md5-v2',
    });
  });
}

/** The panel with "Words" v1 already here; the picked Drive file holds v2 without k2, k3. */
async function mountWithPicker() {
  const v1Events: FlashEvent[] = importFlashpkg(
    packageBytes(['k1', 'k2', 'k3'], '1.0.0'),
    createEmptyState(),
    createEventFactory('other', 0, createHlcState('other', 1000)),
    { nowMs: 1000, sourceOverride: { kind: 'google_drive_file', external_id: FILE.id } },
  ).events;
  const auth = {
    isConfigured: () => true,
    isConnected: async () => true,
    getValidAccessToken: async () => 'tok',
  } as unknown as Auth;
  const client = new WebGoogleSourcesClient({
    auth,
    fetchImpl: fakeDrive(packageBytes(['k1', 'k4'], '2.0.0')),
    sleep: async () => {},
  });
  const pickDriveFiles = vi.fn(async () => [FILE]);
  const platform = createTestPlatform(createMemoryStorage(), {
    googleOAuthConfigured: true,
    googlePickerConfigured: true,
    getGoogleAuth: async () => auth,
    getGooglePicker: async () => ({ pickDriveFiles }) as never,
    getGoogleSourcesClient: async () => client,
  } as Partial<PlatformServices>);
  const onError = vi.fn();
  mounted = await mountWithApp(
    <SourcesPanel onStatusMessage={() => undefined} onErrorMessage={onError} />,
    { platform, initialEvents: v1Events },
  );
  await flush(6);
  return { m: mounted, onError };
}

const dialogEl = () =>
  document.querySelector<HTMLDialogElement>('[data-testid="archive-preview-dialog"]');

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  return must(
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text),
    `button "${text}"`,
  );
}

async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
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

/** Link from Google Drive → the package step → Link this package → the archive preview. */
async function linkAndOpenPreview(m: Mounted): Promise<HTMLDialogElement> {
  const linkBtn = await waitFor(
    () =>
      m.container.querySelector<HTMLButtonElement>(
        '[data-testid="link-google-source-btn"]:not([disabled])',
      ),
    'Link from Google Drive',
  );
  await click(linkBtn);
  const linkPkg = await waitFor(
    () => m.container.querySelector<HTMLButtonElement>('[data-testid="gdrive-package-link-btn"]'),
    'the package link step',
  );
  await click(linkPkg);
  return waitFor(dialogEl, 'archive preview dialog');
}

describe('archive preview from the Google Drive picker (C9)', () => {
  it('names the package and its file, and Cancel writes nothing, then asks again', async () => {
    const { m } = await mountWithPicker();
    expect(activeWords(m.app().state)).toEqual(['k1', 'k2', 'k3']);

    const dialog = await linkAndOpenPreview(m);
    expect(dialog.textContent).toContain('Archive 2 notes?');
    expect(dialog.textContent).toContain('“Words”');
    expect(dialog.querySelector('[data-testid="archive-preview-file"]')?.textContent).toBe(
      'From words.flashpkg',
    );
    const eventsBefore = m.app().state;
    await click(buttonByText(dialog, 'Cancel'));

    expect(dialogEl()).toBeNull();
    expect(m.app().state).toBe(eventsBefore);
    expect(activeWords(m.app().state)).toEqual(['k1', 'k2', 'k3']);
    const panel = must(m.container.querySelector('[data-testid="gdrive-file-link-panel"]'));
    expect(panel.textContent).toMatch(/you cancelled the update of "Words", which would archive 2/);

    // Cancel isn't remembered: picking the file again asks again.
    await click(buttonByText(panel, 'Done'));
    const again = await linkAndOpenPreview(m);
    expect(again.textContent).toContain('Archive 2 notes?');
  }, 20_000);

  it('Continue links the file and archives the counted notes', async () => {
    const { m } = await mountWithPicker();
    const dialog = await linkAndOpenPreview(m);
    await click(buttonByText(dialog, 'Continue'));
    await waitFor(
      () => (activeWords(m.app().state).includes('k4') ? true : null),
      'the linked update',
    );

    expect(dialogEl()).toBeNull();
    expect(activeWords(m.app().state)).toEqual(['k1', 'k4']);
  }, 20_000);
});
