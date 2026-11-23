import { describe, expect, it } from 'vitest';
import {
  ADD_DEVICE_KV_KEY,
  addDeviceExpectationResource,
  clearAddDeviceExpectation,
  parseAddDeviceExpectation,
  peekAddDeviceExpectation,
  saveAddDeviceExpectation,
} from '../src/sync/addDeviceExpectation.ts';
import {
  mergeOpenedAddDeviceLink,
  parseAddDeviceDeepLink,
  parseAddDeviceParams,
  stripAddDeviceParams,
  takeAddDeviceLink,
} from '../src/sync/addDeviceLink.ts';
import {
  buildAddDeviceDeepLink,
  buildAddDeviceUrl,
  checkAddDeviceCollection,
} from '../src/sync/addDeviceLinkShare.ts';
import { qrMatrixToPath } from '../src/sync/qrPath.ts';

const COLLECTION = 'col-0190f5c2-1234-7abc-8def-0123456789ab';

function memoryKv(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    getKv: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    setKv: (key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    },
    deleteKv: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

describe('add-device link', () => {
  it('round-trips the provider and collection id, and nothing else', () => {
    const url = buildAddDeviceUrl('https://app.example/flash/?device=a&code=x#top', {
      provider: 'google_drive',
      collectionId: COLLECTION,
    });
    expect(url).toBe(`https://app.example/flash/?sync=google&col=${COLLECTION}`);
    expect(parseAddDeviceParams(new URL(url).search)).toEqual({
      provider: 'google_drive',
      collectionId: COLLECTION,
    });
    for (const [provider, code] of [
      ['dropbox', 'dropbox'],
      ['onedrive', 'onedrive'],
      ['icloud', 'icloud'],
      ['local_folder', 'folder'],
    ] as const) {
      const built = buildAddDeviceUrl('https://app.example/', { provider });
      expect(built).toBe(`https://app.example/?sync=${code}`);
      expect(parseAddDeviceParams(new URL(built).search)).toEqual({ provider });
    }
  });

  it('ignores malformed input as a whole', () => {
    const bad = [
      '',
      '?sync=',
      '?sync=dev_channel',
      '?sync=google_drive',
      '?sync=__proto__',
      '?sync=GOOGLE',
      '?sync=google&sync=dropbox',
      `?sync=google&col=${COLLECTION}&col=${COLLECTION}`,
      '?sync=google&col=',
      '?sync=google&col=col-not-a-uuid',
      `?sync=google&col=${COLLECTION.toUpperCase()}`,
      `?sync=google&col=${COLLECTION}x`,
      `?sync=google&col=x${COLLECTION}`,
      `?sync=google&col=${encodeURIComponent(`${COLLECTION}\n`)}`,
      `?col=${COLLECTION}`,
      `?sync=google&col=${'a'.repeat(5000)}`,
    ];
    for (const search of bad) {
      expect(parseAddDeviceParams(search), search).toBeUndefined();
    }
  });

  it('strips only its own params from the address bar, valid or not', () => {
    const replaced: string[] = [];
    const history = {
      state: { keep: true },
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        replaced.push(String(url));
      },
    };
    const href = `https://app.example/?device=b&sync=onedrive&col=${COLLECTION}#x`;
    expect(takeAddDeviceLink({ href, search: new URL(href).search }, history)).toEqual({
      provider: 'onedrive',
      collectionId: COLLECTION,
    });
    expect(replaced).toEqual(['https://app.example/?device=b#x']);

    const malformed = 'https://app.example/?sync=evil&col=x';
    expect(
      takeAddDeviceLink({ href: malformed, search: new URL(malformed).search }, history),
    ).toBeUndefined();
    expect(replaced[1]).toBe('https://app.example/');

    const none = 'https://app.example/?device=a';
    expect(takeAddDeviceLink({ href: none, search: '?device=a' }, history)).toBeUndefined();
    expect(replaced).toHaveLength(2);
    expect(stripAddDeviceParams('https://app.example/?a=1&sync=google&b=2')).toBe(
      'https://app.example/?a=1&b=2',
    );
  });

  it('confirms the new device reached the collection the other device showed', () => {
    const expected = { provider: 'onedrive' as const, collectionId: COLLECTION };
    expect(
      checkAddDeviceCollection(undefined, { provider: 'onedrive', collectionId: COLLECTION }),
    ).toBe('not_applicable');
    expect(
      checkAddDeviceCollection(
        { provider: 'onedrive' },
        { provider: 'onedrive', collectionId: COLLECTION },
      ),
    ).toBe('not_applicable');
    expect(checkAddDeviceCollection(expected, { provider: 'none', collectionId: undefined })).toBe(
      'not_applicable',
    );
    expect(
      checkAddDeviceCollection(expected, { provider: 'onedrive', collectionId: undefined }),
    ).toBe('pending');
    expect(
      checkAddDeviceCollection(expected, { provider: 'onedrive', collectionId: COLLECTION }),
    ).toBe('match');
    expect(
      checkAddDeviceCollection(expected, {
        provider: 'onedrive',
        collectionId: 'col-0190f5c2-1234-7abc-8def-ffffffffffff',
      }),
    ).toBe('mismatch');
  });

  it('keeps the expectation on the device (provider + collection only) until it is cleared', async () => {
    expect(parseAddDeviceExpectation({ provider: 'google_drive' })).toBeUndefined();
    expect(
      parseAddDeviceExpectation({ provider: 'google_drive', collectionId: COLLECTION, token: 't' }),
    ).toEqual({ provider: 'google_drive', collectionId: COLLECTION });

    const kv = memoryKv();
    await saveAddDeviceExpectation(kv, { provider: 'dropbox' });
    expect(kv.data.has(ADD_DEVICE_KV_KEY)).toBe(false);
    await saveAddDeviceExpectation(kv, { provider: 'dropbox', collectionId: COLLECTION });
    expect(kv.data.get(ADD_DEVICE_KV_KEY)).toEqual({
      provider: 'dropbox',
      collectionId: COLLECTION,
    });
    expect(peekAddDeviceExpectation(kv)).toEqual({ provider: 'dropbox', collectionId: COLLECTION });
    await clearAddDeviceExpectation(kv);
    expect(kv.data.has(ADD_DEVICE_KV_KEY)).toBe(false);
    expect(peekAddDeviceExpectation(kv)).toBeUndefined();
    expect(await addDeviceExpectationResource(kv)).toBeUndefined();

    const stored = memoryKv({
      [ADD_DEVICE_KV_KEY]: { provider: 'icloud', collectionId: COLLECTION },
    });
    expect(peekAddDeviceExpectation(stored)).toBeUndefined();
    expect(await addDeviceExpectationResource(stored)).toEqual({
      provider: 'icloud',
      collectionId: COLLECTION,
    });
    expect(peekAddDeviceExpectation(stored)).toEqual({
      provider: 'icloud',
      collectionId: COLLECTION,
    });
  });
});

describe('QR path', () => {
  it('draws one rectangle per run of dark modules', () => {
    expect(
      qrMatrixToPath([
        [true, true, false, true],
        [false, false, false, false],
        [false, true, true, true],
      ]),
    ).toBe('M0 0h2v1h-2zM3 0h1v1h-1zM1 2h3v1h-3z');
    expect(qrMatrixToPath([])).toBe('');
  });

  it('encodes a full add-device link with the bundled encoder', async () => {
    const { encode } = await import('uqr');
    const url = buildAddDeviceUrl('https://flashcards.example.pages.dev/', {
      provider: 'google_drive',
      collectionId: COLLECTION,
    });
    const qr = encode(url, { ecc: 'M', border: 4 });
    expect(qr.size).toBeLessThanOrEqual(53);
    expect(qr.data).toHaveLength(qr.size);
    // Finder pattern corner (inside the 4-module quiet zone) is dark.
    expect(qr.data[4]?.[4]).toBe(true);
    expect(qr.data[0]?.[0]).toBe(false);
    expect(qrMatrixToPath(qr.data)).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
  });
});

describe('native add-device deep link (flashcards://add-device)', () => {
  it('round-trips the provider and collection id, and carries nothing else', () => {
    const url = buildAddDeviceDeepLink({ provider: 'google_drive', collectionId: COLLECTION });
    expect(url).toBe(`flashcards://add-device?sync=google&col=${COLLECTION}`);
    expect(parseAddDeviceDeepLink(url)).toEqual({
      provider: 'google_drive',
      collectionId: COLLECTION,
    });
  });

  it('reads the same query as the web link, a trailing slash and a hash included', () => {
    expect(
      parseAddDeviceDeepLink(`flashcards://add-device/?sync=onedrive&col=${COLLECTION}`),
    ).toEqual({ provider: 'onedrive', collectionId: COLLECTION });
    expect(parseAddDeviceDeepLink(`FLASHCARDS://ADD-DEVICE?sync=icloud#x`)).toEqual({
      provider: 'icloud',
    });
  });

  it('rejects other hosts, paths, unknown providers, bad ids and repeated params', () => {
    for (const bad of [
      'flashcards://oauth/microsoft?sync=google',
      'flashcards://add-device.evil?sync=google',
      'flashcards://add-device/x?sync=google',
      'flashcards://add-device',
      'flashcards://add-device?sync=evil',
      'flashcards://add-device?sync=google&col=nope',
      `flashcards://add-device?sync=google&sync=dropbox`,
      'https://example.com/?sync=google',
      `flashcards://add-device?sync=google&x=${'a'.repeat(3000)}`,
    ]) {
      expect(parseAddDeviceDeepLink(bad), bad).toBeUndefined();
    }
  });
});

describe('mergeOpenedAddDeviceLink', () => {
  it('keeps the current object for the same link and takes a different one', () => {
    const a = { provider: 'google_drive' as const, collectionId: COLLECTION };
    expect(mergeOpenedAddDeviceLink(a, { ...a })).toBe(a);
    const b = { provider: 'dropbox' as const, collectionId: COLLECTION };
    expect(mergeOpenedAddDeviceLink(a, b)).toBe(b);
    expect(mergeOpenedAddDeviceLink(undefined, b)).toBe(b);
  });
});
