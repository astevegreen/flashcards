import type { CollectionState, FlashEvent, SyncCursorState } from '@flash/core';
import type { DeviceMeta, PlatformServices, SyncConfig } from '@flash/platform';
import { lazy, Suspense, useState } from 'react';
import { AppShell, type NavTab } from './layout/AppShell.tsx';
import { StudyScreen } from './screens/StudyScreen.tsx';
import { AppProvider, useApp } from './state/AppContext.tsx';

// Lazy-load secondary screens so initial study-screen JS stays well under the 150 KB gzip budget (§8)
const LibraryScreen = lazy(() =>
  import('./screens/LibraryScreen.tsx').then((m) => ({ default: m.LibraryScreen })),
);
const BrowseScreen = lazy(() =>
  import('./screens/BrowseScreen.tsx').then((m) => ({ default: m.BrowseScreen })),
);
const StatsScreen = lazy(() =>
  import('./screens/StatsScreen.tsx').then((m) => ({ default: m.StatsScreen })),
);
const SettingsScreen = lazy(() =>
  import('./screens/SettingsScreen.tsx').then((m) => ({ default: m.SettingsScreen })),
);

function ScreenRouter() {
  const [activeTab, setActiveTab] = useState<NavTab>('study');
  const { setActiveDeckId, flushPendingSync } = useApp();

  const handleSelectTab = (nextTab: NavTab) => {
    if (activeTab === 'study' && nextTab !== 'study') {
      flushPendingSync();
    }
    setActiveTab(nextTab);
  };

  return (
    <AppShell activeTab={activeTab} onSelectTab={handleSelectTab}>
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
            />
          )}
          {activeTab === 'browse' && (
            <BrowseScreen onOpenSettings={() => handleSelectTab('settings')} />
          )}
          {activeTab === 'stats' && <StatsScreen />}
          {activeTab === 'settings' && <SettingsScreen />}
        </Suspense>
      )}
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
}

export function FlashcardsApp({
  platform,
  initialEvents,
  initialState,
  initialMeta,
  initialSyncConfig,
  initialSyncCursor,
  initialOAuthError,
}: FlashcardsAppProps) {
  return (
    <AppProvider
      platform={platform}
      initialMeta={initialMeta}
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
