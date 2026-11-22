import type { PlatformServices } from '@flash/platform';
import { composeNativePlatform, lazyOneDriveFields } from '@flash/platform-web/native-support';
import {
  createSqliteRefreshTokenStore,
  resolveRefreshTokenStore,
} from '../auth/refresh-token-store.ts';
import { createTauriPlatform } from '../index.ts';
import {
  asSqlPluginDatabase,
  createDesktopFiles,
  createDesktopNotificationBridge,
  createFsBridge,
  createLoopbackOAuthPlugin,
  createSecureSecretBackend,
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
  packCatalogUrl?: string;
  starterCatalogUrl?: string;
}

/** Shown in Settings when the Google refresh token has to stay in SQLite. */
export const INSECURE_TOKEN_STORAGE_WARNING =
  'Your Google sign-in is saved in the app database, not in a secure store, because no OS keychain was found. Install and unlock a keyring (for example GNOME Keyring or KWallet), then restart the app to move it there.';

/**
 * Boots `PlatformServices` for the Tauri desktop shell with real Tauri v2 plugins.
 * Called by `apps/web/src/main.tsx` only when the Tauri runtime is detected.
 */
export async function bootTauriPlatform(config: TauriBootConfig): Promise<PlatformServices> {
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
    // Only relevant when Google sign-in is configured at all.
    ...(oauthPlugin && secureStorageWarning ? { secureStorageWarning } : {}),
  });

  const microsoftClientId = config.microsoftClientId;
  const oneDrive = microsoftClientId
    ? lazyOneDriveFields(async () => {
        const [{ createMicrosoftLoopbackBridge }, { createNativeOneDriveServices }] =
          await Promise.all([
            import('./microsoft-loopback.ts'),
            import('@flash/platform-web/onedrive'),
          ]);
        // Runs after the Google store above, so its one-time SQLite -> keychain move is done.
        const msTokens = await resolveRefreshTokenStore({
          secure: createSecureSecretBackend(),
          legacy: createSqliteRefreshTokenStore(sqlDb, 'microsoft'),
          account: 'microsoft-refresh-token',
          onInsecureFallback: (reason) => {
            console.warn(`Microsoft refresh token stays in SQLite: ${reason}`);
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

  return {
    ...composeNativePlatform(native, base),
    ...oneDrive,
    // Phase 13 study reminders: desktop notifications while the app runs. The notification
    // plugin cannot schedule on desktop, so nothing fires after the app quits (Settings says so).
    studyReminderDelivery: 'while-app-runs',
    getStudyReminderScheduler: async () => {
      const { createDesktopReminderScheduler } = await import('../reminders/desktop-reminders.ts');
      return createDesktopReminderScheduler(createDesktopNotificationBridge());
    },
  };
}
