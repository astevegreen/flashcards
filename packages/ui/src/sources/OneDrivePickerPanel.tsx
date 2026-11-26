import type { OneDriveBrowseItem, PendingXlsxReconciliation } from '@flash/platform';
import { CloudFilePickerPanel, type CloudPickerProvider } from './CloudFilePickerPanel.tsx';

const ONEDRIVE: CloudPickerProvider<OneDriveBrowseItem> = {
  key: 'onedrive',
  label: 'OneDrive',
  rootName: 'OneDrive',
  async open(platform) {
    if (!platform.getOneDrivePicker) throw new Error('OneDrive is not available in this build.');
    const picker = await platform.getOneDrivePicker();
    return {
      hasAccess: () => picker.hasFileAccess(),
      requestAccess: () => picker.requestFileAccess(),
      listFolder: (folderId) => picker.listFolder(folderId),
      downloadFile: (item) => picker.downloadFile(item),
    };
  },
  folderOf: (item) => item.id,
  sourceKind: 'onedrive_file',
  async link(item, ctx, choice) {
    const { linkOneDriveFile } = await import('./sourceRunner.ts');
    return linkOneDriveFile({ id: item.id, name: item.name }, ctx, choice);
  },
  accessText:
    "Sync only sees the app's own OneDrive folder. To pick a file, allow read-only access to your OneDrive files once.",
  accessButton: { label: 'Allow OneDrive file access', testId: 'onedrive-grant-access-btn' },
  emptyText: 'No folders or importable files here.',
};

/**
 * Optional OneDrive file picker (§15 Phase 12), lazy-loaded below the Sources action row. Browses
 * the user's OneDrive (read-only `Files.Read`, asked for only here); see `CloudFilePickerPanel`.
 */
export default function OneDrivePickerPanel(
  props: Readonly<{
    onStatusMessage: (msg: string) => void;
    onErrorMessage: (msg: string) => void;
    onClose: () => void;
    onPendingReconciliation?: (rec: PendingXlsxReconciliation) => void;
  }>,
) {
  return <CloudFilePickerPanel provider={ONEDRIVE} {...props} />;
}
