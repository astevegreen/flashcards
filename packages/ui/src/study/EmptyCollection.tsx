import type { SampleDeckInfo } from '@flash/core/samples';
import type { Storage } from '@flash/platform';
import { use, useState } from 'react';
import { FirstRunOnboarding } from '../onboarding/FirstRunOnboarding.tsx';
import { onboardingRecordResource, saveOnboardingRecord } from '../onboarding/onboardingState.ts';

const SECONDARY_BUTTON_CLASS =
  'rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm font-semibold hover:bg-[var(--surface-2)]';
const PRIMARY_BUTTON_CLASS =
  'rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90';

/**
 * Empty collection screen (production zero-deck state). On a device that has never been
 * onboarded it also shows first-run onboarding (pick a language, then a starter deck) above the
 * other ways to start. The per-device onboarding record is read with `use()` inside the same
 * Suspense boundary as this lazily loaded screen, so the screen paints once, complete, and
 * nothing shifts under the pointer.
 */
export function EmptyCollection({
  storage,
  starterCatalogUrl,
  onOpenLibrary,
  onOpenSettings,
  onLoadSamples,
  onStartWithDeck,
}: {
  storage: Pick<Storage, 'getKv' | 'setKv'>;
  starterCatalogUrl: string | undefined;
  onOpenLibrary: () => void;
  onOpenSettings: (() => void) | undefined;
  onLoadSamples: () => void;
  /** Seeds the starter deck; rejects when it could not be loaded (onboarding stays open). */
  onStartWithDeck: (deck: SampleDeckInfo) => Promise<void>;
}) {
  const record = use(onboardingRecordResource(storage));
  const [onboardingOpen, setOnboardingOpen] = useState(record === undefined);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);

  const closeOnboarding = () => {
    if (!onboardingOpen) return;
    setOnboardingOpen(false);
    void saveOnboardingRecord(storage, { status: 'skipped', at: Date.now() });
  };

  // The device is marked onboarded only once the deck is in the collection: if the samples chunk
  // fails to load, the user stays in onboarding with an error and can retry.
  const startWithDeck = async (deck: SampleDeckInfo) => {
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
    <section className="flex flex-1 flex-col items-center justify-center gap-5 py-12 text-center">
      <div className="max-w-md space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Ready to Study Offline</h1>
        <p className="text-sm text-[var(--muted)]">
          {onboardingOpen
            ? 'Pick a language and a starter deck to see your first card. No sign-in needed.'
            : 'No decks are loaded on this device yet. Load the built-in Japanese, Mandarin, Korean + Hanja, and English sample decks, or import your own CSV / .flashpkg files.'}
        </p>
      </div>
      {onboardingOpen && (
        <FirstRunOnboarding
          onPickDeck={(deck) => void startWithDeck(deck)}
          onSkip={closeOnboarding}
          busy={starting}
          {...(startError === undefined ? {} : { error: startError })}
        />
      )}
      <div className="flex flex-wrap justify-center gap-3">
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
          onClick={() => {
            closeOnboarding();
            onLoadSamples();
          }}
          className={starterCatalogUrl ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS}
        >
          Load Sample Decks
        </button>
        <button type="button" onClick={onOpenLibrary} className={SECONDARY_BUTTON_CLASS}>
          Import CSV / .flashpkg
        </button>
        {onOpenSettings && (
          <button type="button" onClick={onOpenSettings} className={SECONDARY_BUTTON_CLASS}>
            Connect Cloud Sync
          </button>
        )}
      </div>
    </section>
  );
}
