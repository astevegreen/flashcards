import type { SyncProviderKind } from '@flash/platform';

const PROVIDER_LABELS: Readonly<Record<Exclude<SyncProviderKind, 'local_folder'>, string>> = {
  none: 'Not Connected',
  dev_channel: 'Dev Channel (Local Tabs)',
  google_drive: 'Google Drive (App Data)',
  dropbox: 'Dropbox (App Folder)',
  onedrive: 'OneDrive (App Folder)',
  icloud: 'iCloud Drive',
};

/** Settings label for the active sync storage connector. */
export function describeSyncProvider(provider: SyncProviderKind, localFolderName?: string): string {
  if (provider === 'local_folder') return `Local Folder (${localFolderName ?? 'Selected folder'})`;
  return PROVIDER_LABELS[provider];
}
