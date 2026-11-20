import {
  buildStudyQueue,
  formatIntervalLabel,
  previewIntervals,
  resolveDeckFsrsConfig,
  type Note,
  type ReviewRating,
} from '@flash/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NoteEditDialog } from '../components/NoteEditDialog.tsx';
import { RichText } from '../components/RichText.tsx';
import { useApp } from '../state/AppContext.tsx';

export interface StudyScreenProps {
  onOpenLibrary: () => void;
}

interface SwipeState {
  dx: number;
  dy: number;
  active: boolean;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.closest('dialog[open]')) return true;
  return false;
}

export function StudyScreen({ onOpenLibrary }: StudyScreenProps) {
  const {
    state,
    stateVersion,
    activeDeckId,
    setActiveDeckId,
    undoStack,
    rateCard,
    undoLastReview,
    updateNote,
    loadSampleDecks,
  } = useApp();

  const [revealStep, setRevealStep] = useState(0);
  const [furiganaOverride, setFuriganaOverride] = useState<boolean | null>(null);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [swipe, setSwipe] = useState<SwipeState>({ dx: 0, dy: 0, active: false });
  const [clockTick, setClockTick] = useState(0);

  const pointerStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const cardShownAtRef = useRef<number>(Date.now());

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const nowMs = Date.now();
  const tzOffsetMinutes = -new Date(nowMs).getTimezoneOffset();

  const queueResult = useMemo(
    () =>
      buildStudyQueue(state, {
        ...(activeDeckId !== undefined ? { deckId: activeDeckId } : {}),
        nowMs,
        tzOffsetMinutes,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, activeDeckId, clockTick],
  );

  // Auto-wake queue when an intraday learning/relearning card becomes due
  const nextLearningDueAt = queueResult.nextLearningDueAt;
  useEffect(() => {
    if (queueResult.queue.length > 0 || nextLearningDueAt === undefined) return;
    const delayMs = Math.max(250, Math.min(nextLearningDueAt - Date.now() + 100, 60_000));
    const timer = window.setTimeout(() => setClockTick((t) => t + 1), delayMs);
    return () => window.clearTimeout(timer);
  }, [queueResult.queue.length, nextLearningDueAt, clockTick]);

  const currentCard = queueResult.queue[0];
  const currentNote = currentCard ? state.notes.get(currentCard.note_id) : undefined;
  const currentDeck = currentCard ? state.decks.get(currentCard.deck_id) : undefined;
  const currentLayout = currentCard ? state.layouts.get(currentCard.layout_id) : undefined;
  const currentNoteType = currentDeck ? state.noteTypes.get(currentDeck.note_type_id) : undefined;

  const fieldMetaByKey = useMemo(() => {
    const map = new Map<string, { label: string; lang: string; kind: string }>();
    if (currentNoteType) {
      for (const f of currentNoteType.fields) {
        map.set(f.key, { label: f.label, lang: f.lang, kind: f.kind });
      }
    }
    return map;
  }, [currentNoteType]);

  // Only include reveal steps that contain at least one non-empty field on the current note
  const populatedRevealSteps = useMemo(() => {
    if (!currentLayout || !currentNote) return [];
    const steps = currentLayout.reveal_steps
      .map((stepKeys) =>
        stepKeys.filter((key) => {
          const val = currentNote.fields[key];
          return val !== undefined && val.trim().length > 0;
        }),
      )
      .filter((stepKeys) => stepKeys.length > 0);
    return steps.length > 0 ? steps : [currentLayout.reveal_steps[0] ?? []];
  }, [currentLayout, currentNote]);

  const totalRevealSteps = populatedRevealSteps.length;
  const isRevealed = revealStep > 0;
  const isFullyRevealed = revealStep >= totalRevealSteps;

  // Reset local card reveal state whenever the active card changes
  useEffect(() => {
    setRevealStep(0);
    setFuriganaOverride(null);
    setSwipe({ dx: 0, dy: 0, active: false });
    cardShownAtRef.current = Date.now();
  }, [currentCard?.id]);

  const hideFrontRuby =
    furiganaOverride !== null
      ? furiganaOverride
      : !isRevealed && Boolean(currentLayout?.hide_furigana_on_front);

  const intervals = useMemo(() => {
    if (!currentCard || !isRevealed) return null;
    const cfg = resolveDeckFsrsConfig(state, currentCard.deck_id, nowMs);
    return previewIntervals(currentCard.schedule, nowMs, cfg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCard, isRevealed, state, stateVersion]);

  const ratingMode = state.preferences.rating_button_mode;

  const handleRevealNext = useCallback(() => {
    if (!currentCard) return;
    setRevealStep((prev) => Math.min(totalRevealSteps, prev + 1));
  }, [currentCard, totalRevealSteps]);

  const handleRate = useCallback(
    (rating: ReviewRating) => {
      if (!currentCard || !isRevealed) return;
      const elapsed = Date.now() - cardShownAtRef.current;
      setRevealStep(0);
      setFuriganaOverride(null);
      cardShownAtRef.current = Date.now();
      rateCard(currentCard, rating, elapsed);
    },
    [currentCard, isRevealed, rateCard],
  );

  const handleUndo = useCallback(() => {
    if (undoLastReview()) {
      setRevealStep(0);
      setFuriganaOverride(null);
      cardShownAtRef.current = Date.now();
    }
  }, [undoLastReview]);

  const handleToggleFurigana = useCallback(() => {
    setFuriganaOverride((prev) => {
      const current = prev !== null ? prev : hideFrontRuby;
      return !current;
    });
  }, [hideFrontRuby]);

  // Desktop keyboard shortcuts (§5.1)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (editingNote !== null) return;
      if (isEditableTarget(e.target)) return;

      const key = e.key;

      if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (key === ' ' || key === 'Enter') {
        // Don't hijack Space/Enter when focus is on a button or link (avoids double activation)
        if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) {
          return;
        }
        if (!isFullyRevealed) {
          e.preventDefault();
          handleRevealNext();
        }
        return;
      }

      if (key.toLowerCase() === 'f') {
        e.preventDefault();
        handleToggleFurigana();
        return;
      }

      if (key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
        return;
      }

      if (key.toLowerCase() === 'e' && currentNote) {
        e.preventDefault();
        setEditingNote(currentNote);
        return;
      }

      if (!isRevealed) return;

      if (key === '1' || key === 'ArrowLeft') {
        e.preventDefault();
        handleRate(1);
      } else if (key === '2' || key === 'ArrowRight') {
        e.preventDefault();
        handleRate(3);
      } else if ((key === '3' || key === 'ArrowUp') && ratingMode !== '2') {
        e.preventDefault();
        handleRate(4);
      } else if ((key === '4' || key === 'ArrowDown') && ratingMode === '4') {
        e.preventDefault();
        handleRate(2);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    currentNote,
    editingNote,
    handleRate,
    handleRevealNext,
    handleToggleFurigana,
    handleUndo,
    isFullyRevealed,
    isRevealed,
    ratingMode,
  ]);

  // Mobile Pointer Events swipe gestures
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.pointerType !== 'mouse') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unavailable (e.g. synthetic events)
      }
    }
    pointerStartRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    setSwipe({ dx: 0, dy: 0, active: true });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start || start.id !== e.pointerId) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    setSwipe({ dx, dy, active: true });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start || start.id !== e.pointerId) return;
    pointerStartRef.current = null;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    setSwipe({ dx: 0, dy: 0, active: false });

    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (isRevealed) {
      if (absX >= 72 && absX > absY) {
        if (dx < 0) {
          handleRate(1); // Swipe left -> Again
        } else {
          handleRate(3); // Swipe right -> Good
        }
        return;
      }
      if (dy <= -80 && absY > absX && ratingMode !== '2') {
        handleRate(4); // Swipe up -> Easy
        return;
      }
    }

    // Small tap advances reveal
    if (absX < 12 && absY < 12 && !isFullyRevealed) {
      handleRevealNext();
    }
  };

  const handlePointerCancel = () => {
    pointerStartRef.current = null;
    setSwipe({ dx: 0, dy: 0, active: false });
  };

  const swipeIntent = useMemo(() => {
    if (!swipe.active || !isRevealed) return null;
    const absX = Math.abs(swipe.dx);
    const absY = Math.abs(swipe.dy);
    if (absX >= 48 && absX > absY) {
      return swipe.dx < 0 ? 'again' : 'good';
    }
    if (swipe.dy <= -56 && absY > absX && ratingMode !== '2') {
      return 'easy';
    }
    return null;
  }, [isRevealed, ratingMode, swipe]);

  // Empty collection onboarding (production zero-deck state)
  if (decks.length === 0) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-5 py-12 text-center">
        <div className="max-w-md space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Ready to Study Offline</h1>
          <p className="text-sm text-[var(--muted)]">
            No decks are loaded on this device yet. Load the built-in Japanese, Mandarin, Korean +
            Hanja, and English sample decks, or import your own CSV / .flashpkg files.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={loadSampleDecks}
            className="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90"
          >
            Load Sample Decks
          </button>
          <button
            type="button"
            onClick={onOpenLibrary}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm font-semibold hover:bg-[var(--surface-2)]"
          >
            Import CSV / .flashpkg
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col gap-4">
      {/* Top study header: Deck selector + Due counts + Quick actions */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <select
            aria-label="Select deck to study"
            value={activeDeckId ?? ''}
            onChange={(e) => {
              setActiveDeckId(e.target.value || undefined);
              e.currentTarget.blur();
            }}
            className="max-w-[14rem] truncate rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none sm:max-w-xs"
          >
            <option value="">All Decks</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>

          <div
            aria-label="Due card counts"
            className="flex items-center gap-1.5 text-xs font-semibold tabular-nums"
          >
            <span
              title="New cards"
              data-testid="count-new"
              className="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-600 dark:text-sky-400"
            >
              {queueResult.counts.new}
            </span>
            <span
              title="Learning cards"
              data-testid="count-learning"
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400"
            >
              {queueResult.counts.learning}
            </span>
            <span
              title="Due review cards"
              data-testid="count-due"
              className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-600 dark:text-emerald-400"
            >
              {queueResult.counts.due}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleToggleFurigana}
            title="Toggle furigana / reading hints (F)"
            aria-pressed={!hideFrontRuby}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              !hideFrontRuby
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]'
            }`}
          >
            {hideFrontRuby ? 'Ruby Off' : 'Ruby On'}
          </button>

          <button
            type="button"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="Undo last review (Z)"
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--fg)] hover:bg-[var(--surface-2)] disabled:opacity-40"
          >
            Undo
          </button>

          {currentNote && (
            <button
              type="button"
              onClick={() => setEditingNote(currentNote)}
              title="Edit note (E)"
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--fg)] hover:bg-[var(--surface-2)]"
            >
              Edit
            </button>
          )}
        </div>
      </header>

      {/* Main Card Surface or Caught-Up State */}
      {!currentCard || !currentNote || !currentLayout || !currentDeck ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <h2 className="text-xl font-bold">
            {nextLearningDueAt !== undefined
              ? 'Learning card coming up'
              : 'All caught up for today!'}
          </h2>
          <p className="max-w-sm text-sm text-[var(--muted)]">
            {nextLearningDueAt !== undefined
              ? `Next learning card is due in ${formatIntervalLabel(nextLearningDueAt, nowMs)}. It will appear automatically.`
              : queueResult.buriedNoteIds.size > 0
                ? `${queueResult.buriedNoteIds.size} sibling card(s) are buried until tomorrow's study day.`
                : 'You have finished all scheduled cards in this selection.'}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {activeDeckId && (
              <button
                type="button"
                onClick={() => setActiveDeckId(undefined)}
                className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white"
              >
                Study All Decks
              </button>
            )}
            <button
              type="button"
              onClick={onOpenLibrary}
              className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium hover:bg-[var(--surface-2)]"
            >
              Open Library
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col justify-between gap-4">
          {/* Swipeable / tappable card */}
          <div
            data-testid="study-card"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            style={{
              touchAction: 'pan-y',
              transform:
                swipe.active && isRevealed
                  ? `translate3d(${Math.max(-90, Math.min(90, swipe.dx * 0.45))}px, ${Math.max(-50, Math.min(20, swipe.dy * 0.35))}px, 0)`
                  : undefined,
            }}
            className={`relative flex min-h-[20rem] flex-1 cursor-pointer select-none flex-col items-center justify-center gap-6 rounded-3xl border bg-[var(--surface)] p-6 text-center shadow-sm transition-transform duration-100 sm:p-10 ${
              swipeIntent === 'again'
                ? 'border-rose-500 ring-2 ring-rose-500/30'
                : swipeIntent === 'good'
                  ? 'border-emerald-500 ring-2 ring-emerald-500/30'
                  : swipeIntent === 'easy'
                    ? 'border-sky-500 ring-2 ring-sky-500/30'
                    : 'border-[var(--border)]'
            }`}
          >
            {/* Subtle deck & layout pill */}
            <div className="absolute left-4 top-4 flex items-center gap-2 text-xs text-[var(--muted)]">
              <span className="truncate font-medium">{currentDeck.name}</span>
              <span>·</span>
              <span className="rounded-md bg-[var(--surface-2)] px-1.5 py-0.5">
                {currentLayout.name}
              </span>
            </div>

            {swipeIntent && (
              <div className="pointer-events-none absolute right-4 top-4 rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs font-bold uppercase tracking-wider">
                {swipeIntent}
              </div>
            )}

            {/* Front fields */}
            <div className="flex w-full max-w-2xl flex-col items-center gap-3 pt-4">
              {currentLayout.front_fields.map((fieldKey, idx) => {
                const value = currentNote.fields[fieldKey];
                if (!value) return null;
                const meta = fieldMetaByKey.get(fieldKey);
                const lang = meta?.lang ?? currentDeck.language;
                return (
                  <div
                    key={fieldKey}
                    data-testid={`front-field-${fieldKey}`}
                    className={
                      idx === 0
                        ? 'whitespace-pre-wrap text-3xl font-semibold leading-snug tracking-tight sm:text-5xl'
                        : 'whitespace-pre-wrap text-lg text-[var(--muted)] sm:text-xl'
                    }
                  >
                    <RichText
                      text={value}
                      lang={lang}
                      hideRuby={hideFrontRuby}
                      pinyinToneColors={state.preferences.pinyin_tone_colors}
                    />
                  </div>
                );
              })}
            </div>

            {/* Revealed steps */}
            {isRevealed && (
              <div
                data-testid="card-back"
                className="flex w-full max-w-2xl flex-col items-center gap-4 border-t border-[var(--border)] pt-6"
              >
                {populatedRevealSteps.slice(0, revealStep).map((stepKeys, stepIdx) => (
                  <div key={stepIdx} className="flex w-full flex-col items-center gap-2">
                    {stepKeys.map((fieldKey) => {
                      const value = currentNote.fields[fieldKey];
                      if (!value) return null;
                      const meta = fieldMetaByKey.get(fieldKey);
                      const lang = meta?.lang ?? currentDeck.language;
                      const isPrimaryBack =
                        stepIdx === 0 &&
                        (fieldKey === 'meaning' ||
                          fieldKey === 'word' ||
                          fieldKey === 'translation' ||
                          fieldKey === 'explanation');
                      return (
                        <div
                          key={fieldKey}
                          data-testid={`back-field-${fieldKey}`}
                          className={
                            isPrimaryBack
                              ? 'whitespace-pre-wrap text-xl font-medium sm:text-2xl'
                              : fieldKey === 'reading' ||
                                  fieldKey === 'hanja' ||
                                  fieldKey === 'eumhun'
                                ? 'whitespace-pre-wrap text-lg text-[var(--accent)] sm:text-xl'
                                : 'whitespace-pre-wrap text-sm text-[var(--muted)] sm:text-base'
                          }
                        >
                          <RichText
                            text={value}
                            lang={lang}
                            hideRuby={false}
                            pinyinToneColors={state.preferences.pinyin_tone_colors}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))}

                {currentNote.tags.length > 0 && isFullyRevealed && (
                  <div className="flex flex-wrap justify-center gap-1.5 pt-2">
                    {currentNote.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-xs text-[var(--muted)]"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!isFullyRevealed && (
              <p className="mt-2 text-xs text-[var(--muted)]">
                {isRevealed ? 'Tap or press Space for more' : 'Tap card or press Space to reveal'}
              </p>
            )}
          </div>

          {/* Bottom action bar */}
          <div className="flex flex-col gap-2">
            {!isRevealed ? (
              <button
                type="button"
                data-testid="reveal-button"
                onClick={handleRevealNext}
                className="w-full rounded-2xl bg-[var(--accent)] py-3.5 text-base font-semibold text-white shadow-sm hover:opacity-90 active:scale-[0.99]"
              >
                Show Answer <span className="ml-1 text-xs opacity-80">(Space)</span>
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                {!isFullyRevealed && (
                  <button
                    type="button"
                    onClick={handleRevealNext}
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] py-2 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)]"
                  >
                    Reveal more ({revealStep}/{totalRevealSteps}) · Space
                  </button>
                )}

                <div
                  className={`grid gap-2 ${
                    ratingMode === '2'
                      ? 'grid-cols-2'
                      : ratingMode === '4'
                        ? 'grid-cols-4'
                        : 'grid-cols-3'
                  }`}
                >
                  <button
                    type="button"
                    data-testid="rate-again"
                    onClick={() => handleRate(1)}
                    className="flex flex-col items-center rounded-2xl border border-rose-500/30 bg-rose-500/10 py-3 text-rose-600 transition-colors hover:bg-rose-500/20 active:scale-[0.98] dark:text-rose-400"
                  >
                    <span className="text-sm font-bold">Again</span>
                    <span className="text-xs opacity-80">{intervals?.[1].label ?? ''} · 1</span>
                  </button>

                  {ratingMode === '4' && (
                    <button
                      type="button"
                      data-testid="rate-hard"
                      onClick={() => handleRate(2)}
                      className="flex flex-col items-center rounded-2xl border border-amber-500/30 bg-amber-500/10 py-3 text-amber-600 transition-colors hover:bg-amber-500/20 active:scale-[0.98] dark:text-amber-400"
                    >
                      <span className="text-sm font-bold">Hard</span>
                      <span className="text-xs opacity-80">{intervals?.[2].label ?? ''} · 4</span>
                    </button>
                  )}

                  <button
                    type="button"
                    data-testid="rate-good"
                    onClick={() => handleRate(3)}
                    className="flex flex-col items-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10 py-3 text-emerald-600 transition-colors hover:bg-emerald-500/20 active:scale-[0.98] dark:text-emerald-400"
                  >
                    <span className="text-sm font-bold">Good</span>
                    <span className="text-xs opacity-80">{intervals?.[3].label ?? ''} · 2</span>
                  </button>

                  {ratingMode !== '2' && (
                    <button
                      type="button"
                      data-testid="rate-easy"
                      onClick={() => handleRate(4)}
                      className="flex flex-col items-center rounded-2xl border border-sky-500/30 bg-sky-500/10 py-3 text-sky-600 transition-colors hover:bg-sky-500/20 active:scale-[0.98] dark:text-sky-400"
                    >
                      <span className="text-sm font-bold">Easy</span>
                      <span className="text-xs opacity-80">{intervals?.[4].label ?? ''} · 3</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <NoteEditDialog
        note={editingNote}
        noteType={
          editingNote
            ? state.noteTypes.get(state.decks.get(editingNote.deck_id)?.note_type_id ?? '')
            : undefined
        }
        onSave={(note, fields, tags) => updateNote(note, fields, tags)}
        onClose={() => setEditingNote(null)}
      />
    </section>
  );
}
