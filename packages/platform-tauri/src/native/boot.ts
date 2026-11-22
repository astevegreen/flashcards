import type { PlatformServices } from '@flash/platform';
import { composeNativePlatform } from '@flash/platform-web/native-support';
import { createTauriPlatform } from '../index.ts';
import {
  asSqlPluginDatabase,
  createDesktopFiles,
  createFsBridge,
  createLoopbackOAuthPlugin,
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
  packCatalogUrl?: string;
  starterCatalogUrl?: string;
}

const REFRESH_TOKEN_TABLE =
  'CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (provider TEXT PRIMARY KEY, token TEXT NOT NULL)';

/**
 * Boots `PlatformServices` for the Tauri desktop shell with real Tauri v2 plugins.
 * Called by `apps/web/src/main.tsx` only when the Tauri runtime is detected.
 */
export async function bootTauriPlatform(config: TauriBootConfig): Promise<PlatformServices> {
  const db = await openTauriDatabase();
  const sqlDb = asSqlPluginDatabase(db);
  await sqlDb.execute(REFRESH_TOKEN_TABLE);

  const fsBridge = createFsBridge();
  const oauthPlugin = config.googleDesktopClientId
    ? createLoopbackOAuthPlugin({
        clientId: config.googleDesktopClientId,
        ...(config.googleDesktopClientSecret
          ? { clientSecret: config.googleDesktopClientSecret }
          : {}),
        // TODO(phase-8): move to the OS keychain (e.g. a keyring plugin) — see docs/native-shells.md.
        tokenStore: {
          get: async () => {
            const rows = await sqlDb.select<{ token: string }>(
              'SELECT token FROM oauth_refresh_tokens WHERE provider = $1',
              ['google'],
            );
            return rows[0]?.token;
          },
          set: async (token) => {
            await sqlDb.execute(
              'INSERT INTO oauth_refresh_tokens (provider, token) VALUES ($1, $2) ON CONFLICT(provider) DO UPDATE SET token = excluded.token',
              ['google', token],
            );
          },
          delete: async () => {
            await sqlDb.execute('DELETE FROM oauth_refresh_tokens WHERE provider = $1', ['google']);
          },
        },
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
  });

  return composeNativePlatform(native, base);
}
