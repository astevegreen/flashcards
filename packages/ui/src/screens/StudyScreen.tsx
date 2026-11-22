import {
  buildStudyQueue,
  formatIntervalLabel,
  getStudyDayIndex,
  previewIntervals,
  resolveCardAudioTarget,
  resolveDayStartHour,
  resolveDeckFsrsConfig,
  resolveLayoutSpeakTiming,
  type Note,
  type ReviewRating,
} from '@flash/core';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { getAnswerMode } from '../study/answerModes/registry.ts';
import type { AnswerEvaluation, FieldMeta } from '../study/answerModes/types.ts';
import {
  isStudyFilterInScope,
  resolveStudyQueueDeckId,
  setStudyFilter,
  useStudyFilter,
} from '../study/filterStore.ts';
import { RatingBar } from '../study/RatingBar.tsx';
import { StudyCard } from '../study/StudyCard.tsx';

const LazyNoteEditDialog = lazy(() =>
  import('../components/NoteEditDialog.tsx').then((m) => ({ default: m.NoteEditDialog })),
);
// Phase 9 "Study this filter" panel is off the critical path (§8).
const LazyStudyFilterPanel = lazy(() =>
  import('../study/StudyFilterPanel.tsx').then((m) => ({ default: m.StudyFilterPanel })),
);

export interface StudyScreenProps {
  onOpenLibrary: () => void;
  onOpenSettings?: () => void;
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

function isInteractiveControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('button, a, input, textarea, select, label'));
}

export function StudyScreen({ onOpenLibrary, onOpenSettings }: StudyScreenProps) {
  const {
    platform,
    state,
    stateVersion,
    activeDeckId,
    setActiveDeckId,
    undoStack,
    audio,
    rateCard,
    undoLastReview,
    updateNote,
    markNoteReviewed,
    loadSampleDecks,
  } = useApp();

  const [revealStep, setRevealStep] = useState(0);
  const [furiganaOverride, setFuriganaOverride] = useState<boolean | null>(null);
  const [evaluation, setEvaluation] = useState<AnswerEvaluation | null>(null);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [swipe, setSwipe] = useState<SwipeState>({ dx: 0, dy: 0, active: false });
  const [clockTick, setClockTick] = useState(0);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const storedStudyFilter = useStudyFilter();
  // A filter only applies to the deck selection it was started under and while its decks exist;
  // switching deck elsewhere (Library "Study", archive) or resetting the collection drops it.
  const studyFilter =
    storedStudyFilter && isStudyFilterInScope(storedStudyFilter, activeDeckId, state.decks)
      ? storedStudyFilter
      : undefined;
  useEffect(() => {
    if (storedStudyFilter && !studyFilter) setStudyFilter(undefined);
  }, [storedStudyFilter, studyFilter]);

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

  // A filter naming its own decks (e.g. a Study Set saved under another deck) runs on those decks.
  const queueDeckId = resolveStudyQueueDeckId(studyFilter, activeDeckId);
  const queueResult = useMemo(
    () =>
      studyFilter?.session
        ? studyFilter.session.buildQueue(state, { deckId: queueDeckId, nowMs, tzOffsetMinutes })
        : buildStudyQueue(state, {
            ...(queueDeckId !== undefined ? { deckId: queueDeckId } : {}),
            ...(studyFilter !== undefined ? { filter: studyFilter.filter } : {}),
            nowMs,
            tzOffsetMinutes,
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, queueDeckId, studyFilter, clockTick],
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

  const currentAudioTarget = useMemo(() => {
    if (!currentNote || !currentLayout || !currentDeck) return undefined;
    return resolveCardAudioTarget(currentNote, currentLayout, currentNoteType, currentDeck);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDeck, currentLayout, currentNote, currentNoteType, stateVersion]);

  const currentSpeakTiming = currentLayout ? resolveLayoutSpeakTiming(currentLayout) : 'manual';

  const {
    preloadCards: preloadAudioCards,
    stop: stopAudio,
    unlock: unlockAudio,
    speakCard: speakAudioCard,
    ttsConfig,
  } = audio;

  // 2–3 card RAM lookahead preloader (§7.2): warms current + next 3 cards into ObjectURLs
  const lookaheadSignature = queueResult.queue
    .slice(0, 4)
    .map((c) => c.id)
    .join(',');
  useEffect(() => {
    preloadAudioCards(queueResult.queue.slice(0, 4));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preloadAudioCards, lookaheadSignature, stateVersion, ttsConfig]);

  // Background lookahead stroke pre-caching for upcoming `draw` cards (strictly lazy; 0 KB on Flip decks)
  useEffect(() => {
    if (!platform.getStrokeDataProvider) return;
    const upcomingDrawCards = queueResult.queue.slice(0, 3).filter((c) => {
      const lay = state.layouts.get(c.layout_id);
      return lay?.answer_mode === 'draw';
    });
    if (upcomingDrawCards.length === 0) return;

    let cancelled = false;
    void Promise.all([import('@flash/core/drawing'), platform.getStrokeDataProvider()])
      .then(async ([drawing, strokeProvider]) => {
        if (cancelled) return;
        const byScript: Record<'ja' | 'zh-Hans', Set<string>> = {
          ja: new Set(),
          'zh-Hans': new Set(),
        };
        for (const c of upcomingDrawCards) {
          const n = state.notes.get(c.note_id);
          const d = state.decks.get(c.deck_id);
          const l = state.layouts.get(c.layout_id);
          if (!n || !d || !l) continue;
          const nt = state.noteTypes.get(d.note_type_id);
          const key = l.answer_field ?? l.reveal_steps[0]?.[0] ?? 'word';
          const lang = nt?.fields.find((f) => f.key === key)?.lang ?? d.language;
          if (drawing.resolveDrawingMode(state.preferences, lang) !== 'graded') continue;
          const script = drawing.resolveStrokeScriptForLang(lang);
          for (const ch of drawing.extractDrawableCharacters(n.fields[key] ?? '', lang)) {
            byScript[script].add(ch);
          }
        }
        if (byScript.ja.size > 0 && !cancelled) {
          await strokeProvider.precacheCharacters('ja', [...byScript.ja]);
        }
        if (byScript['zh-Hans'].size > 0 && !cancelled) {
          await strokeProvider.precacheCharacters('zh-Hans', [...byScript['zh-Hans']]);
        }
      })
      .catch(() => {
        // Non-blocking background lookahead
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookaheadSignature, platform, stateVersion]);

  // Stop any playing audio on unmount (depend only on stable `stopAudio`, never the `audio` state wrapper)
  useEffect(() => {
    return () => {
      stopAudio();
    };
  }, [stopAudio]);

  const activeModePlugin = useMemo(
    () => getAnswerMode(currentLayout?.answer_mode ?? 'flip'),
    [currentLayout?.answer_mode],
  );

  const studyDayIndex = useMemo(() => {
    const dayStart = resolveDayStartHour(
      currentDeck?.settings.day_start_hour,
      state.preferences.day_start_hour,
    );
    return getStudyDayIndex(nowMs, tzOffsetMinutes, dayStart);
  }, [
    currentDeck?.settings.day_start_hour,
    nowMs,
    state.preferences.day_start_hour,
    tzOffsetMinutes,
  ]);

  const fieldMetaByKey = useMemo(() => {
    const map = new Map<string, FieldMeta>();
    if (currentNoteType) {
      for (const f of currentNoteType.fields) {
        map.set(f.key, { label: f.label, lang: f.lang, kind: f.kind });
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNoteType, stateVersion]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLayout, currentNote, stateVersion]);

  const totalRevealSteps = populatedRevealSteps.length;
  const isRevealed = revealStep > 0;
  const isFullyRevealed = revealStep >= totalRevealSteps;

  // Reset local card reveal state and trigger front auto-play whenever the active card changes
  useEffect(() => {
    setRevealStep(0);
    setFuriganaOverride(null);
    setEvaluation(null);
    setSwipe({ dx: 0, dy: 0, active: false });
    cardShownAtRef.current = Date.now();

    if (currentCard && currentNote && currentLayout && currentDeck) {
      const shouldAutoPlayFront =
        currentLayout.answer_mode === 'listen' ||
        (Boolean(state.preferences.auto_play_audio) && currentSpeakTiming === 'front');
      if (shouldAutoPlayFront) {
        void audio.speakCard(
          currentCard,
          currentNote,
          currentLayout,
          currentNoteType,
          currentDeck,
          1.0,
        );
      }
    }
    // Only re-run when the active card changes (not on unrelated state ticks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    unlockAudio();
    if (
      revealStep === 0 &&
      currentNote &&
      currentLayout &&
      currentDeck &&
      state.preferences.auto_play_audio &&
      currentSpeakTiming === 'reveal'
    ) {
      // Trigger synchronously during the 0 -> 1 flip gesture so iOS Safari allows playback (§7.2)
      void speakAudioCard(
        currentCard,
        currentNote,
        currentLayout,
        currentNoteType,
        currentDeck,
        1.0,
      );
    }
    setRevealStep((prev) => Math.min(totalRevealSteps, prev + 1));
  }, [
    currentCard,
    currentDeck,
    currentLayout,
    currentNote,
    currentNoteType,
    currentSpeakTiming,
    revealStep,
    speakAudioCard,
    state.preferences.auto_play_audio,
    totalRevealSteps,
    unlockAudio,
  ]);

  const handleEvaluateAndReveal = useCallback(
    (evalResult: AnswerEvaluation) => {
      unlockAudio();
      if (
        revealStep === 0 &&
        currentCard &&
        currentNote &&
        currentLayout &&
        currentDeck &&
        state.preferences.auto_play_audio &&
        currentSpeakTiming === 'reveal'
      ) {
        void speakAudioCard(
          currentCard,
          currentNote,
          currentLayout,
          currentNoteType,
          currentDeck,
          1.0,
        );
      }
      setEvaluation(evalResult);
      setRevealStep((prev) => Math.max(1, Math.min(totalRevealSteps, prev + 1)));
    },
    [
      currentCard,
      currentDeck,
      currentLayout,
      currentNote,
      currentNoteType,
      currentSpeakTiming,
      revealStep,
      speakAudioCard,
      state.preferences.auto_play_audio,
      totalRevealSteps,
      unlockAudio,
    ],
  );

  const handleSpeak = useCallback(
    (rate = 1.0) => {
      if (!currentCard || !currentNote || !currentLayout || !currentDeck) return;
      unlockAudio();
      void speakAudioCard(
        currentCard,
        currentNote,
        currentLayout,
        currentNoteType,
        currentDeck,
        rate,
      );
    },
    [
      currentCard,
      currentDeck,
      currentLayout,
      currentNote,
      currentNoteType,
      speakAudioCard,
      unlockAudio,
    ],
  );

  const handleRate = useCallback(
    (rating: ReviewRating) => {
      if (!currentCard || !isRevealed) return;
      unlockAudio();
      stopAudio();
      const elapsed = Date.now() - cardShownAtRef.current;
      const typedAnswer = evaluation?.typedAnswer;
      setRevealStep(0);
      setFuriganaOverride(null);
      setEvaluation(null);
      cardShownAtRef.current = Date.now();
      // Custom study practice records its own answers (never FSRS); everything else is a review.
      const sessionRate = studyFilter?.session?.rate;
      if (sessionRate) sessionRate(currentCard, rating, elapsed);
      else
        rateCard(
          currentCard,
          rating,
          elapsed,
          typedAnswer !== undefined ? { typedAnswer } : undefined,
        );
    },
    [
      currentCard,
      evaluation?.typedAnswer,
      isRevealed,
      rateCard,
      stopAudio,
      studyFilter,
      unlockAudio,
    ],
  );

  const handleUndo = useCallback(() => {
    stopAudio();
    if ((studyFilter?.session?.undo ?? undoLastReview)()) {
      setRevealStep(0);
      setFuriganaOverride(null);
      setEvaluation(null);
      cardShownAtRef.current = Date.now();
    }
  }, [stopAudio, studyFilter, undoLastReview]);

  const handleToggleFurigana = useCallback(() => {
    setFuriganaOverride((prev) => {
      const current = prev !== null ? prev : hideFrontRuby;
      return !current;
    });
  }, [hideFrontRuby]);

  // Desktop keyboard shortcuts (§5.1 & §5.2)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (editingNote !== null) return;
      if (isEditableTarget(e.target)) return;

      const key = e.key;
      unlockAudio();

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

      if (key.toLowerCase() === 'r') {
        e.preventDefault();
        handleSpeak(1.0);
        return;
      }

      if (key.toLowerCase() === 's') {
        e.preventDefault();
        handleSpeak(0.75);
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
    handleSpeak,
    handleToggleFurigana,
    handleUndo,
    isFullyRevealed,
    isRevealed,
    ratingMode,
    unlockAudio,
  ]);

  // Mobile Pointer Events swipe gestures
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    audio.unlock();
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (isInteractiveControl(e.target)) return;
    if (!isRevealed && activeModePlugin.capturesFrontInteraction) return;
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

    // Small tap advances reveal (suppressed on front of interactive modes)
    if (
      absX < 12 &&
      absY < 12 &&
      !isFullyRevealed &&
      (isRevealed || !activeModePlugin.capturesFrontInteraction)
    ) {
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

  const suggestedRating = evaluation?.suggestedRating;
  const needsAiReview = Boolean(
    currentNote && currentNote.provenance.source === 'ai' && !currentNote.provenance.reviewed,
  );

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
          {platform.starterCatalogUrl && (
            <button
              type="button"
              data-testid="empty-browse-starter-decks-btn"
              onClick={onOpenLibrary}
              className="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90"
            >
              Browse Starter Decks
            </button>
          )}
          <button
            type="button"
            onClick={loadSampleDecks}
            className={
              platform.starterCatalogUrl
                ? 'rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm font-semibold hover:bg-[var(--surface-2)]'
                : 'rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90'
            }
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
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm font-semibold hover:bg-[var(--surface-2)]"
            >
              Connect Cloud Sync
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 sm:gap-4 short:gap-2">
      {/* Top study header: Deck selector + Due counts + Quick actions */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <select
            aria-label="Select deck to study"
            value={activeDeckId ?? ''}
            onChange={(e) => {
              audio.stop();
              setActiveDeckId(e.target.value || undefined);
              setStudyFilter(undefined);
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

          {studyFilter ? (
            <span
              data-testid="study-filter-chip"
              className="inline-flex max-w-[10rem] items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] py-0.5 pl-2.5 pr-1 text-xs font-semibold text-[var(--accent)]"
            >
              <span className="truncate">{studyFilter.label}</span>
              <button
                type="button"
                data-testid="study-filter-clear"
                aria-label="Clear study filter"
                onClick={() => setStudyFilter(undefined)}
                className="rounded-full px-1 hover:bg-[var(--surface-2)]"
              >
                ×
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid="study-filter-btn"
              aria-expanded={showFilterPanel}
              onClick={() => setShowFilterPanel((v) => !v)}
              title="Study sets, filters and custom study (review ahead, extra new, practice)"
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--fg)] hover:bg-[var(--surface-2)]"
            >
              Filter
            </button>
          )}

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
            disabled={undoStack.length === 0 && !studyFilter?.session?.undo}
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

      {showFilterPanel && !studyFilter && (
        <Suspense
          fallback={<div className="py-4 text-center text-xs text-[var(--muted)]">Loading…</div>}
        >
          <LazyStudyFilterPanel
            deckId={activeDeckId}
            onStart={(active) => {
              audio.stop();
              setStudyFilter({ ...active, scope: { deckId: activeDeckId } });
              setShowFilterPanel(false);
            }}
            onClose={() => setShowFilterPanel(false)}
          />
        </Suspense>
      )}

      {/* One-time OS Offline Voice Pack setup banner (§7.1) */}
      {audio.missingVoicePrompt && (
        <div
          role="status"
          data-testid="missing-voice-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-900 dark:text-amber-200"
        >
          <span className="flex-1">{audio.missingVoicePrompt.message}</span>
          <button
            type="button"
            data-testid="dismiss-missing-voice-btn"
            onClick={() => void audio.dismissMissingVoicePrompt()}
            className="rounded-lg border border-amber-500/40 bg-[var(--surface)] px-2.5 py-1 font-semibold text-[var(--fg)] hover:bg-[var(--surface-2)]"
          >
            Got it
          </button>
        </div>
      )}

      {/* Non-blocking Cloud TTS fallback toast */}
      {audio.lastAudioWarning && (
        <div
          role="status"
          data-testid="audio-warning-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-xs text-[var(--muted)]"
        >
          <span className="flex-1">{audio.lastAudioWarning}</span>
          <button
            type="button"
            data-testid="dismiss-audio-warning-btn"
            onClick={audio.dismissAudioWarning}
            className="rounded-lg border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--fg)] hover:bg-[var(--surface-2)]"
          >
            Dismiss
          </button>
        </div>
      )}

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
              : studyFilter
                ? `No cards in "${studyFilter.label}" are due right now.`
                : queueResult.buriedNoteIds.size > 0
                  ? `${queueResult.buriedNoteIds.size} sibling card(s) are buried until tomorrow's study day.`
                  : 'You have finished all scheduled cards in this selection.'}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {studyFilter && (
              <button
                type="button"
                data-testid="study-filter-clear-empty"
                onClick={() => setStudyFilter(undefined)}
                className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white"
              >
                Clear filter
              </button>
            )}
            {activeDeckId && !studyFilter && (
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
        <div className="flex min-h-0 flex-1 flex-col gap-3 short:flex-row">
          <StudyCard
            answerMode={currentLayout.answer_mode}
            deckName={currentDeck.name}
            layoutLabel={`${currentLayout.name}${currentCard.variant > 0 ? ` · c${currentCard.variant}` : ''}`}
            isRevealed={isRevealed}
            capturesFront={activeModePlugin.capturesFrontInteraction}
            hint={
              !isFullyRevealed && (!activeModePlugin.capturesFrontInteraction || isRevealed)
                ? isRevealed
                  ? 'Tap or press Space for more'
                  : 'Tap card or press Space to reveal'
                : null
            }
            swipe={swipe}
            swipeIntent={swipeIntent}
            showSpeaker={Boolean(
              currentAudioTarget &&
              (currentAudioTarget.attachedMediaHash || currentAudioTarget.normalizedText),
            )}
            onSpeak={handleSpeak}
            needsAiReview={needsAiReview}
            onMarkReviewed={() => markNoteReviewed(currentNote)}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          >
            {/* Pluggable Answer Mode renderer (§5.2) */}
            {activeModePlugin.render({
              state,
              card: currentCard,
              note: currentNote,
              deck: currentDeck,
              layout: currentLayout,
              noteType: currentNoteType,
              fieldMetaByKey,
              populatedRevealSteps,
              revealStep,
              isRevealed,
              isFullyRevealed,
              hideFrontRuby,
              pinyinToneColors: state.preferences.pinyin_tone_colors,
              studyDayIndex,
              evaluation,
              onRevealNext: handleRevealNext,
              onEvaluateAndReveal: handleEvaluateAndReveal,
              onSpeak: handleSpeak,
            })}
          </StudyCard>

          <RatingBar
            isRevealed={isRevealed}
            isFullyRevealed={isFullyRevealed}
            revealStep={revealStep}
            totalRevealSteps={totalRevealSteps}
            ratingMode={ratingMode}
            suggestedRating={suggestedRating}
            intervals={intervals}
            onRevealNext={handleRevealNext}
            onRate={handleRate}
          />
        </div>
      )}

      {editingNote && (
        <Suspense fallback={null}>
          <LazyNoteEditDialog
            note={editingNote}
            noteType={state.noteTypes.get(state.decks.get(editingNote.deck_id)?.note_type_id ?? '')}
            {...(state.decks.get(editingNote.deck_id)?.source !== undefined
              ? { deckSource: state.decks.get(editingNote.deck_id)?.source }
              : {})}
            onSave={(note, fields, tags) => updateNote(note, fields, tags)}
            onClose={() => setEditingNote(null)}
          />
        </Suspense>
      )}
    </section>
  );
}
