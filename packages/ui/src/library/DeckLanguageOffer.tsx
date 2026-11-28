import { deckLanguageOfferEvents, normalizeLanguage, type Deck } from '@flash/core';
import { useApp } from '../state/AppContext.tsx';

// A Map: a tag from an imported file such as `constructor` must not find an Object.prototype member.
const LANGUAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ['en', 'English'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh-Hans', 'Chinese'],
]);

let displayNames: Intl.DisplayNames | undefined;

/** A readable name for a language tag: `en-US` reads English; an empty tag reads "no language". */
function languageName(language: string): string {
  const known = LANGUAGE_NAMES.get(normalizeLanguage(language));
  if (known) return known;
  const tag = language.trim();
  if (tag === '') return 'no language';
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
    return displayNames.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** What the Library remembers after the user took an offer, so it can show Undo. */
export interface DeckLanguageChange {
  deckId: string;
  from: string;
  to: string;
}

/**
 * The one-time offer on a Library deck row (`decks/language-offer.ts`): set a Sentence, Cloze or
 * Grammar deck's language to the one its text is written in. Either answer writes events, so the
 * offer never shows again for that deck. After a change, the row shows Undo until it is closed.
 * Not in the initial bundle: `LibraryScreen` imports it statically, so it ships in the Library
 * screen's own lazy chunk (a separate chunk would add a name to the entry's preload map).
 */
export default function DeckLanguageOffer({
  deck,
  offer,
  change,
  onChanged,
  onClose,
}: Readonly<{
  deck: Deck;
  /** The detected language, while the offer stands. */
  offer?: string | undefined;
  /** The change just made to this deck, while Undo is shown. */
  change?: DeckLanguageChange | undefined;
  onChanged: (change: DeckLanguageChange) => void;
  onClose: () => void;
}>) {
  const { emitEvents, getEventFactory } = useApp();
  const buttonClass =
    'rounded-lg border border-[var(--border)] px-2.5 py-1 font-medium hover:bg-[var(--surface-2)]';

  if (change) {
    return (
      <output
        data-testid={`deck-language-changed-${deck.id}`}
        className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs"
      >
        <span className="flex-1">
          Language set to {languageName(change.to)}. Audio and type now follow it.
        </span>
        <button
          type="button"
          data-testid={`deck-language-undo-${deck.id}`}
          className={buttonClass}
          onClick={() => {
            const factory = getEventFactory();
            emitEvents([
              factory.create(
                'DeckSettingsChanged',
                { deck_id: deck.id, language: change.from },
                Date.now(),
              ),
            ]);
            onClose();
          }}
        >
          Undo
        </button>
        <button type="button" className={buttonClass} onClick={onClose}>
          Close
        </button>
      </output>
    );
  }
  if (!offer) return null;

  const answer = (accepted: boolean) => {
    // Read before emitting: applying the events updates the deck in place.
    const from = deck.language;
    emitEvents(deckLanguageOfferEvents(getEventFactory(), deck.id, offer, accepted, Date.now()));
    if (accepted) onChanged({ deckId: deck.id, from, to: offer });
  };
  return (
    <div
      data-testid={`deck-language-offer-${deck.id}`}
      className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs"
    >
      <span className="flex-1">
        This deck&apos;s text looks {languageName(offer)}, but its language is{' '}
        {languageName(deck.language)}, so its audio speaks {languageName(deck.language)}. Set it to{' '}
        {languageName(offer)}?
      </span>
      <button
        type="button"
        data-testid={`deck-language-accept-${deck.id}`}
        className="rounded-lg bg-[var(--accent)] px-2.5 py-1 font-semibold text-white hover:opacity-90"
        onClick={() => answer(true)}
      >
        Set to {languageName(offer)}
      </button>
      <button
        type="button"
        data-testid={`deck-language-dismiss-${deck.id}`}
        className={buttonClass}
        onClick={() => answer(false)}
      >
        Keep {languageName(deck.language)}
      </button>
    </div>
  );
}
