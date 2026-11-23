import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { SECURE_KEYS_LOST_MESSAGE } from '../state/secureKeysNotice.ts';
import { applyCardTextSize, readCardTextSize } from '../study/cardTextSize.ts';
import { getSidebarBadge, sidebarBadgeOpensSettings, sidebarBadgeTitle } from './sidebarBadge.ts';

// Phase 13 study reminders (native notifications / PWA badge): lazy, renders nothing.
const LazyReminderRuntime = lazy(() =>
  import('../reminders/ReminderRuntime.tsx').then((m) => ({ default: m.ReminderRuntime })),
);

/**
 * Pull-to-refresh only starts at the top of the content under the finger: the touch target or
 * any scroll container around it (the study `main`, the Browse list, the page) scrolled down
 * means the pull is a scroll, not a refresh.
 */
function isScrolledFromTop(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
  }
  return false;
}

/** Due-count badge on the Study tab (PWA reminders). */
function StudyBadge({ count, position }: Readonly<{ count: number; position: string }>) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="study-reminder-badge"
      className={`pointer-events-none absolute min-w-4 rounded-full bg-rose-600 px-1 text-center text-[10px] font-bold leading-4 text-white ${position}`}
    >
      {count > 99 ? '99+' : count}
      <span className="sr-only"> cards due</span>
    </span>
  );
}

/** Applies the device-local card text size before the first paint (idempotent DOM attribute). */
function initCardTextSize(): boolean {
  applyCardTextSize(readCardTextSize());
  return true;
}

export type NavTab = 'study' | 'library' | 'browse' | 'stats' | 'settings';

export interface AppShellProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  children: ReactNode;
}

const NAV_ITEMS: readonly { id: NavTab; label: string; icon: string }[] = [
  { id: 'study', label: 'Study', icon: '◫' },
  { id: 'library', label: 'Library', icon: '▤' },
  { id: 'browse', label: 'Browse', icon: '⌕' },
  { id: 'stats', label: 'Stats', icon: '▥' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

const PULL_REFRESH_THRESHOLD_PX = 64;

export function AppShell({ activeTab, onSelectTab, children }: AppShellProps) {
  const {
    platform,
    showBackupBanner,
    dismissBackupBanner,
    secureKeysLostNotice,
    dismissSecureKeysLostNotice,
    syncState,
    syncNow,
  } = useApp();
  useState(initCardTextSize);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const mainRef = useRef<HTMLElement | null>(null);
  const prevTabRef = useRef<NavTab>(activeTab);
  const pullStartYRef = useRef<number | null>(null);
  const pullTargetRef = useRef<EventTarget | null>(null);
  const [studyBadgeCount, setStudyBadgeCount] = useState(0);

  useEffect(() => {
    if (prevTabRef.current !== activeTab) {
      prevTabRef.current = activeTab;
      mainRef.current?.focus({ preventScroll: true });
    }
  }, [activeTab]);

  const badge = getSidebarBadge(syncState);

  const handleTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    if (syncState.provider === 'none') return;
    if (isScrolledFromTop(e.target)) return;
    if (e.target instanceof Element && e.target.closest('[data-testid="study-card"]')) return;
    const touch = e.touches[0];
    if (!touch) return;
    pullStartYRef.current = touch.clientY;
    pullTargetRef.current = e.target;
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLElement>) => {
    const startY = pullStartYRef.current;
    if (startY === null) return;
    if (isScrolledFromTop(pullTargetRef.current)) {
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
    if (sidebarBadgeOpensSettings(syncState)) {
      onSelectTab('settings');
    } else {
      void syncNow();
    }
  };

  const isStudy = activeTab === 'study';
  // Large monitors (>= 1440 px): wider content for Library and Browse / Dictionary (§15 Phase 13).
  const isWideTab = activeTab === 'library' || activeTab === 'browse';

  return (
    <div
      data-tab={activeTab}
      className={`flex w-full bg-[var(--bg)] text-[var(--fg)] ${
        // Study always fits the viewport: the shell is exactly one screen tall and never scrolls.
        isStudy ? 'h-dvh overflow-hidden' : 'min-h-dvh'
      }`}
      style={{
        // viewport-fit=cover: keep content clear of notches / rounded corners on every edge
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      {/* Desktop collapsible left rail; in short landscape windows a slim icon rail replaces the bottom tabs */}
      <aside
        aria-label="Primary navigation"
        className={`touch-scope hidden shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-[width] duration-150 md:flex short:flex short:w-16 ${
          railCollapsed ? 'w-16' : 'w-56'
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-3.5 short:hidden">
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

        <nav className="flex flex-1 flex-col gap-1 p-2 short:justify-center">
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                title={railCollapsed ? item.label : undefined}
                onClick={() => onSelectTab(item.id)}
                className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors short:justify-center short:px-0 ${
                  active
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]'
                }`}
              >
                <span aria-hidden="true" className="w-5 text-center text-base">
                  {item.icon}
                </span>
                {/* Icon-only rail keeps the label for assistive tech */}
                <span className={railCollapsed ? 'sr-only' : 'short:sr-only'}>{item.label}</span>
                {item.id === 'study' && (
                  <StudyBadge count={studyBadgeCount} position="right-1 top-1" />
                )}
              </button>
            );
          })}
        </nav>

        {/* Device + sync badge; in short landscape windows only the badge, stacked in the slim rail */}
        <div
          className={`border-t border-[var(--border)] px-3 py-3 text-xs text-[var(--muted)] short:block short:px-1 short:py-2 ${
            railCollapsed ? 'hidden' : ''
          }`}
        >
          <div className="flex items-center justify-between gap-1 short:justify-center">
            <span className="truncate font-medium short:hidden">{platform.deviceLabel}</span>
            <button
              type="button"
              data-testid="sidebar-sync-badge"
              onClick={handleBadgeClick}
              title={sidebarBadgeTitle(syncState)}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase short:w-full short:whitespace-normal short:px-0.5 short:leading-tight ${badge.tone}`}
            >
              {badge.label}
            </button>
          </div>
        </div>
      </aside>

      {/* Main viewport */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {secureKeysLostNotice && (
          <div
            role="alert"
            data-testid="secure-keys-lost-notice"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--accent-soft)] px-4 py-2 text-xs text-[var(--fg)]"
          >
            <span className="min-w-0 flex-1 basis-48 break-words">{SECURE_KEYS_LOST_MESSAGE}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  dismissSecureKeysLostNotice();
                  onSelectTab('settings');
                }}
                className="min-h-11 rounded-md bg-[var(--accent)] px-2.5 py-1 font-semibold text-white"
              >
                Sign in again
              </button>
              <button
                type="button"
                data-testid="secure-keys-lost-dismiss"
                onClick={dismissSecureKeysLostNotice}
                className="min-h-11 rounded-md px-2 py-1 text-[var(--muted)] hover:bg-[var(--surface-2)]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

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
          data-tab={activeTab}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          className={`mx-auto flex w-full max-w-4xl flex-1 flex-col px-3 pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+0.75rem)] pt-3 focus:outline-none tiny:px-2 sm:px-6 md:pb-6 md:pt-5 short:pb-2 short:pt-2 ${
            isStudy
              ? // Fits the viewport; only an open inline panel (e.g. a filter) can scroll, inside main.
                'touch-scope min-h-0 overflow-y-auto'
              : isWideTab
                ? 'min-[1440px]:max-w-6xl'
                : ''
          }`}
        >
          {children}
        </main>
      </div>

      <Suspense fallback={null}>
        <LazyReminderRuntime onBadgeChange={setStudyBadgeCount} />
      </Suspense>

      {/* Mobile bottom tab bar with safe-area inset (icon-only below 360 px; replaced by the rail in short windows) */}
      <nav
        aria-label="Mobile navigation"
        className="touch-scope fixed inset-x-0 bottom-0 z-20 flex border-t border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur md:hidden short:hidden"
        style={{
          paddingBottom: 'env(safe-area-inset-bottom)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
        {NAV_ITEMS.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelectTab(item.id)}
              className={`relative flex h-[var(--tabbar-h)] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium ${
                active ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
              }`}
            >
              <span aria-hidden="true" className="text-base leading-none tiny:text-xl">
                {item.icon}
              </span>
              <span className="tiny:sr-only">{item.label}</span>
              {item.id === 'study' && (
                <StudyBadge count={studyBadgeCount} position="left-1/2 top-1 ml-2" />
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
