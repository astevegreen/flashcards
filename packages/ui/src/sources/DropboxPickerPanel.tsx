import type { DropboxBrowseItem, PendingXlsxReconciliation } from '@flash/platform';
import { CloudFilePickerPanel, type CloudPickerProvider } from './CloudFilePickerPanel.tsx';
import { linkedDropboxDeck } from './dropboxLinkedDeck.ts';

const APP_FOLDER = <strong>Dropbox › Apps › Flashcards</strong>;

const DROPBOX: CloudPickerProvider<DropboxBrowseItem> = {
  key: 'dropbox',
  label: 'Dropbox',
  rootName: 'Dropbox App Folder',
  async open(platform) {
    if (!platform.getDropboxPicker) throw new Error('Dropbox is not available in this build.');
    const picker = await platform.getDropboxPicker();
    return {
      hasAccess: () => picker.isConnected(),
      requestAccess: () => picker.connect(),
      listFolder: (folderPath) => picker.listFolder(folderPath),
      downloadFile: (item) => picker.downloadFile(item),
    };
  },
  folderOf: (item) => item.pathLower,
  linkedDeck: linkedDropboxDeck,
  async link(item, ctx, choice) {
    const { linkDropboxFile } = await import('./sourceRunner.ts');
    return linkDropboxFile(
      { id: item.id, name: item.name, pathDisplay: item.pathDisplay },
      ctx,
      choice,
    );
  },
  intro: (
    <>
      Put spreadsheets (<code>.csv</code>, <code>.tsv</code>, <code>.xlsx</code>) or{' '}
      <code>.flashpkg</code> files in {APP_FOLDER}. App sync folders are hidden.
    </>
  ),
  accessText: (
    <>
      Connect Dropbox to browse your app folder. The app can only see its own {APP_FOLDER}{' '}
      folder—never the rest of your Dropbox. One sign-in works for both sync and linked files.
    </>
  ),
  accessButton: { label: 'Connect Dropbox', testId: 'dropbox-connect-btn' },
  emptyText: 'No folders or importable files here. Add files to Dropbox › Apps › Flashcards.',
};

/**
 * Dropbox App Folder file picker, lazy-loaded below the Sources action row. Browses
 * `Dropbox › Apps › Flashcards` (excluding internal sync folders) with the same Dropbox sign-in
 * as sync; see `CloudFilePickerPanel`.
 */
export default function DropboxPickerPanel(
  props: Readonly<{
    onStatusMessage: (msg: string) => void;
    onErrorMessage: (msg: string) => void;
    onClose: () => void;
    onPendingReconciliation?: (rec: PendingXlsxReconciliation) => void;
  }>,
) {
  return <CloudFilePickerPanel provider={DROPBOX} {...props} />;
}
