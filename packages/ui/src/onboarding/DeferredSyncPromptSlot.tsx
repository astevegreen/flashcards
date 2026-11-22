import type { Storage, SyncProviderKind } from '@flash/platform';
import { useState } from 'react';
import {
  onboardingRecordResource,
  peekOnboardingRecord,
  saveOnboardingRecord,
  wantsSyncPrompt,
  type OnboardingRecord,
  type SyncPromptState,
} from './onboardingState.ts';
import { SyncPrompt } from './SyncPrompt.tsx';

type KvStore = Pick<Storage, 'getKv' | 'setKv'>;

/**
 * Starts this device's onboarding-record read. The study screen imports this module (lazily, §8)
 * and calls this when it MOUNTS, long before a session can finish, so the slot below can decide
 * synchronously, in the same render as the caught-up panel, whether the prompt shows.
 */
export async function preloadDeferredSyncPrompt(storage: KvStore): Promise<void> {
  await onboardingRecordResource(storage);
}

/**
 * Slot for the deferred onboarding sync prompt, under the "All caught up" panel and below every
 * study control. It never appears after the panel has painted: it shows only if it was mounted
 * while a card was on screen (`caughtUp` false at mount), or if the study screen had this module
 * ready when it mounted (`readyAtScreenMount`); either way the prompt and the caught-up panel
 * paint in the same commit. Answering it ("Not now" / "Sync my devices") is user-initiated.
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
  const record = answered ?? peekOnboardingRecord(storage);

  const visible =
    armed && caughtUp && sessionReviewed && provider === 'none' && wantsSyncPrompt(record);
  if (!visible || !record || !onOpenSettings) return null;

  const answer = (syncPrompt: SyncPromptState) => {
    const next: OnboardingRecord = { ...record, syncPrompt };
    setAnswered(next);
    void saveOnboardingRecord(storage, next);
  };

  return (
    <div className="shrink-0">
      <SyncPrompt
        onOpenSync={() => {
          answer('opened');
          onOpenSettings();
        }}
        onDismiss={() => answer('dismissed')}
      />
    </div>
  );
}
