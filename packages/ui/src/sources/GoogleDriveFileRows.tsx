import type { LinkedGoogleDriveFileSource, SourceSyncStatus } from '@flash/platform';
import type { ReactNode } from 'react';

const DRIVE_LINK_HOSTS = new Set(['drive.google.com', 'docs.google.com']);

/**
 * True for an `https://drive.google.com/…` or `https://docs.google.com/…` link. Parsed with
 * `URL` rather than prefix checks (§11), so userinfo, ports and look-alike hosts are refused.
 */
export function isSafeDriveUrl(uri?: string): boolean {
  if (!uri) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    DRIVE_LINK_HOSTS.has(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * Rows for linked Google Drive files in the Sources panel. The panel passes its own status-pill
 * helpers and warnings disclosure so these rows look exactly like the OneDrive rows.
 */
export function GoogleDriveFileRows({
  sources,
  busy,
  onRefresh,
  onUnlink,
  pillLabel,
  pillClass,
  renderWarnings,
}: Readonly<{
  sources: readonly LinkedGoogleDriveFileSource[];
  busy: boolean;
  onRefresh: (src: LinkedGoogleDriveFileSource) => void;
  onUnlink: (src: LinkedGoogleDriveFileSource) => void;
  pillLabel: (src: {
    lastStatus?: SourceSyncStatus;
    skipReason?: 'archived' | 'unreadable';
  }) => string;
  pillClass: (src: {
    lastStatus?: SourceSyncStatus;
    skipReason?: 'archived' | 'unreadable';
  }) => string;
  renderWarnings: (src: LinkedGoogleDriveFileSource) => ReactNode;
}>) {
  return (
    <>
      {sources.map((src) => (
        <div
          key={src.id}
          data-testid={`gdrive-source-row-${src.fileId}`}
          className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)]">
                  {src.format === 'flashpkg' ? 'Drive package' : 'Google Drive file'}
                </span>
                <span className="truncate text-xs font-semibold">{src.name}</span>
                {src.format === 'flashpkg' && src.version && (
                  <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                    v{src.version}
                  </span>
                )}
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                  Read-only
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${pillClass(src)}`}
                >
                  {pillLabel(src)}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-[var(--muted)]">
                Last synced:{' '}
                {src.lastSyncedAt ? new Date(src.lastSyncedAt).toLocaleString() : 'Never'}
              </div>
              {src.lastError && (
                <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                  {src.lastError}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {isSafeDriveUrl(src.uri) && (
                <a
                  href={src.uri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--surface-2)]"
                >
                  Open ↗
                </a>
              )}
              <button
                type="button"
                data-testid={`gdrive-refresh-${src.fileId}`}
                disabled={busy}
                onClick={() => onRefresh(src)}
                className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
              >
                Refresh
              </button>
              <button
                type="button"
                data-testid={`gdrive-unlink-${src.fileId}`}
                disabled={busy}
                onClick={() => onUnlink(src)}
                className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-rose-600"
              >
                Unlink
              </button>
            </div>
          </div>
          {renderWarnings(src)}
        </div>
      ))}
    </>
  );
}
