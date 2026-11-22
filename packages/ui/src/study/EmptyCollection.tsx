import type { Storage } from '@flash/platform';
import { use, useState } from 'react';
import { FirstRunOnboarding } from '../onboarding/FirstRunOnboarding.tsx';
import { onboardingRecordResource, saveOnboardingRecord } from '../onboarding/onboardingState.ts';
import type { OnboardingDeckInfo } from '../onboarding/starterDecks.ts';
import { AddDeviceCollectionNotice } from '../sync/AddDeviceCollectionNotice.tsx';
import { SyncMyDevicesPanel } from '../sync/SyncMyDevicesPanel.tsx';

const SECONDARY_BUTTON_CLASS =
  'min-h-11 min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm font-semibold break-words hover:bg-[var(--surface-2)]';
const PRIMARY_BUTTON_CLASS =
  'min-h-11 min-w-0 rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold break-words text-white shadow-sm hover:opacity-90';

type View = 'onboarding' | 'sync' | 'none';

const INTRO: Readonly<Record<View, string>> = {
  onboarding: 'Pick a language and a starter deck to see your first card. No sign-in needed.',
  sync: 'Connect the service your other device syncs with, and your cards arrive here.',
  none: 'No decks are on this device yet. Bring your own cards, or sync with your other devices.',
};

/**
 * Empty collection screen (production zero-deck state). A device that has never been onboarded
 * and has no decks at all gets first-run onboarding (pick a language, then a starter deck); a
 * device opened with an add-device link gets "Sync my devices" with that provider instead. Below
 * them: "Bring my cards" (the Library's import) and "I already use this app: sync my devices".
 * The per-device onboarding record is read with `use()` inside the same Suspense boundary as this
 * lazily loaded screen, so the screen paints once, complete, and nothing shifts under the pointer.
 */
export function EmptyCollection({
  storage,
  starterCatalogUrl,
  collectionEmpty,
  openedFromAddDeviceLink,
  onOpenLibrary,
  onOpenSettings,
  onStartWithDeck,
}: Readonly<{
  storage: Pick<Storage, 'getKv' | 'setKv'>;
  starterCatalogUrl: string | undefined;
  /** No decks at all (archived ones included): only then is onboarding offered. */
  collectionEmpty: boolean;
  /** This page load came from another device's add-device QR code or link. */
  openedFromAddDeviceLink: boolean;
  onOpenLibrary: () => void;
  onOpenSettings: (() => void) | undefined;
  /** Seeds the starter deck; rejects when it could not be loaded (onboarding stays open). */
  onStartWithDeck: (deck: OnboardingDeckInfo) => Promise<void>;
}>) {
  const record = use(onboardingRecordResource(storage));
  const [onboardingOffered, setOnboardingOffered] = useState(
    record === undefined && collectionEmpty,
  );
  const [syncOpen, setSyncOpen] = useState(openedFromAddDeviceLink);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);

  let view: View = 'none';
  if (syncOpen) view = 'sync';
  else if (onboardingOffered) view = 'onboarding';

  const skipOnboarding = () => {
    if (!onboardingOffered) return;
    setOnboardingOffered(false);
    void saveOnboardingRecord(storage, { status: 'skipped', at: Date.now() });
  };

  // The device is marked onboarded only once the deck is in the collection: if the deck chunk
  // fails to load, the user stays in onboarding with an error and can retry.
  const startWithDeck = async (deck: OnboardingDeckInfo) => {
    if (starting) return;
    setStarting(true);
    setStartError(undefined);
    try {
      await onStartWithDeck(deck);
    } catch {
      setStarting(false);
      setStartError('Could not load that deck. Check your connection and try again.');
      return;
    }
    await saveOnboardingRecord(storage, {
      status: 'completed',
      at: Date.now(),
      language: deck.language,
      deckSlug: deck.slug,
      syncPrompt: 'pending',
    });
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 py-12 text-center">
      <div className="max-w-md min-w-0 space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Ready to Study Offline</h1>
        <p className="text-sm break-words text-[var(--muted)]">{INTRO[view]}</p>
      </div>
      {view !== 'none' && (
        // One reserved slot for both, so switching between them keeps the buttons below in place.
        <div className="flex min-h-[22rem] w-full max-w-md min-w-0 justify-center">
          {view === 'onboarding' ? (
            <FirstRunOnboarding
              onPickDeck={(deck) => void startWithDeck(deck)}
              onSkip={skipOnboarding}
              busy={starting}
              {...(startError === undefined ? {} : { error: startError })}
            />
          ) : (
            <SyncMyDevicesPanel variant="panel" fromEmptyScreen onOpenSettings={onOpenSettings} />
          )}
        </div>
      )}
      <div className="flex w-full max-w-md min-w-0 flex-wrap justify-center gap-3">
        {starterCatalogUrl && (
          <button
            type="button"
            data-testid="empty-browse-starter-decks-btn"
            onClick={onOpenLibrary}
            className={PRIMARY_BUTTON_CLASS}
          >
            Browse Starter Decks
          </button>
        )}
        <button
          type="button"
          data-testid="empty-bring-my-cards-btn"
          onClick={onOpenLibrary}
          className={SECONDARY_BUTTON_CLASS}
        >
          Bring my cards
        </button>
        <button
          type="button"
          data-testid="empty-sync-my-devices-btn"
          aria-expanded={syncOpen}
          onClick={() => setSyncOpen((open) => !open)}
          className={SECONDARY_BUTTON_CLASS}
        >
          I already use this app: sync my devices
        </button>
      </div>
      <div className="w-full max-w-md min-w-0">
        <AddDeviceCollectionNotice />
      </div>
    </section>
  );
}
