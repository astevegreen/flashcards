import type { PlatformServices } from '@flash/platform';
import type { AddDeviceLink, AddDeviceProvider } from './addDeviceLink.ts';

/**
 * Phase 14 "One Sync my devices button": which storage connectors this device offers, which one
 * the button uses by default, and which are listed as alternatives. Decided only from the
 * platform object (boot-time config and the native shell's capabilities), never from the user
 * agent, so the choice is known at first paint and never changes under the pointer.
 */

export interface SyncProviderInfo {
  kind: AddDeviceProvider;
  /** Name inside a sentence, e.g. "Continue with Google Drive". */
  name: string;
  /** Name on its own, e.g. on an alternative's button. */
  label: string;
  /** One line under the button: what signing in involves. */
  hint: string;
}

const PROVIDER_INFO = new Map<AddDeviceProvider, SyncProviderInfo>([
  [
    'icloud',
    {
      kind: 'icloud',
      label: 'iCloud Drive',
      name: 'iCloud Drive',
      hint: 'Uses the Apple ID this device is signed in with. No sign-in needed.',
    },
  ],
  [
    'google_drive',
    {
      kind: 'google_drive',
      label: 'Google Drive',
      name: 'Google Drive',
      hint: 'Sign in with Google. The app never sees your password.',
    },
  ],
  [
    'dropbox',
    {
      kind: 'dropbox',
      label: 'Dropbox',
      name: 'Dropbox',
      hint: 'Sign in with Dropbox. The app never sees your password.',
    },
  ],
  [
    'onedrive',
    {
      kind: 'onedrive',
      label: 'OneDrive',
      name: 'OneDrive',
      hint: 'Sign in with a personal Microsoft account. The app never sees your password.',
    },
  ],
  [
    'local_folder',
    {
      kind: 'local_folder',
      label: 'Local folder',
      name: 'a folder on this device',
      hint: 'Pick a folder that another app (for example a sync client) shares between devices.',
    },
  ],
]);

/** Display order of the alternatives, after the default. */
const ORDER: readonly AddDeviceProvider[] = [
  'icloud',
  'google_drive',
  'dropbox',
  'onedrive',
  'local_folder',
];

export type SyncPlatformFlags = Pick<
  PlatformServices,
  | 'googleOAuthConfigured'
  | 'dropboxConfigured'
  | 'getDropboxAuth'
  | 'oneDriveConfigured'
  | 'getOneDriveAuth'
  | 'iCloudSyncSupported'
  | 'createICloudTransport'
  | 'iCloudAvailableAtLaunch'
  | 'supportsLocalFolderSync'
>;

export function syncProviderInfo(kind: AddDeviceProvider): SyncProviderInfo {
  const info = PROVIDER_INFO.get(kind);
  if (!info) throw new Error(`Unknown sync provider: ${kind}`);
  return info;
}

export function isSyncProviderAvailable(
  platform: SyncPlatformFlags,
  kind: AddDeviceProvider,
): boolean {
  switch (kind) {
    case 'icloud':
      // The iOS app and the macOS desktop app.
      return platform.iCloudSyncSupported === true && platform.createICloudTransport !== undefined;
    case 'google_drive':
      return platform.googleOAuthConfigured;
    case 'dropbox':
      return platform.dropboxConfigured === true && platform.getDropboxAuth !== undefined;
    case 'onedrive':
      return platform.oneDriveConfigured === true && platform.getOneDriveAuth !== undefined;
    case 'local_folder':
      return platform.supportsLocalFolderSync;
  }
}

/** Every provider this device can use, in display order. */
export function availableSyncProviders(platform: SyncPlatformFlags): AddDeviceProvider[] {
  return ORDER.filter((kind) => isSyncProviderAvailable(platform, kind));
}

/**
 * The default: iCloud where this platform has an iCloud transport and it was not seen to be off at
 * launch (Apple devices; no sign-in),
 * otherwise Google Drive (Android, Windows, web, and Apple platforms without one). If neither is
 * configured in this build, the first other available provider.
 */
export function pickDefaultSyncProvider(
  platform: SyncPlatformFlags,
): AddDeviceProvider | undefined {
  // A Mac where iCloud was off at launch still lists iCloud, but not as the default.
  if (isSyncProviderAvailable(platform, 'icloud') && platform.iCloudAvailableAtLaunch !== false) {
    return 'icloud';
  }
  if (isSyncProviderAvailable(platform, 'google_drive')) return 'google_drive';
  return availableSyncProviders(platform)[0];
}

/** One line next to iCloud Drive on a Mac where it was off at launch. */
export const ICLOUD_OFF_HINT =
  'iCloud Drive looks off on this Mac. To use it, turn on iCloud Drive in System Settings (your Apple Account, then iCloud).';

/**
 * The hint for a Mac where iCloud Drive was off at launch: iCloud stays listed (it may be turned
 * on while the app runs), with this line saying how. `undefined` everywhere else, including Macs
 * whose build cannot use iCloud at all (unsigned builds never offer it).
 */
export function iCloudOffHint(platform: SyncPlatformFlags): string | undefined {
  return isSyncProviderAvailable(platform, 'icloud') && platform.iCloudAvailableAtLaunch === false
    ? ICLOUD_OFF_HINT
    : undefined;
}

export interface SyncMyDevicesPlan {
  /** What the main button connects (`undefined`: no provider is configured in this build). */
  primary: AddDeviceProvider | undefined;
  alternatives: AddDeviceProvider[];
  /** The provider an add-device link asked for, when this device cannot use it. */
  unavailableLinkProvider?: AddDeviceProvider;
}

/** The button's plan, with an add-device link's provider preselected when this device has it. */
export function planSyncMyDevices(
  platform: SyncPlatformFlags,
  link: AddDeviceLink | undefined,
): SyncMyDevicesPlan {
  const available = availableSyncProviders(platform);
  const linked = link?.provider;
  const linkUsable = linked !== undefined && available.includes(linked);
  const primary = linkUsable ? linked : pickDefaultSyncProvider(platform);
  const plan: SyncMyDevicesPlan = {
    primary,
    alternatives: available.filter((kind) => kind !== primary),
  };
  if (linked !== undefined && !linkUsable) plan.unavailableLinkProvider = linked;
  return plan;
}
