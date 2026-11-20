import type { FlashEvent } from '@flash/core';
import type { DeviceMeta, PlatformServices } from '@flash/platform';
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
const SettingsScreen = lazy(() =>
  import('./screens/SettingsScreen.tsx').then((m) => ({ default: m.SettingsScreen })),
);

function ScreenRouter() {
  const [activeTab, setActiveTab] = useState<NavTab>('study');
  const { setActiveDeckId } = useApp();

  return (
    <AppShell activeTab={activeTab} onSelectTab={setActiveTab}>
      {activeTab === 'study' && <StudyScreen onOpenLibrary={() => setActiveTab('library')} />}
      {activeTab !== 'study' && (
        <Suspense
          fallback={<div className="py-12 text-center text-sm text-[var(--muted)]">Loading…</div>}
        >
          {activeTab === 'library' && (
            <LibraryScreen
              onStudyDeck={(deckId) => {
                setActiveDeckId(deckId);
                setActiveTab('study');
              }}
            />
          )}
          {activeTab === 'browse' && <BrowseScreen />}
          {activeTab === 'settings' && <SettingsScreen />}
        </Suspense>
      )}
    </AppShell>
  );
}

export interface FlashcardsAppProps {
  platform: PlatformServices;
  initialEvents: readonly FlashEvent[];
  initialMeta: DeviceMeta;
}

export function FlashcardsApp({ platform, initialEvents, initialMeta }: FlashcardsAppProps) {
  return (
    <AppProvider platform={platform} initialEvents={initialEvents} initialMeta={initialMeta}>
      <ScreenRouter />
    </AppProvider>
  );
}
