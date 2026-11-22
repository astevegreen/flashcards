import type { PlatformServices } from '@flash/platform';
import {
  composeNativePlatform,
  LazyHandwritingRecognizer,
} from '@flash/platform-web/native-support';
import { Capacitor } from '@capacitor/core';
import { createCapacitorPlatform } from '../index.ts';
import {
  createFileBridge,
  createGoogleSignInPlugin,
  createICloudDocumentPlugin,
  createMlKitInkPlugin,
  createStoreBillingPlugin,
  createSystemBrowserLauncher,
  openCapacitorSqliteDriver,
} from './plugins.ts';

export interface CapacitorBootConfig {
  /** Browser services (`createWebPlatform()`) reused inside the WebView. */
  base: PlatformServices;
  googleClientId?: string;
  googleIosClientId?: string;
  googleApiKey?: string;
  /** HTTPS URL of the hosted `picker.html` page opened in the system browser (§11). */
  pickerPageUrl?: string;
  isPersonalBuild: boolean;
  packCatalogUrl?: string;
  starterCatalogUrl?: string;
}

/**
 * Boots `PlatformServices` for the Capacitor Android / iOS shell with real native plugins.
 * Called by `apps/web/src/main.tsx` only when `Capacitor.isNativePlatform()` is true.
 *
 * On iOS, iCloud Drive sync uses the app's own Swift plugin (`ICloudDocumentsPlugin.swift`),
 * registered by `MainViewController`.
 */
export async function bootCapacitorPlatform(
  config: CapacitorBootConfig,
): Promise<PlatformServices> {
  const platformName = Capacitor.getPlatform();
  const sqliteDriver = await openCapacitorSqliteDriver();

  const googleSignInPlugin = config.googleClientId
    ? await createGoogleSignInPlugin({
        webClientId: config.googleClientId,
        ...(config.googleIosClientId ? { iOSClientId: config.googleIosClientId } : {}),
      }).catch((err: unknown) => {
        console.warn('Google Sign-In plugin unavailable:', err);
        return undefined;
      })
    : undefined;

  const base = config.base;
  const native = createCapacitorPlatform({
    deviceId: `capacitor-${platformName}`,
    deviceLabel: platformName === 'ios' ? 'iPhone / iPad' : 'Android Device',
    sqliteDriver,
    fileBridge: createFileBridge(),
    ...(googleSignInPlugin ? { googleSignInPlugin } : {}),
    ...(config.googleClientId ? { googleClientId: config.googleClientId } : {}),
    pickerLauncher: createSystemBrowserLauncher(),
    ...(config.pickerPageUrl ? { pickerPageUrl: config.pickerPageUrl } : {}),
    ...(config.googleApiKey ? { googleApiKey: config.googleApiKey } : {}),
    mlKitPlugin: createMlKitInkPlugin(),
    ...(base.getHandwritingRecognizer
      ? { fallbackRecognizer: new LazyHandwritingRecognizer(base.getHandwritingRecognizer) }
      : {}),
    billingPlugin: createStoreBillingPlugin(),
    ...(platformName === 'ios' ? { iCloudPlugin: createICloudDocumentPlugin() } : {}),
    isPersonalBuild: config.isPersonalBuild,
    ...(config.packCatalogUrl ? { packCatalogUrl: config.packCatalogUrl } : {}),
    ...(config.starterCatalogUrl ? { starterCatalogUrl: config.starterCatalogUrl } : {}),
  });

  return composeNativePlatform(native, base);
}
