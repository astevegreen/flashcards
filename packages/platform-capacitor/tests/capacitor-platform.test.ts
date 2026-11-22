import { describe, expect, it } from 'vitest';
import { createEventFactory, createHlcState } from '../../core/src/index.ts';
import { createInitialSchedule } from '../../core/src/fsrs/scheduler.ts';
import {
  CapacitorGoogleAuth,
  CapacitorMlKitInkRecognizer,
  CapacitorNativePickerBridge,
  CapacitorSqliteStorage,
  CapacitorStorePurchase,
  createCapacitorPlatform,
  ICloudDriveSyncTransport,
} from '../src/index.ts';

describe('Phase 8 Capacitor Platform Adapters (§4.3, §6.4, §11, §12.1)', () => {
  it('CapacitorSqliteStorage stores/queries events, local_seq, cards_cache, media & kv', async () => {
    const storage = new CapacitorSqliteStorage();
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
    expect((await storage.getEventsForCard('c1')).length).toBe(1);
    expect((await storage.getDeviceEventsAfterSeq('cap-ios-1', 1)).map((e) => e.id)).toEqual([
      ev2.id,
    ]);
    expect(await storage.getMaxLocalSeq()).toBe(2);
    const delta = await storage.getEventsAfterLocalSeq(1);
    expect(delta.events.length).toBe(1);
    expect(delta.maxLocalSeq).toBe(2);

    await storage.saveMaterializedCards([
      {
        id: 'c1',
        deck_id: 'd1',
        note_id: 'n1',
        layout_id: 'l1',
        due: 5000,
        schedule: createInitialSchedule(0),
      },
    ]);
    expect((await storage.loadMaterializedCards()).length).toBe(1);
    await storage.deleteMaterializedCards(['c1']);
    expect((await storage.loadMaterializedCards()).length).toBe(0);

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
    const storage = new CapacitorSqliteStorage();
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
      openAndAwaitDeepLink: async ({ url }) => {
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
        return `flashcards://picker-callback?files=${filesJson}`;
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
        if (!b) throw new Error('missing');
        return b;
      },
      writeFile: async ({ path, data, ifAbsent }) => {
        if (ifAbsent && icloudStore.has(path)) return;
        icloudStore.set(path, data);
      },
    });
    await icloud.write('sync/v1/manifest.json', new Uint8Array([1, 2, 3]), { ifAbsent: true });
    expect((await icloud.list('sync/v1')).length).toBe(1);
    expect(await icloud.read('sync/v1/manifest.json')).toEqual(new Uint8Array([1, 2, 3]));

    const platform = createCapacitorPlatform({
      deviceId: 'cap-device-1',
      isPersonalBuild: true,
    });
    expect(platform.deviceId).toBe('cap-device-1');
    expect(await (await platform.getPurchase?.())?.isUnlocked()).toBe(true);
  });
});
