import type { CollectionState, FlashEvent, SyncCursorState } from '@flash/core';
import type { DeviceMeta, PlatformServices, SyncConfig } from '@flash/platform';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { LazyErrorBoundary, lazyWithRetry } from './lazy/lazyWithRetry.tsx';
import { AppShell, type NavTab } from './layout/AppShell.tsx';
import { StudyScreen } from './screens/StudyScreen.tsx';
import { AppProvider, useApp } from './state/AppContext.tsx';

// Lazy-load secondary screens so initial study-screen JS stays well under the 160 KB gzip budget (§8)
const LibraryScreen = lazyWithRetry(() =>
  import('./screens/LibraryScreen.tsx').then((m) => ({ default: m.LibraryScreen })),
);
const BrowseScreen = lazyWithRetry(() =>
  import('./screens/BrowseScreen.tsx').then((m) => ({ default: m.BrowseScreen })),
);
const StatsScreen = lazyWithRetry(() =>
  import('./screens/StatsScreen.tsx').then((m) => ({ default: m.StatsScreen })),
);
const SettingsScreen = lazyWithRetry(() =>
  import('./screens/SettingsScreen.tsx').then((m) => ({ default: m.SettingsScreen })),
);

function ScreenRouter() {
  const [activeTab, setActiveTab] = useState<NavTab>('study');
  const [browseDeckRequest, setBrowseDeckRequest] = useState<
    { deckId: string; nonce: number } | undefined
  >(undefined);
  const [libraryImportExportRequest, setLibraryImportExportRequest] = useState<
    { tab: 'import' | 'export'; nonce: number } | undefined
  >(undefined);
  const { platform, setActiveDeckId, flushPendingSync } = useApp();

  const handleSelectTab = useCallback(
    (nextTab: NavTab) => {
      if (activeTab === 'study' && nextTab !== 'study') {
        flushPendingSync();
      }
      setActiveTab(nextTab);
    },
    [activeTab, flushPendingSync],
  );

  // Android hardware/gesture Back button (backButton.ts, lazy: only phones have one).
  const backTabRef = useRef({ activeTab, handleSelectTab });
  backTabRef.current = { activeTab, handleSelectTab };
  useEffect(() => {
    const onBackButton = platform.onBackButton;
    if (!onBackButton) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void import('./layout/backButton.ts').then(({ createBackButtonHandler, domBackButtonDeps }) => {
      if (cancelled) return;
      const handle = createBackButtonHandler(
        domBackButtonDeps(
          () => backTabRef.current.activeTab === 'study',
          () => backTabRef.current.handleSelectTab('study'),
        ),
      );
      unsubscribe = onBackButton(handle);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [platform]);

  return (
    <AppShell activeTab={activeTab} onSelectTab={handleSelectTab}>
      {/* A screen that throws shows Retry under the tab bar instead of blanking the app (C2). */}
      <LazyErrorBoundary key={activeTab}>
        {activeTab === 'study' && (
          <StudyScreen
            onOpenLibrary={() => handleSelectTab('library')}
            onOpenSettings={() => handleSelectTab('settings')}
          />
        )}
        {activeTab !== 'study' && (
          <Suspense
            fallback={<div className="py-12 text-center text-sm text-[var(--muted)]">Loading…</div>}
          >
            {activeTab === 'library' && (
              <LibraryScreen
                onStudyDeck={(deckId) => {
                  setActiveDeckId(deckId);
                  handleSelectTab('study');
                }}
                onViewWords={(deckId) => {
                  setBrowseDeckRequest((prev) => ({ deckId, nonce: (prev?.nonce ?? 0) + 1 }));
                  handleSelectTab('browse');
                }}
                {...(libraryImportExportRequest !== undefined
                  ? { initialImportExport: libraryImportExportRequest }
                  : {})}
              />
            )}
            {activeTab === 'browse' && (
              <BrowseScreen
                onOpenSettings={() => handleSelectTab('settings')}
                {...(browseDeckRequest !== undefined
                  ? {
                      initialDeckId: browseDeckRequest.deckId,
                      initialDeckNonce: browseDeckRequest.nonce,
                    }
                  : {})}
              />
            )}
            {activeTab === 'stats' && <StatsScreen />}
            {activeTab === 'settings' && (
              <SettingsScreen
                onOpenImportExport={() => {
                  setLibraryImportExportRequest((prev) => ({
                    tab: 'export',
                    nonce: (prev?.nonce ?? 0) + 1,
                  }));
                  handleSelectTab('library');
                }}
              />
            )}
          </Suspense>
        )}
      </LazyErrorBoundary>
    </AppShell>
  );
}

export interface FlashcardsAppProps {
  platform: PlatformServices;
  initialEvents?: readonly FlashEvent[];
  initialState?: CollectionState;
  initialMeta: DeviceMeta;
  initialSyncConfig?: SyncConfig;
  initialSyncCursor?: SyncCursorState;
  initialOAuthError?: string;
  /** Receives `whenSaved` (the persist queue drained), for handing the writer lock to another tab. */
  exposeWhenSaved?: ((whenSaved: () => Promise<void>) => void) | undefined;
}

export function FlashcardsApp({
  platform,
  initialEvents,
  initialState,
  initialMeta,
  initialSyncConfig,
  initialSyncCursor,
  initialOAuthError,
  exposeWhenSaved,
}: FlashcardsAppProps) {
  return (
    <AppProvider
      platform={platform}
      initialMeta={initialMeta}
      exposeWhenSaved={exposeWhenSaved}
      {...(initialEvents !== undefined ? { initialEvents } : {})}
      {...(initialState !== undefined ? { initialState } : {})}
      {...(initialSyncConfig !== undefined ? { initialSyncConfig } : {})}
      {...(initialSyncCursor !== undefined ? { initialSyncCursor } : {})}
      {...(initialOAuthError !== undefined ? { initialOAuthError } : {})}
    >
      <ScreenRouter />
    </AppProvider>
  );
}
