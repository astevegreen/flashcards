import {
  DECK_DESCRIPTION_MAX_LENGTH,
  getDeckDescription,
  normalizeDeckDescription,
  type Deck,
  type StudyCounts,
} from '@flash/core';
import { useEffect, useId, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';

/**
 * Deck descriptions: plain text only. React renders it as a text node (never HTML, §13), and
 * `whitespace-pre-line` keeps the author's line breaks.
 */

/** The overview shown before study when a deck has a description. */
export function DeckOverview({
  deck,
  description,
  counts,
  onStart,
  onClose,
}: Readonly<{
  deck: Deck;
  description: string;
  counts: Pick<StudyCounts, 'new' | 'learning' | 'due'>;
  onStart: () => void;
  onClose: () => void;
}>) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`deck-overview-${deck.id}`}
      className="mt-3 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        About this deck
      </h3>
      <p
        data-testid={`deck-overview-text-${deck.id}`}
        className="text-sm whitespace-pre-line break-words text-[var(--fg)]"
      >
        {description}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--muted)]">
          Today: {counts.new} new · {counts.learning} learning · {counts.due} due
        </span>
        <button
          type="button"
          data-testid={`deck-overview-start-${deck.id}`}
          onClick={onStart}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-semibold text-white hover:opacity-90"
        >
          Start studying
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 font-medium hover:bg-[var(--surface-2)]"
        >
          Close
        </button>
      </div>
    </section>
  );
}

/** Deck options field: edits the description, saved on blur as one `DeckDescriptionChanged`. */
export function DeckDescriptionField({ deck }: Readonly<{ deck: Deck }>) {
  const { state, emitEvents, getEventFactory } = useApp();
  const stored = getDeckDescription(state, deck.id);
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  const commit = () => {
    const next = normalizeDeckDescription(draft);
    setDraft(next);
    if (next === stored) return;
    emitEvents([
      getEventFactory().create(
        'DeckDescriptionChanged',
        { deck_id: deck.id, description: next },
        Date.now(),
      ),
    ]);
  };
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[var(--muted)]">
        Description (plain text, shown before you study this deck)
      </span>
      <textarea
        aria-label="Deck description"
        data-testid={`deck-description-input-${deck.id}`}
        rows={3}
        maxLength={DECK_DESCRIPTION_MAX_LENGTH}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
      />
    </label>
  );
}
