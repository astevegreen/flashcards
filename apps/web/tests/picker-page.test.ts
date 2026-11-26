import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('../public/picker.js', import.meta.url)), 'utf8');

/** Runs `picker.js` against fake DOM, history and Google Picker objects. */
function runPicker(hash: string) {
  const location = { hash, pathname: '/picker.html', search: '', origin: 'https://x', href: '' };
  const replaced: string[] = [];
  let pickerCallback: ((data: unknown) => void) | undefined;
  const el = () => ({ textContent: '', hidden: true, addEventListener: () => undefined });
  const elements: Record<string, ReturnType<typeof el>> = {
    status: el(),
    'open-btn': el(),
    heading: el(),
  };
  const builder: Record<string, unknown> = {};
  for (const m of ['setAppId', 'setOrigin', 'setOAuthToken', 'setDeveloperKey', 'enableFeature']) {
    builder[m] = () => builder;
  }
  builder['addView'] = () => builder;
  builder['setCallback'] = (cb: (data: unknown) => void) => {
    pickerCallback = cb;
    return builder;
  };
  builder['build'] = () => ({ setVisible: () => undefined });
  const docsView = { setIncludeFolders: () => docsView, setMimeTypes: () => docsView };
  const google = {
    picker: {
      DocsView: function () {
        return docsView;
      },
      PickerBuilder: function () {
        return builder;
      },
      ViewId: { DOCS: 'docs' },
      Feature: { MULTISELECT_ENABLED: 'multi' },
      Action: { PICKED: 'picked', CANCEL: 'cancel' },
    },
  };
  const history = {
    replaceState: (_s: unknown, _t: string, url: string) => {
      replaced.push(url);
      location.hash = '';
    },
  };
  runInNewContext(source, {
    window: { location },
    document: { getElementById: (id: string) => elements[id] },
    history,
    URLSearchParams,
    gapi: { load: (_name: string, cb: () => void) => cb() },
    google,
  });
  return { location, replaced, pick: (data: unknown) => pickerCallback?.(data) };
}

describe('picker.js (S10)', () => {
  const hash =
    '#access_token=tok&app_id=1&api_key=k&callback=flashcards%3A%2F%2Fpicker-callback&state=n0nce';

  it('removes the access-token fragment from the address bar and history', () => {
    const page = runPicker(hash);
    expect(page.replaced).toEqual(['/picker.html']);
    expect(page.location.hash).toBe('');
  });

  it('echoes the state nonce back in the deep link', () => {
    const page = runPicker(hash);
    page.pick({ action: 'picked', docs: [{ id: 'a', name: 'A', mimeType: 'm', url: 'u' }] });
    const callback = new URL(page.location.href);
    expect(callback.searchParams.get('state')).toBe('n0nce');
    expect(JSON.parse(callback.searchParams.get('files') ?? '')).toHaveLength(1);
    page.pick({ action: 'cancel' });
    expect(new URL(page.location.href).searchParams.get('state')).toBe('n0nce');
  });
});
