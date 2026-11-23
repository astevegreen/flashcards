/**
 * Real Capacitor plugin adapters for the injected interfaces in `@flash/platform-capacitor`
 * (§10.1, §11, §15 Phase 8). Only imported from `./boot.ts`, which `apps/web` loads lazily
 * when it detects a native Capacitor runtime, so none of this reaches the PWA's initial chunk.
 */
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { DigitalInkRecognition } from '@capacitor-mlkit/digital-ink-recognition';
import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Share } from '@capacitor/share';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { SocialLogin } from '@capgo/capacitor-social-login';
import { NativePurchases, PURCHASE_TYPE } from '@capgo/native-purchases';
import { FlashSecureStorage } from '@flash/capacitor-secure-storage';
import type { PickedFile } from '@flash/platform';
import { createGoogleSignIn, type GoogleSignInOptions } from '../auth/google-social-login.ts';
import type { NativeGoogleSignInPlugin } from '../auth/native-google-auth.ts';
import type { MlKitDigitalInkPlugin } from '../drawing/mlkit-ink-recognizer.ts';
import type { CapacitorFileBridge } from '../files/capacitor-files.ts';
import type { StoreBillingPlugin } from '../purchase/store-purchase.ts';
import type { LocalNotificationsBridge } from '../reminders/local-notification-reminders.ts';
import type { SystemBrowserLauncher } from '../sources/native-picker-bridge.ts';
import type { SqliteDriver } from '../storage/sqlite-storage.ts';
import type { NativeSecureStorage } from '../secure/secure-store.ts';
import type { ICloudDocumentPlugin } from '../sync/icloud-transport.ts';
import { isAppDeepLink, PICKER_CALLBACK_HOST } from './deep-links.ts';

// ---------------------------------------------------------------------------
// SQLite (@capacitor-community/sqlite)
// ---------------------------------------------------------------------------

/** Opens (or reuses) the on-device SQLite database and adapts it to `SqliteDriver`. */
export async function openCapacitorSqliteDriver(dbName = 'flashcards'): Promise<SqliteDriver> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  await sqlite.checkConnectionsConsistency().catch(() => undefined);
  const existing = await sqlite.isConnection(dbName, false);
  const db: SQLiteDBConnection = existing.result
    ? await sqlite.retrieveConnection(dbName, false)
    : await sqlite.createConnection(dbName, false, 'no-encryption', 1, false);
  await db.open();
  // Deleted rows are overwritten with zeros, so a secret moved out of SQLite (or any deleted card)
  // does not linger in free pages. Per connection, so it is set on every open.
  await db.execute('PRAGMA secure_delete = ON;', false);
  return {
    execute: async (sql, params) => {
      // `transaction: false` — `CapacitorSqliteStorage` issues its own BEGIN/COMMIT when needed.
      await db.run(sql, params ? [...params] : [], false);
    },
    query: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
      const res = await db.query(sql, params ? [...params] : []);
      return (res.values ?? []) as T[];
    },
  };
}

// ---------------------------------------------------------------------------
// Google Sign-In (@capgo/capacitor-social-login)
// ---------------------------------------------------------------------------

export interface CapacitorGoogleSignInConfig extends GoogleSignInOptions {
  /** Google OAuth *Web* client ID (Android uses it as the server client ID). */
  webClientId: string;
  /** Google OAuth iOS client ID (required on iOS only). */
  iOSClientId?: string;
}

/** Native Google Sign-In via Android Credential Manager / iOS GoogleSignIn (`createGoogleSignIn`). */
export async function createGoogleSignInPlugin(
  config: CapacitorGoogleSignInConfig,
): Promise<NativeGoogleSignInPlugin> {
  await SocialLogin.initialize({
    google: {
      webClientId: config.webClientId,
      ...(config.iOSClientId ? { iOSClientId: config.iOSClientId } : {}),
      mode: 'online',
    },
  });
  return createGoogleSignIn(
    {
      login: async ({ scopes, silent }) => {
        const res = await SocialLogin.login({
          provider: 'google',
          options: {
            scopes,
            ...(silent ? { filterByAuthorizedAccounts: true, autoSelectEnabled: true } : {}),
          },
        });
        return res.result;
      },
      logout: async () => {
        await SocialLogin.logout({ provider: 'google' });
      },
    },
    config.afterLogin ? { afterLogin: config.afterLogin } : {},
  );
}

// ---------------------------------------------------------------------------
// System browser + `flashcards://picker-callback` deep link (@capacitor/browser + @capacitor/app)
// ---------------------------------------------------------------------------

/** Opens the hosted `picker.html` in the system browser and resolves with the deep-link URL. */
export function createSystemBrowserLauncher(): SystemBrowserLauncher {
  return {
    openAndAwaitDeepLink: async ({ url, callbackScheme }) => {
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const handles: Array<Promise<{ remove: () => Promise<void> }>> = [];
        const cleanup = () => {
          for (const h of handles) void h.then((x) => x.remove());
        };
        handles.push(
          App.addListener('appUrlOpen', (event) => {
            // Exact scheme + host: other deep links (e.g. the OneDrive sign-in redirect) are ignored.
            if (settled || !isAppDeepLink(event.url, callbackScheme, PICKER_CALLBACK_HOST)) return;
            settled = true;
            cleanup();
            void Browser.close().catch(() => undefined);
            resolve(event.url);
          }),
        );
        handles.push(
          Browser.addListener('browserFinished', () => {
            // The custom tab / SFSafariViewController was dismissed without a callback.
            setTimeout(() => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error('Google Picker was closed before selecting files.'));
            }, 1500);
          }),
        );
        Browser.open({ url }).catch((err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Files (@capawesome/capacitor-file-picker + @capacitor/filesystem + @capacitor/share)
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function acceptToTypes(accept: string | undefined): string[] | undefined {
  if (!accept) return undefined;
  // The native pickers filter by MIME type only; extensions (".csv", ".flashpkg") fall back to "any".
  const mimes = accept
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('/'));
  return mimes.length > 0 && mimes.length === accept.split(',').length ? mimes : undefined;
}

export function createFileBridge(): CapacitorFileBridge {
  return {
    pickFile: async (opts): Promise<PickedFile | null> => {
      const types = acceptToTypes(opts?.accept);
      const maxBytes = opts?.maxBytes;
      // With a size limit the picker returns only the size and path first, so a file over the
      // limit is never read (a 300 MB file read as base64 can exhaust a phone's WebView memory).
      const readData = maxBytes === undefined;
      const res = await FilePicker.pickFiles({
        limit: 1,
        readData,
        ...(types ? { types } : {}),
      }).catch((err: unknown) => {
        if (err instanceof Error && /cancel/i.test(err.message)) return { files: [] };
        throw err;
      });
      const file = res.files[0];
      if (!file) return null;
      const mime = file.mimeType ? { mime: file.mimeType } : {};
      if (maxBytes !== undefined && file.size > maxBytes) {
        return {
          name: file.name,
          bytes: new Uint8Array(0),
          size: file.size,
          tooLarge: true,
          ...mime,
        };
      }
      let data = file.data;
      if (data === undefined && file.path) {
        const read = await Filesystem.readFile({ path: file.path });
        data = typeof read.data === 'string' ? read.data : undefined;
        if (data === undefined && read.data instanceof Blob) {
          return {
            name: file.name,
            bytes: new Uint8Array(await read.data.arrayBuffer()),
            size: file.size,
            ...mime,
          };
        }
      }
      if (data === undefined) return null;
      return { name: file.name, bytes: base64ToBytes(data), size: file.size, ...mime };
    },
    saveAndShareFile: async ({ filename, data }) => {
      const written = await Filesystem.writeFile({
        path: filename,
        data: bytesToBase64(data),
        directory: Directory.Cache,
      });
      await Share.share({ title: filename, files: [written.uri] });
    },
  };
}

// ---------------------------------------------------------------------------
// Handwriting (@capacitor-mlkit/digital-ink-recognition)
// ---------------------------------------------------------------------------

/** Maps the adapter's script tags onto ML Kit's BCP-47 model identifiers. */
function toMlKitModelTag(tag: string): string {
  if (tag === 'zh-Hant') return 'zh-Hani-TW';
  if (tag === 'zh-Hans') return 'zh-Hani-CN';
  return tag;
}

export function createMlKitInkPlugin(): MlKitDigitalInkPlugin {
  return {
    isModelDownloaded: async ({ languageTag }) => {
      const { languageTags } = await DigitalInkRecognition.getDownloadedModels();
      return { downloaded: languageTags.includes(toMlKitModelTag(languageTag)) };
    },
    downloadModel: async ({ languageTag }) => {
      await DigitalInkRecognition.downloadModel({ languageTag: toMlKitModelTag(languageTag) });
    },
    recognize: async ({ languageTag, strokes, maxResults }) => {
      const res = await DigitalInkRecognition.recognize({
        languageTag: toMlKitModelTag(languageTag),
        strokes,
        maxResultCount: maxResults,
      });
      return {
        candidates: res.candidates.map((c) => ({
          text: c.text,
          ...(typeof c.score === 'number' ? { score: c.score } : {}),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// StoreKit 2 / Play Billing (@capgo/native-purchases)
// ---------------------------------------------------------------------------

export function createStoreBillingPlugin(): StoreBillingPlugin {
  return {
    purchaseNonConsumable: async (productId) => {
      const tx = await NativePurchases.purchaseProduct({
        productIdentifier: productId,
        productType: PURCHASE_TYPE.INAPP,
        isConsumable: false,
        autoAcknowledgePurchases: true,
      });
      return { purchased: Boolean(tx.transactionId), transactionId: tx.transactionId };
    },
    queryEntitlements: async () => {
      const { purchases } = await NativePurchases.getPurchases({
        productType: PURCHASE_TYPE.INAPP,
        onlyCurrentEntitlements: true,
      });
      return purchases
        .filter((p) => !p.revocationDate && p.isActive !== false)
        .map((p) => p.productIdentifier);
    },
  };
}

// ---------------------------------------------------------------------------
// Study reminders (@capacitor/local-notifications)
// ---------------------------------------------------------------------------

export function createLocalNotificationsBridge(): LocalNotificationsBridge {
  return {
    checkPermissions: () => LocalNotifications.checkPermissions(),
    requestPermissions: () => LocalNotifications.requestPermissions(),
    schedule: (options) => LocalNotifications.schedule(options),
    getPending: async () => ({
      notifications: (await LocalNotifications.getPending()).notifications.map((n) => ({
        id: n.id,
      })),
    }),
    cancel: (options) => LocalNotifications.cancel(options),
  };
}

// ---------------------------------------------------------------------------
// iCloud Drive (local Swift plugin: apps/mobile/ios/App/App/ICloudDocumentsPlugin.swift)
// ---------------------------------------------------------------------------

interface ICloudDocumentsNative {
  isAvailable(): Promise<{ available: boolean }>;
  listFiles(opts: {
    prefix: string;
  }): Promise<{ files: Array<{ path: string; size: number; updatedAt?: number }> }>;
  readFile(opts: { path: string }): Promise<{ data: string }>;
  writeFile(opts: { path: string; data: string; ifAbsent?: boolean }): Promise<void>;
}

/** Adapts the iOS-only `ICloudDocuments` plugin; bytes cross the bridge as base64. */
export function createICloudDocumentPlugin(): ICloudDocumentPlugin {
  const native = registerPlugin<ICloudDocumentsNative>('ICloudDocuments');
  return {
    isAvailable: async () => (await native.isAvailable()).available,
    listFiles: async ({ prefix }) => (await native.listFiles({ prefix })).files,
    readFile: async ({ path }) => base64ToBytes((await native.readFile({ path })).data),
    writeFile: async ({ path, data, ifAbsent }) => {
      await native.writeFile({
        path,
        data: bytesToBase64(data),
        ...(ifAbsent !== undefined ? { ifAbsent } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Keychain / Keystore (workspace plugin `@flash/capacitor-secure-storage`)
// ---------------------------------------------------------------------------

export function createNativeSecureStorage(): NativeSecureStorage {
  return {
    get: async (key) => (await FlashSecureStorage.get({ key })).value,
    set: async (key, value) => {
      await FlashSecureStorage.set({ key, value });
    },
    remove: async (key) => {
      await FlashSecureStorage.remove({ key });
    },
    removeLegacyPreference: async (entry) => {
      await FlashSecureStorage.removeLegacyPreference({
        key: entry.key,
        ...(entry.androidPreferencesName
          ? { androidPreferencesName: entry.androidPreferencesName }
          : {}),
      });
    },
  };
}
