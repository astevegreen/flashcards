import { describe, expect, it, vi } from 'vitest';
import { createAddDeviceUrlSource } from '../src/native/plugins.ts';
import { createEventFactory, createHlcState } from '../../core/src/index.ts';
import {
  CapacitorGoogleAuth,
  CapacitorMlKitInkRecognizer,
  CapacitorNativePickerBridge,
  CapacitorSqliteStorage,
  CapacitorStorePurchase,
  createCapacitorPlatform,
  ICloudDriveSyncTransport,
} from '../src/index.ts';
import { InMemorySqliteDriver } from './support/in-memory-sqlite-driver.ts';

/** Mimics a Capacitor rejection from the Swift plugin: an Error with the native `code`. */
function pluginError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('Phase 8 Capacitor Platform Adapters (§4.3, §6.4, §11, §12.1)', () => {
  it('CapacitorSqliteStorage stores/queries events, local_seq, media & kv', async () => {
    const storage = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const factory = createEventFactory('cap-ios-1', 0, createHlcState('cap-ios-1', 1000));
    const ev1 = factory.create(
      'DeckCreated',
      {
        deck_id: 'd1',
        name: 'Korean',
        note_type_id: 'preset:vocab-ko',
        language: 'ko',
        created_at: 1000,
      },
      1000,
    );
    const ev2 = factory.create(
      'ReviewRecorded',
      {
        review_id: 'r1',
        card_id: 'c1',
        rating: 3,
        reviewed_at: 2000,
        tz_offset: 0,
        duration_ms: 800,
        answer_mode: 'flip',
        fsrs_params_version: 0,
        resulting_due_at: 86_402_000,
      },
      2000,
    );

    await storage.appendEvents([ev1, ev2]);
    // Duplicate append is idempotent
    await storage.appendEvents([ev1]);

    expect((await storage.getAllEvents()).length).toBe(2);
    expect((await storage.getDeviceEventsAfterSeq('cap-ios-1', 1)).map((e) => e.id)).toEqual([
      ev2.id,
    ]);
    expect(await storage.getMaxLocalSeq()).toBe(2);
    const delta = await storage.getEventsAfterLocalSeq(1);
    expect(delta.events.length).toBe(1);
    expect(delta.maxLocalSeq).toBe(2);

    await storage.putMedia({ hash: 'abc', mime: 'audio/mpeg', bytes: new Uint8Array([1, 2, 3]) });
    expect((await storage.getMedia('abc'))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(await storage.listMediaHashes()).toEqual(['abc']);

    await storage.setKv('test_key', { ok: true });
    expect(await storage.getKv('test_key')).toEqual({ ok: true });
    expect(await storage.requestPersistence()).toBe(true);
  });

  it('CapacitorMlKitInkRecognizer downloads model and recognizes timestamped strokes', async () => {
    let downloaded = false;
    let receivedPoints = 0;
    const recognizer = new CapacitorMlKitInkRecognizer({
      plugin: {
        isModelDownloaded: async () => ({ downloaded }),
        downloadModel: async () => {
          downloaded = true;
        },
        recognize: async ({ strokes, maxResults }) => {
          receivedPoints = strokes[0]?.points.length ?? 0;
          return {
            candidates: [
              { text: '一', score: 0.99 },
              { text: '二', score: 0.42 },
            ].slice(0, maxResults),
          };
        },
      },
    });

    expect(recognizer.id).toBe('mlkit-digital-ink');
    expect(recognizer.isNative).toBe(true);
    expect(await recognizer.isReady('ko')).toBe(false);

    const candidates = await recognizer.recognize(
      [
        [
          { x: 10, y: 50, t: 100 },
          { x: 90, y: 50, t: 220 },
        ],
      ],
      { lang: 'ko', maxResults: 5 },
    );
    expect(downloaded).toBe(true);
    expect(receivedPoints).toBe(2);
    expect(candidates[0]?.character).toBe('一');
  });

  it('CapacitorGoogleAuth + NativePickerBridge + StorePurchase + iCloudSyncTransport', async () => {
    const storage = new CapacitorSqliteStorage(new InMemorySqliteDriver());
    const auth = new CapacitorGoogleAuth({
      storage,
      plugin: {
        signIn: async () => ({ accessToken: 'native-tok-1', expiresInSeconds: 3600 }),
        refreshToken: async () => ({ accessToken: 'native-tok-2', expiresInSeconds: 3600 }),
        signOut: async () => undefined,
      },
    });
    const session = await auth.signIn({ intent: 'sync' });
    expect(session?.accessToken).toBe('native-tok-1');
    expect(await auth.getValidAccessToken({ forceRefresh: true })).toBe('native-tok-2');

    const bridge = new CapacitorNativePickerBridge({
      openAndAwaitDeepLink: async ({ url, state }) => {
        expect(url).toContain('https://flashcards.example/picker.html#');
        const filesJson = encodeURIComponent(
          JSON.stringify([
            {
              id: 'sheet-123',
              name: 'Korean Study Sheet',
              mimeType: 'application/vnd.google-apps.spreadsheet',
            },
          ]),
        );
        return `flashcards://picker-callback?files=${filesJson}&state=${state ?? ''}`;
      },
    });
    const picked = await bridge.openSystemBrowserPicker({
      pickerPageUrl: 'https://flashcards.example/picker.html',
      accessToken: 'native-tok-2',
      appId: '932735219487',
      apiKey: 'api-key-1',
    });
    expect(picked[0]?.id).toBe('sheet-123');

    const purchase = new CapacitorStorePurchase({
      storage,
      isPersonalBuild: false,
      billingPlugin: {
        purchaseNonConsumable: async () => ({ purchased: true, transactionId: 'tx-99' }),
        queryEntitlements: async () => ['unlock_full'],
      },
    });
    expect(await purchase.isUnlocked()).toBe(false);
    const unlocked = await purchase.purchaseUnlock();
    expect(unlocked.unlocked).toBe(true);
    expect(unlocked.source).toBe('store_iap');

    const icloudStore = new Map<string, Uint8Array>();
    const icloud = new ICloudDriveSyncTransport({
      listFiles: async ({ prefix }) =>
        [...icloudStore.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([path, b]) => ({ path, size: b.byteLength })),
      readFile: async ({ path }) => {
        const b = icloudStore.get(path);
        if (!b) throw pluginError('NOT_FOUND', 'missing');
        return b;
      },
      writeFile: async ({ path, data, ifAbsent }) => {
        if (ifAbsent && icloudStore.has(path)) throw pluginError('ALREADY_EXISTS', 'exists');
        icloudStore.set(path, data);
      },
    });
    await icloud.write('sync/v1/manifest.json', new Uint8Array([1, 2, 3]), { ifAbsent: true });
    expect((await icloud.list('sync/v1')).length).toBe(1);
    expect(await icloud.read('sync/v1/manifest.json')).toEqual(new Uint8Array([1, 2, 3]));

    const platform = createCapacitorPlatform({
      sqliteDriver: new InMemorySqliteDriver(),
      deviceId: 'cap-device-1',
      isPersonalBuild: true,
    });
    expect(platform.deviceId).toBe('cap-device-1');
    expect(await (await platform.getPurchase?.())?.isUnlocked()).toBe(true);
  });

  it('iCloud transport maps plugin error codes and gates on iCloud availability', async () => {
    const files = new Map<string, Uint8Array>();
    let available = false;
    const platform = createCapacitorPlatform({
      sqliteDriver: new InMemorySqliteDriver(),
      deviceId: 'cap-ios-icloud',
      iCloudPlugin: {
        isAvailable: async () => available,
        listFiles: async ({ prefix }) =>
          [...files.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .map(([path, b]) => ({ path, size: b.byteLength, updatedAt: 1000 })),
        readFile: async ({ path }) => {
          const b = files.get(path);
          if (!b) throw pluginError('NOT_FOUND', `iCloud Drive sync file not found: "${path}"`);
          return b;
        },
        writeFile: async ({ path, data, ifAbsent }) => {
          if (ifAbsent && files.has(path)) throw pluginError('ALREADY_EXISTS', 'exists');
          if (path.includes('locked')) throw pluginError('SOMETHING_ELSE', 'odd failure');
          files.set(path, data);
        },
      },
    });
    expect(platform.iCloudSyncSupported).toBe(true);
    await expect(platform.createICloudTransport?.()).rejects.toMatchObject({
      name: 'SyncTransportError',
      code: 'AUTH_REQUIRED',
    });

    available = true;
    const transport = await platform.createICloudTransport?.();
    if (!transport) throw new Error('expected an iCloud transport');
    await expect(transport.read('sync/v1/manifest.json')).rejects.toMatchObject({
      name: 'SyncTransportError',
      code: 'NOT_FOUND',
    });
    await transport.write('sync/v1/manifest.json', new Uint8Array([7]), { ifAbsent: true });
    await expect(
      transport.write('sync/v1/manifest.json', new Uint8Array([8]), { ifAbsent: true }),
    ).rejects.toMatchObject({ name: 'SyncTransportError', code: 'ALREADY_EXISTS' });
    await transport.write('sync/v1/manifest.json', new Uint8Array([9]));
    expect(await transport.read('sync/v1/manifest.json')).toEqual(new Uint8Array([9]));
    await expect(transport.write('sync/v1/locked.bin', new Uint8Array([1]))).rejects.toThrow(
      'odd failure',
    );
    await expect(transport.read('../outside')).rejects.toThrow(/Unsafe/);
    await expect(transport.read('sync/a/../../outside')).rejects.toThrow(/Unsafe/);
    // A name with two dots is not a `..` segment (§11 nit).
    await expect(transport.read('sync/v1/a..b.json')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await transport.list('sync/v1/')).toEqual([
      { path: 'sync/v1/manifest.json', size: 1, updatedAt: 1000 },
    ]);

    const android = createCapacitorPlatform({
      sqliteDriver: new InMemorySqliteDriver(),
      deviceId: 'cap-android',
    });
    expect(android.iCloudSyncSupported).toBeUndefined();
    expect(android.createICloudTransport).toBeUndefined();
  });
});

describe('createAddDeviceUrlSource (flashcards://add-device)', () => {
  function fakeApp(launchUrl?: string) {
    let listener: ((e: { url: string }) => void) | undefined;
    const remove = vi.fn(async () => undefined);
    return {
      app: {
        getLaunchUrl: vi.fn(async () => (launchUrl ? { url: launchUrl } : undefined)),
        addListener: vi.fn(async (_name: string, cb: (e: { url: string }) => void) => {
          listener = cb;
          return { remove };
        }),
      } as never,
      emit: (url: string) => listener?.({ url }),
      remove,
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('delivers the launch URL once and later add-device links only', async () => {
    const f = fakeApp('flashcards://add-device?sync=google');
    const source = createAddDeviceUrlSource(f.app);
    const first = vi.fn();
    const stop = source(first);
    await tick();
    f.emit('flashcards://oauth/microsoft');
    f.emit('flashcards://add-device.evil?sync=google');
    f.emit('flashcards://add-device?sync=dropbox');
    expect(first.mock.calls.map((c) => c[0])).toEqual([
      'flashcards://add-device?sync=google',
      'flashcards://add-device?sync=dropbox',
    ]);
    stop();
    await tick();
    expect(f.remove).toHaveBeenCalled();
    const second = vi.fn();
    source(second);
    await tick();
    expect(second).not.toHaveBeenCalled();
  });
});
