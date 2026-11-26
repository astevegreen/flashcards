import type { PlatformServices } from '@flash/platform';
import {
  composeNativePlatform,
  lazyDropboxFields,
  lazyOneDriveFields,
} from '@flash/platform-web/native-support';
import {
  createSqliteRefreshTokenStore,
  resolveRefreshTokenStore,
} from '../auth/refresh-token-store.ts';
import { createTauriPlatform } from '../index.ts';
import { scrubFreePagesOnce } from '../storage/scrub-once.ts';
import {
  asSqlPluginDatabase,
  createDesktopFiles,
  createDesktopNotificationBridge,
  createFsBridge,
  createICloudOptions,
  createLoopbackOAuthPlugin,
  createSecureSecretBackend,
  createAddDeviceUrlSource,
  createSystemBrowserLauncher,
  openTauriDatabase,
} from './plugins.ts';

export interface TauriBootConfig {
  /** Browser services (`createWebPlatform()`) reused inside the WebView. */
  base: PlatformServices;
  /** Google OAuth client of type "Desktop app" (loopback redirect). */
  googleDesktopClientId?: string;
  googleDesktopClientSecret?: string;
  googleApiKey?: string;
  /** HTTPS URL of the hosted `picker.html` page opened in the system browser (§11). */
  pickerPageUrl?: string;
  isPersonalBuild: boolean;
  licensePublicKeyHex?: string;
  /** Entra client ID for OneDrive (public client, loopback redirect `http://localhost`). */
  microsoftClientId?: string;
  microsoftTenant?: string;
  /** Dropbox App Folder app key (public PKCE client, fixed loopback `http://127.0.0.1:53682`). */
  dropboxAppKey?: string;
  packCatalogUrl?: string;
  starterCatalogUrl?: string;
}

/** Shown in Settings when the Google refresh token has to stay in SQLite. */
export const INSECURE_TOKEN_STORAGE_WARNING =
  'Your Google sign-in is saved in the app database, not in a secure store, because no OS keychain was found. Install and unlock a keyring (for example GNOME Keyring or KWallet), then restart the app to move it there.';

/** Shown in Settings when the Microsoft (OneDrive) refresh token has to stay in SQLite. */
export const INSECURE_MICROSOFT_TOKEN_STORAGE_WARNING =
  'Your OneDrive sign-in is saved in the app database, not in a secure store, because the OS keychain could not be used. Install and unlock a keyring (for example GNOME Keyring or KWallet), then restart the app to move it there.';

/** Shown in Settings when the Dropbox refresh token has to stay in SQLite. */
export const INSECURE_DROPBOX_TOKEN_STORAGE_WARNING =
  'Your Dropbox sign-in is saved in the app database, not in a secure store, because the OS keychain could not be used. Install and unlock a keyring (for example GNOME Keyring or KWallet), then restart the app to move it there.';

/**
 * Boots `PlatformServices` for the Tauri desktop shell with real Tauri v2 plugins.
 * Called by `apps/web/src/main.tsx` only when the Tauri runtime is detected.
 */
export async function bootTauriPlatform(config: TauriBootConfig): Promise<PlatformServices> {
  // macOS builds with the iCloud entitlement: iCloud Drive (same container as the iOS app) is
  // always offered, and becomes the "Sync my devices" default when it is available at launch.
  // Unsigned builds have no iCloud container and never offer it. Probed alongside the database open.
  const iCloudReady = createICloudOptions();
  const db = await openTauriDatabase();
  const sqlDb = asSqlPluginDatabase(db);

  let secureStorageWarning: string | undefined;
  const tokenStorage = await resolveRefreshTokenStore({
    secure: createSecureSecretBackend(),
    legacy: createSqliteRefreshTokenStore(sqlDb, 'google'),
    account: 'google-refresh-token',
    onInsecureFallback: (reason) => {
      console.warn(`Google refresh token stays in SQLite: ${reason}`);
      secureStorageWarning = INSECURE_TOKEN_STORAGE_WARNING;
    },
  });

  const fsBridge = createFsBridge();
  const oauthPlugin = config.googleDesktopClientId
    ? createLoopbackOAuthPlugin({
        clientId: config.googleDesktopClientId,
        ...(config.googleDesktopClientSecret
          ? { clientSecret: config.googleDesktopClientSecret }
          : {}),
        tokenStore: tokenStorage.store,
      })
    : undefined;

  const base = config.base;
  const native = createTauriPlatform({
    deviceId: 'tauri-desktop',
    deviceLabel: 'Desktop App',
    sqlDb,
    fsBridge,
    files: createDesktopFiles(fsBridge),
    ...(oauthPlugin ? { oauthPlugin } : {}),
    ...(config.googleDesktopClientId ? { googleClientId: config.googleDesktopClientId } : {}),
    pickerLauncher: createSystemBrowserLauncher(),
    ...(config.pickerPageUrl ? { pickerPageUrl: config.pickerPageUrl } : {}),
    ...(config.googleApiKey ? { googleApiKey: config.googleApiKey } : {}),
    isPersonalBuild: config.isPersonalBuild,
    ...(config.licensePublicKeyHex ? { licensePublicKeyHex: config.licensePublicKeyHex } : {}),
    ...(config.packCatalogUrl ? { packCatalogUrl: config.packCatalogUrl } : {}),
    ...(config.starterCatalogUrl ? { starterCatalogUrl: config.starterCatalogUrl } : {}),
    ...(await iCloudReady),
    // Only relevant when Google sign-in is configured at all.
    ...(oauthPlugin && secureStorageWarning ? { secureStorageWarning } : {}),
  });

  // After the Google token has moved to the keychain: rebuild the file once so rows deleted by
  // older builds (before SQLite had secure_delete on) leave nothing in free pages (N9).
  await scrubFreePagesOnce({
    storage: native.storage,
    vacuum: async () => {
      await sqlDb.execute('VACUUM');
    },
  });

  const microsoftClientId = config.microsoftClientId;
  // Set when OneDrive first loads (lazily) and its token has to stay in SQLite.
  let microsoftStorageWarning: string | undefined;
  const oneDrive = microsoftClientId
    ? lazyOneDriveFields(async () => {
        const [{ createMicrosoftLoopbackBridge }, { createNativeOneDriveServices }] =
          await Promise.all([
            import('./microsoft-loopback.ts'),
            import('@flash/platform-web/onedrive'),
          ]);
        // Each provider's legacy store touches only its own SQLite row, so this never affects
        // a Google token that had to stay in SQLite (and vice versa).
        const msTokens = await resolveRefreshTokenStore({
          secure: createSecureSecretBackend(),
          legacy: createSqliteRefreshTokenStore(sqlDb, 'microsoft'),
          account: 'microsoft-refresh-token',
          onInsecureFallback: (reason) => {
            console.warn(`Microsoft refresh token stays in SQLite: ${reason}`);
            microsoftStorageWarning = INSECURE_MICROSOFT_TOKEN_STORAGE_WARNING;
          },
        });
        return createNativeOneDriveServices({
          bridge: createMicrosoftLoopbackBridge({
            clientId: microsoftClientId,
            ...(config.microsoftTenant ? { tenant: config.microsoftTenant } : {}),
            tokenStore: msTokens.store,
          }),
          storage: native.storage,
        });
      })
    : {};

  const dropboxAppKey = config.dropboxAppKey;
  let dropboxStorageWarning: string | undefined;
  const dropbox = dropboxAppKey
    ? lazyDropboxFields(async () => {
        const [{ createDropboxLoopbackBridge }, { createNativeDropboxServices }] =
          await Promise.all([
            import('./dropbox-loopback.ts'),
            import('@flash/platform-web/dropbox'),
          ]);
        const dbxTokens = await resolveRefreshTokenStore({
          secure: createSecureSecretBackend(),
          legacy: createSqliteRefreshTokenStore(sqlDb, 'dropbox'),
          account: 'dropbox-refresh-token',
          onInsecureFallback: (reason) => {
            console.warn(`Dropbox refresh token stays in SQLite: ${reason}`);
            dropboxStorageWarning = INSECURE_DROPBOX_TOKEN_STORAGE_WARNING;
          },
        });
        return createNativeDropboxServices({
          bridge: createDropboxLoopbackBridge({
            appKey: dropboxAppKey,
            tokenStore: dbxTokens.store,
          }),
          storage: native.storage,
        });
      })
    : {};

  const platform: PlatformServices = {
    ...composeNativePlatform(native, base),
    onAddDeviceUrl: createAddDeviceUrlSource(),
    ...oneDrive,
    ...dropbox,
    // Phase 13 study reminders: desktop notifications while the app runs. The notification
    // plugin cannot schedule on desktop, so nothing fires after the app quits (Settings says so).
    studyReminderDelivery: 'while-app-runs',
    getStudyReminderScheduler: async () => {
      const { createDesktopReminderScheduler } = await import('../reminders/desktop-reminders.ts');
      return createDesktopReminderScheduler(createDesktopNotificationBridge());
    },
  };
  // The OneDrive / Dropbox token stores resolve lazily, after boot: read the warnings when Settings renders.
  const googleWarning = oauthPlugin ? secureStorageWarning : undefined;
  Object.defineProperty(platform, 'secureStorageWarning', {
    enumerable: true,
    configurable: true,
    get: () =>
      [googleWarning, microsoftStorageWarning, dropboxStorageWarning]
        .filter((w) => w !== undefined)
        .join(' ') || undefined,
  });
  return platform;
}
