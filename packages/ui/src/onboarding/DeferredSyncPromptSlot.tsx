import type { Storage, SyncProviderKind } from '@flash/platform';
import { useEffect, useState, type ComponentType } from 'react';
import {
  onboardingRecordResource,
  saveOnboardingRecord,
  wantsSyncPrompt,
  type OnboardingRecord,
  type SyncPromptState,
} from './onboardingState.ts';
import type { SyncPrompt as SyncPromptComponent } from './SyncPrompt.tsx';

type SyncPromptProps = Parameters<typeof SyncPromptComponent>[0];

/**
 * Slot for the deferred onboarding sync prompt under the "All caught up" panel. The per-device
 * record is read on mount and the prompt module is imported (lazily, §8) as soon as the record
 * says it is wanted, long before a first session can finish, so the prompt paints together with
 * the caught-up panel. Its height is reserved, and it sits below every study control.
 */
export function DeferredSyncPromptSlot({
  storage,
  provider,
  sessionReviewed,
  onOpenSettings,
}: Readonly<{
  storage: Pick<Storage, 'getKv' | 'setKv'>;
  provider: SyncProviderKind;
  /** True once a card was rated in this app session: "after the first session", not on reload. */
  sessionReviewed: boolean;
  onOpenSettings: (() => void) | undefined;
}>) {
  const [record, setRecord] = useState<OnboardingRecord | undefined>(undefined);
  const [Prompt, setPrompt] = useState<ComponentType<SyncPromptProps> | null>(null);

  useEffect(() => {
    let live = true;
    void onboardingRecordResource(storage).then((loaded) => {
      if (!live || !wantsSyncPrompt(loaded)) return;
      setRecord(loaded);
      void import('./SyncPrompt.tsx').then((m) => {
        if (live) setPrompt(() => m.SyncPrompt);
      });
    });
    return () => {
      live = false;
    };
  }, [storage]);

  const visible =
    wantsSyncPrompt(record) && provider === 'none' && sessionReviewed && onOpenSettings;
  if (!visible || !record) return null;

  const answer = (syncPrompt: SyncPromptState) => {
    const next: OnboardingRecord = { ...record, syncPrompt };
    setRecord(next);
    void saveOnboardingRecord(storage, next);
  };

  return (
    <div className="min-h-[4.5rem] shrink-0">
      {Prompt && (
        <Prompt
          onOpenSync={() => {
            answer('opened');
            onOpenSettings();
          }}
          onDismiss={() => answer('dismissed')}
        />
      )}
    </div>
  );
}
