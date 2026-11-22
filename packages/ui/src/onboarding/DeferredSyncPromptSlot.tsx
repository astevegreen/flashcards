import type { Storage, SyncProviderKind } from '@flash/platform';
import { lazy, Suspense, useState } from 'react';
import {
  isOnboardingRecordSettled,
  onboardingRecordResource,
  peekOnboardingRecord,
  saveOnboardingRecord,
  wantsSyncPrompt,
  type OnboardingRecord,
  type SyncPromptState,
} from './onboardingState.ts';
import { SyncPrompt } from './SyncPrompt.tsx';

type KvStore = Pick<Storage, 'getKv' | 'setKv'>;

// "Sync my devices" opens in place, below every study control (§8: its own chunk).
const LazySyncMyDevicesPanel = lazy(() =>
  import('../sync/SyncMyDevicesPanel.tsx').then((m) => ({ default: m.SyncMyDevicesPanel })),
);

/**
 * Starts this device's onboarding-record read. The study screen imports this module (lazily, §8)
 * and calls this when it MOUNTS, long before a session can finish, so the slot below can decide
 * synchronously, in the same render as the caught-up panel, whether the prompt shows.
 */
export async function preloadDeferredSyncPrompt(storage: KvStore): Promise<void> {
  await onboardingRecordResource(storage);
}

/**
 * Slot for the one-time "Sync my devices" prompt, under the "All caught up" panel and below every
 * study control. Offered once per device to anyone with cards and no sync provider (onboarded
 * here, skipped onboarding, or a collection from before onboarding), after a finished session.
 * It never appears after the panel has painted: it shows only if it was mounted while a card was
 * on screen (`caughtUp` false at mount), or if the study screen had this module ready when it
 * mounted (`readyAtScreenMount`); either way the prompt and the caught-up panel paint in the same
 * commit. Answering it ("Not now" / "Sync my devices") is user-initiated; "Sync my devices" opens
 * the Sync my devices panel right here.
 */
export function DeferredSyncPromptSlot({
  storage,
  provider,
  caughtUp,
  readyAtScreenMount,
  sessionReviewed,
  onOpenSettings,
}: Readonly<{
  storage: KvStore;
  provider: SyncProviderKind;
  /** True while the study screen shows the caught-up panel instead of a card. */
  caughtUp: boolean;
  readyAtScreenMount: boolean;
  /** True once a card was rated in this app session: "after the first session", not on reload. */
  sessionReviewed: boolean;
  onOpenSettings: (() => void) | undefined;
}>) {
  const [armed] = useState(() => readyAtScreenMount || !caughtUp);
  const [answered, setAnswered] = useState<OnboardingRecord | undefined>(undefined);
  const [panelOpen, setPanelOpen] = useState(false);
  const record = answered ?? peekOnboardingRecord(storage);
  // "No record" asks (a collection from before onboarding), so the read must have settled first:
  // otherwise a device that already answered could be asked again in a narrow race.
  const recordKnown = answered !== undefined || isOnboardingRecordSettled(storage);

  if (panelOpen) {
    return (
      <div className="flex shrink-0 justify-center">
        <Suspense fallback={<div className="h-64 w-full max-w-md" />}>
          <LazySyncMyDevicesPanel variant="panel" onOpenSettings={onOpenSettings} />
        </Suspense>
      </div>
    );
  }

  const visible =
    armed &&
    caughtUp &&
    sessionReviewed &&
    provider === 'none' &&
    recordKnown &&
    wantsSyncPrompt(record);
  if (!visible) return null;

  const answer = (syncPrompt: SyncPromptState) => {
    // A collection from before onboarding has no record yet: it counts as "skipped".
    const next: OnboardingRecord = {
      ...(record ?? { status: 'skipped', at: Date.now() }),
      syncPrompt,
    };
    setAnswered(next);
    void saveOnboardingRecord(storage, next);
  };

  return (
    <div className="shrink-0">
      <SyncPrompt
        onOpenSync={() => {
          answer('opened');
          setPanelOpen(true);
        }}
        onDismiss={() => answer('dismissed')}
      />
    </div>
  );
}
