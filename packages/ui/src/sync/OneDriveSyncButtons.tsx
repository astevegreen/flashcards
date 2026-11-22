import { canUseCloudSync } from '@flash/core/license';
import { useApp } from '../state/AppContext.tsx';

/**
 * Settings > Sync buttons for the OneDrive storage connector (§15 Phase 12). Rendered in the same
 * row as Google Drive / Dropbox / iCloud; visibility depends only on boot-time config and the sync
 * state, so the row never reflows after async work. The OneDrive code itself loads on click.
 */
export function OneDriveSyncButtons({
  busy,
  onError,
}: Readonly<{
  busy: boolean;
  onError: (message: string | null) => void;
}>) {
  const { platform, entitlement, syncState, connectOneDrive } = useApp();
  if (!platform.oneDriveConfigured) return null;

  const handleConnect = async () => {
    const gate = canUseCloudSync(entitlement);
    if (!gate.allowed) {
      onError(gate.reason ?? 'Cloud sync requires the one-time Unlock upgrade.');
      return;
    }
    onError(null);
    try {
      await connectOneDrive();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  if (syncState.provider !== 'onedrive') {
    return (
      <button
        type="button"
        data-testid="connect-onedrive-btn"
        disabled={busy}
        onClick={() => void handleConnect()}
        title="Sync privately via your OneDrive app folder"
        className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        Connect OneDrive
      </button>
    );
  }
  if (syncState.status !== 'reconnect_required') return null;
  return (
    <button
      type="button"
      data-testid="reconnect-onedrive-btn"
      disabled={busy}
      onClick={() => void handleConnect()}
      className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300"
    >
      Reconnect OneDrive
    </button>
  );
}
