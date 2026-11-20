import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp, type SyncUiState } from '../state/AppContext.tsx';

export type NavTab = 'study' | 'library' | 'browse' | 'settings';

export interface AppShellProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  children: ReactNode;
}

const NAV_ITEMS: readonly { id: NavTab; label: string; icon: string }[] = [
  { id: 'study', label: 'Study', icon: '◫' },
  { id: 'library', label: 'Library', icon: '▤' },
  { id: 'browse', label: 'Browse', icon: '⌕' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

const PULL_REFRESH_THRESHOLD_PX = 64;

function getSidebarBadge(syncState: SyncUiState): { label: string; tone: string } {
  if (!syncState.isOnline && syncState.provider !== 'local_folder') {
    return { label: 'Offline', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
  }
  switch (syncState.status) {
    case 'syncing':
      return { label: 'Syncing…', tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' };
    case 'synced':
      return { label: 'Synced', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' };
    case 'offline':
      return { label: 'Offline', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
    case 'reconnect_required':
      return { label: 'Reconnect', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
    case 'upgrade_required':
      return { label: 'Read-only', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
    case 'error':
      return { label: 'Sync Error', tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' };
    case 'idle':
      return { label: 'Sync', tone: 'bg-[var(--surface-2)] text-[var(--muted)]' };
    case 'disconnected':
    default:
      return { label: 'Local', tone: 'bg-[var(--surface-2)] text-[var(--muted)]' };
  }
}

export function AppShell({ activeTab, onSelectTab, children }: AppShellProps) {
  const { platform, showBackupBanner, dismissBackupBanner, syncState, syncNow } = useApp();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const mainRef = useRef<HTMLElement | null>(null);
  const prevTabRef = useRef<NavTab>(activeTab);
  const pullStartYRef = useRef<number | null>(null);

  useEffect(() => {
    if (prevTabRef.current !== activeTab) {
      prevTabRef.current = activeTab;
      mainRef.current?.focus({ preventScroll: true });
    }
  }, [activeTab]);

  const badge = getSidebarBadge(syncState);

  const handleTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    if (syncState.provider === 'none') return;
    if (window.scrollY > 0) return;
    if (e.target instanceof Element && e.target.closest('[data-testid="study-card"]')) return;
    const touch = e.touches[0];
    if (!touch) return;
    pullStartYRef.current = touch.clientY;
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLElement>) => {
    const startY = pullStartYRef.current;
    if (startY === null) return;
    if (window.scrollY > 0) {
      pullStartYRef.current = null;
      setPullDistance(0);
      return;
    }
    const touch = e.touches[0];
    if (!touch) return;
    const dy = touch.clientY - startY;
    if (dy > 8) {
      setPullDistance(Math.min(dy, 96));
    } else {
      setPullDistance(0);
    }
  };

  const handleTouchEnd = () => {
    const triggered = pullDistance >= PULL_REFRESH_THRESHOLD_PX;
    pullStartYRef.current = null;
    setPullDistance(0);
    if (triggered && syncState.provider !== 'none') {
      void syncNow();
    }
  };

  const handleTouchCancel = () => {
    pullStartYRef.current = null;
    setPullDistance(0);
  };

  const handleBadgeClick = () => {
    if (
      syncState.provider === 'none' ||
      syncState.status === 'reconnect_required' ||
      syncState.status === 'upgrade_required' ||
      syncState.status === 'error'
    ) {
      onSelectTab('settings');
    } else {
      void syncNow();
    }
  };

  return (
    <div className="flex min-h-dvh w-full bg-[var(--bg)] text-[var(--fg)]">
      {/* Desktop collapsible left rail */}
      <aside
        aria-label="Primary navigation"
        className={`hidden shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-[width] duration-150 md:flex ${
          railCollapsed ? 'w-16' : 'w-56'
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-3.5">
          {!railCollapsed && (
            <span className="truncate text-base font-bold tracking-tight">Flashcards</span>
          )}
          <button
            type="button"
            onClick={() => setRailCollapsed((c) => !c)}
            aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded-lg p-1.5 text-sm text-[var(--muted)] hover:bg-[var(--surface-2)]"
          >
            {railCollapsed ? '»' : '«'}
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelectTab(item.id)}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]'
                }`}
              >
                <span aria-hidden="true" className="w-5 text-center text-base">
                  {item.icon}
                </span>
                {!railCollapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {!railCollapsed && (
          <div className="border-t border-[var(--border)] px-3 py-3 text-xs text-[var(--muted)]">
            <div className="flex items-center justify-between gap-1">
              <span className="truncate font-medium">{platform.deviceLabel}</span>
              <button
                type="button"
                data-testid="sidebar-sync-badge"
                onClick={handleBadgeClick}
                title={syncState.provider !== 'none' ? 'Sync now' : 'Configure sync in Settings'}
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${badge.tone}`}
              >
                {badge.label}
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Main viewport */}
      <div className="flex min-w-0 flex-1 flex-col">
        {showBackupBanner && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--accent-soft)] px-4 py-2 text-xs text-[var(--fg)]"
          >
            <span>Back up your collection regularly as a .flashpkg file.</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onSelectTab('settings')}
                className="rounded-md bg-[var(--accent)] px-2.5 py-1 font-semibold text-white"
              >
                Export Backup
              </button>
              <button
                type="button"
                onClick={() => void dismissBackupBanner()}
                className="rounded-md px-2 py-1 text-[var(--muted)] hover:bg-[var(--surface-2)]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {pullDistance > 16 && (
          <div role="status" className="py-1 text-center text-xs font-medium text-[var(--muted)]">
            {pullDistance >= PULL_REFRESH_THRESHOLD_PX ? 'Release to sync…' : 'Pull down to sync'}
          </div>
        )}

        <main
          ref={mainRef}
          tabIndex={-1}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-3 pb-20 pt-3 focus:outline-none sm:px-6 md:pb-6 md:pt-5"
        >
          {children}
        </main>
      </div>

      {/* Mobile bottom tab bar with safe-area inset */}
      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV_ITEMS.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelectTab(item.id)}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium ${
                active ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
              }`}
            >
              <span aria-hidden="true" className="text-base leading-none">
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
