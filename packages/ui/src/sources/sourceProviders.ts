import type { PlatformServices } from '@flash/platform';

/**
 * Which linked-source providers this platform/build offers (§3), so the Sources panel lists only
 * what the user can actually link, and dev builds can say which env var a hidden provider needs.
 */
export type LinkedSourceProviderId = 'google' | 'onedrive' | 'dropbox' | 'local_folder';

export interface LinkedSourceProvider {
  id: LinkedSourceProviderId;
  /** Button-sized name. */
  name: string;
  /** Phrase for the panel description ("Pull updates from …"). */
  description: string;
  /** Phrase for the empty-list hint ("Link …"). */
  linkHint: string;
  /** The provider's button is shown and works on this platform/build. */
  available: boolean;
  /** Env var(s) that turn it on, for providers that are off only because the build lacks them. */
  envHint?: string;
}

type ProviderPlatform = Pick<
  PlatformServices,
  | 'googleOAuthConfigured'
  | 'googlePickerConfigured'
  | 'oneDriveConfigured'
  | 'getOneDrivePicker'
  | 'dropboxConfigured'
  | 'supportsLocalFolderSync'
>;

export function linkedSourceProviders(platform: ProviderPlatform): LinkedSourceProvider[] {
  return [
    {
      id: 'google',
      name: 'Google Drive',
      description: 'Google Drive (Sheets, Docs, and CSV/TSV/XLSX files)',
      linkHint: 'a Google Sheet, Doc or Drive file',
      available: platform.googleOAuthConfigured,
      envHint: 'VITE_GOOGLE_CLIENT_ID',
    },
    {
      id: 'onedrive',
      name: 'OneDrive',
      description: 'OneDrive spreadsheets',
      linkHint: 'a OneDrive spreadsheet',
      available: platform.oneDriveConfigured === true && platform.getOneDrivePicker !== undefined,
      envHint: 'VITE_MS_CLIENT_ID',
    },
    {
      id: 'dropbox',
      name: 'Dropbox',
      description: 'Dropbox files',
      linkHint: 'a Dropbox file',
      // Dropbox is not a linked source in this build yet; dev builds still say which key it needs.
      available: false,
      ...(platform.dropboxConfigured ? {} : { envHint: 'VITE_DROPBOX_APP_KEY' }),
    },
    {
      id: 'local_folder',
      name: 'Local folder',
      description: 'PC local folders (including Inbox/)',
      linkHint: 'a local PC folder',
      // A platform capability (File System Access / desktop shell), not a build setting.
      available: platform.supportsLocalFolderSync,
    },
  ];
}

function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, ${parts.at(-1) ?? ''}`;
}

/** "Pull updates from …" listing only the providers available here (URLs always work). */
export function linkedSourcesDescription(platform: ProviderPlatform): string {
  const parts = linkedSourceProviders(platform)
    .filter((p) => p.available)
    .map((p) => p.description);
  const providers = parts.length > 0 ? `${joinList(parts)}, or ` : '';
  return `Pull updates from ${providers}subscribed .flashpkg URLs. Everything stays cached offline.`;
}

/** The empty-list hint, naming only what can be linked here. */
export function emptyLinkedSourcesHint(platform: ProviderPlatform): string {
  const parts = linkedSourceProviders(platform)
    .filter((p) => p.available)
    .map((p) => p.linkHint);
  const linkPart = parts.length > 0 ? `Link ${joinList(parts)}, or subscribe` : 'Subscribe';
  return `No external sources linked yet. ${linkPart} to a Family Library URL above.`;
}

export interface UnconfiguredSourceHint {
  id: string;
  name: string;
  message: string;
}

/**
 * Dev builds only: providers hidden because this build lacks their env vars, so a missing
 * variable is obvious instead of silently hiding a button. Production builds get none.
 */
export function unconfiguredSourceHints(
  platform: ProviderPlatform & Pick<PlatformServices, 'isDevMode'>,
): UnconfiguredSourceHint[] {
  if (!platform.isDevMode) return [];
  const hints: UnconfiguredSourceHint[] = [];
  for (const p of linkedSourceProviders(platform)) {
    if (p.available || !p.envHint) continue;
    hints.push({
      id: p.id,
      name: p.name,
      message: `Not configured in this build (set ${p.envHint}).`,
    });
  }
  if (platform.googleOAuthConfigured && !platform.googlePickerConfigured) {
    hints.push({
      id: 'google-picker',
      name: 'Link from Google Drive',
      message:
        'Google Picker is not configured in this build (set VITE_GOOGLE_API_KEY; native shells also need VITE_PICKER_PAGE_URL).',
    });
  }
  return hints;
}
