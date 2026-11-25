import type { PlatformServices } from '@flash/platform';

/** Shared, already-resolved web boot settings forwarded to the native shells. */
export interface NativeBootSettings {
  googleClientId: string;
  googleApiKey: string;
  isPersonalBuild: boolean;
  licensePublicKeyHex: string;
  /** Microsoft Entra client ID (OneDrive); native shells use it as a public client. */
  microsoftClientId: string;
  microsoftTenant: string;
  /** Dropbox App Folder app key (public PKCE client, no secret). */
  dropboxAppKey: string;
  packCatalogUrl: string;
  starterCatalogUrl: string;
}

function envString(key: string): string {
  return (import.meta.env[key] as string | undefined)?.trim() || '';
}

function nonEmpty<K extends string>(key: K, value: string): { [P in K]?: string } {
  return (value ? { [key]: value } : {}) as { [P in K]?: string };
}

/**
 * Lazily loaded only inside the Capacitor / Tauri shells (§10.1, §15 Phase 8): swaps the web
 * platform for native plugin-backed services while reusing the identical `apps/web/dist` bundle.
 */
export async function bootNativePlatform(
  runtime: 'capacitor' | 'tauri',
  webPlatform: PlatformServices,
  settings: NativeBootSettings,
): Promise<PlatformServices> {
  const common = {
    base: webPlatform,
    isPersonalBuild: settings.isPersonalBuild,
    ...nonEmpty('googleApiKey', settings.googleApiKey),
    ...nonEmpty('pickerPageUrl', envString('VITE_PICKER_PAGE_URL')),
    ...nonEmpty('packCatalogUrl', settings.packCatalogUrl),
    ...nonEmpty('starterCatalogUrl', settings.starterCatalogUrl),
    ...nonEmpty('microsoftClientId', settings.microsoftClientId),
    ...nonEmpty('microsoftTenant', settings.microsoftTenant),
    ...nonEmpty('dropboxAppKey', settings.dropboxAppKey),
  };
  if (runtime === 'capacitor') {
    const { bootCapacitorPlatform } = await import('@flash/platform-capacitor/native');
    return bootCapacitorPlatform({
      ...common,
      ...nonEmpty('googleClientId', settings.googleClientId),
      ...nonEmpty('googleIosClientId', envString('VITE_GOOGLE_IOS_CLIENT_ID')),
    });
  }
  const { bootTauriPlatform } = await import('@flash/platform-tauri/native');
  return bootTauriPlatform({
    ...common,
    ...nonEmpty('googleDesktopClientId', envString('VITE_GOOGLE_DESKTOP_CLIENT_ID')),
    ...nonEmpty('googleDesktopClientSecret', envString('VITE_GOOGLE_DESKTOP_CLIENT_SECRET')),
    ...nonEmpty('licensePublicKeyHex', settings.licensePublicKeyHex),
  });
}
