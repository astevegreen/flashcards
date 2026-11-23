import type { Storage } from '@flash/platform';
import { use, useState } from 'react';
import {
  isJoiningCollection,
  isSyncStalled,
  planEmptyCollection,
  syncsWithRealProvider,
} from '../onboarding/emptyCollectionPlan.ts';
import { FirstRunOnboarding } from '../onboarding/FirstRunOnboarding.tsx';
import { onboardingRecordResource, saveOnboardingRecord } from '../onboarding/onboardingState.ts';
import type { OnboardingDeckInfo } from '../onboarding/starterDecks.ts';
import { useApp } from '../state/AppContext.tsx';
import { AddDeviceCollectionNotice } from '../sync/AddDeviceCollectionNotice.tsx';
import {
  addDeviceExpectationResource,
  clearAddDeviceExpectation,
} from '../sync/addDeviceExpectation.ts';
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
 * and has no decks at all gets first-run onboarding (pick a language, then a starter deck). A
 * device that is joining an existing collection (opened with an add-device link, or back from the
 * sign-in redirect with its first sync still to land) gets "Sync my devices" instead and is never
 * offered onboarding meanwhile (`planEmptyCollection`). Below them: "Bring my cards" (the
 * Library's import) and "I already use this app: sync my devices". The per-device onboarding
 * record and any stored add-device link are read with `use()` inside the same Suspense boundary
 * as this lazily loaded screen, so it paints once, complete, and only the user's own taps switch
 * between the views (nothing swaps under the pointer when a sync lands).
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
  storage: Pick<Storage, 'getKv' | 'setKv' | 'deleteKv'>;
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
  const storedLink = use(addDeviceExpectationResource(storage));
  const { syncState, meta } = useApp();
  const [linkPending, setLinkPending] = useState(storedLink !== undefined);
  const [joinGivenUp, setJoinGivenUp] = useState(false);
  const plan = planEmptyCollection({
    record,
    collectionEmpty,
    syncProvider: syncState.provider,
    collectionId: meta?.collectionId,
    openedFromAddDeviceLink,
    addDeviceLinkPending: linkPending,
    joinGivenUp,
  });
  const [skipped, setSkipped] = useState(false);
  const [syncOpen, setSyncOpen] = useState(plan.syncOpen);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const onboardingOffered = plan.offerOnboarding && !skipped;

  let view: View = 'none';
  if (syncOpen) view = 'sync';
  else if (onboardingOffered) view = 'onboarding';

  const skipOnboarding = () => {
    if (!onboardingOffered) return;
    setSkipped(true);
    void saveOnboardingRecord(storage, { status: 'skipped', at: Date.now() });
  };

  const forgetLink = () => {
    setLinkPending(false);
    void clearAddDeviceExpectation(storage);
  };

  // Closing "Sync my devices" before this device syncs anywhere turns away from the add-device
  // link it was opened with: the link is forgotten, so this is an ordinary new device again.
  // Closing it while this device's first sync is stuck (it needs a reconnect, or failed) lets the
  // user start here instead: onboarding is offered from this tap on (see `planEmptyCollection`).
  const toggleSync = () => {
    const turningAway = syncOpen && !syncsWithRealProvider(syncState.provider);
    if (turningAway && (linkPending || openedFromAddDeviceLink)) forgetLink();
    const stuck =
      (isJoiningCollection(syncState.provider, meta?.collectionId) || linkPending) &&
      isSyncStalled(syncState.status);
    if (syncOpen && stuck) setJoinGivenUp(true);
    setSyncOpen(!syncOpen);
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

  const onboardingErrorProps = startError === undefined ? {} : { error: startError };

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
              {...onboardingErrorProps}
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
          onClick={toggleSync}
          className={SECONDARY_BUTTON_CLASS}
        >
          I already use this app: sync my devices
        </button>
      </div>
      <div className="w-full max-w-md min-w-0">
        <AddDeviceCollectionNotice onDismiss={forgetLink} />
      </div>
    </section>
  );
}
