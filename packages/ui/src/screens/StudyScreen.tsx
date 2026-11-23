import {
  buildStudyQueue,
  compareCodeUnits,
  formatIntervalLabel,
  getStudyDayIndex,
  hasRubyMarkup,
  previewIntervals,
  resolveCardAudioTarget,
  resolveDayStartHour,
  resolveDeckFsrsConfig,
  resolveLayoutSpeakTiming,
  type Card,
  type CollectionState,
  type Deck,
  type Layout,
  type Note,
  type NoteType,
  type RatingButtonMode,
  type ReviewRating,
} from '@flash/core';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as DeferredSyncPromptModuleType from '../onboarding/DeferredSyncPromptSlot.tsx';
import { useApp, type AppContextValue } from '../state/AppContext.tsx';
import { useActiveLanguages } from '../state/useActiveLanguages.ts';
import { getAnswerMode } from '../study/answerModes/registry.ts';
import type { AnswerEvaluation, FieldMeta } from '../study/answerModes/types.ts';
import {
  isStudyFilterInScope,
  resolveStudyQueueDeckId,
  setStudyFilter,
  useStudyFilter,
  type ActiveStudyFilter,
  type StudySession,
} from '../study/filterStore.ts';
import { RatingBar } from '../study/RatingBar.tsx';
import { StudyCard, type SwipeIntent } from '../study/StudyCard.tsx';

const LazyNoteEditDialog = lazy(() =>
  import('../components/NoteEditDialog.tsx').then((m) => ({ default: m.NoteEditDialog })),
);
// Phase 9 "Study this filter" panel is off the critical path (§8).
const LazyStudyFilterPanel = lazy(() =>
  import('../study/StudyFilterPanel.tsx').then((m) => ({ default: m.StudyFilterPanel })),
);

// Zero-deck screen with first-run onboarding (pick a language, then a starter deck): shown only
// while the collection is empty, so it stays off the critical path (§8).
const LazyEmptyCollection = lazy(() =>
  import('../study/EmptyCollection.tsx').then((m) => ({ default: m.EmptyCollection })),
);

// Deferred onboarding sync prompt (§8: not in the initial study chunk). The module is imported and
// the per-device onboarding record read when the study screen mounts, so the prompt can paint in
// the same commit as the caught-up panel instead of shifting it later. Kept once loaded, so a
// remount (back from Settings) has it synchronously.
type DeferredSyncPromptModule = typeof DeferredSyncPromptModuleType;
let loadedDeferredSyncPrompt: DeferredSyncPromptModule | undefined;
/** An add-device link sends a device with cards to Settings once (per link, so a second link opened inside a native shell routes too). */
let addDeviceLinkRouted: unknown;

function useDeferredSyncPromptModule(
  storage: Parameters<DeferredSyncPromptModule['preloadDeferredSyncPrompt']>[0],
): { mod: DeferredSyncPromptModule | undefined; readyAtMount: boolean } {
  const [readyAtMount] = useState(() => loadedDeferredSyncPrompt !== undefined);
  const [mod, setMod] = useState(loadedDeferredSyncPrompt);
  useEffect(() => {
    if (mod) return;
    let live = true;
    import('../onboarding/DeferredSyncPromptSlot.tsx')
      .then(async (m) => {
        await m.preloadDeferredSyncPrompt(storage);
        loadedDeferredSyncPrompt = m;
        if (live) setMod(m);
      })
      .catch(() => {
        // Optional prompt: a failed chunk load just means it is not offered this time.
      });
    return () => {
      live = false;
    };
  }, [mod, storage]);
  return { mod, readyAtMount };
}

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

const NO_SWIPE: SwipeState = { dx: 0, dy: 0, active: false };

/** The note, deck, layout and note type of the card being studied. */
interface StudyCardContext {
  note?: Note | undefined;
  deck?: Deck | undefined;
  layout?: Layout | undefined;
  noteType?: NoteType | undefined;
}

function resolveCardContext(state: CollectionState, card: Card | undefined): StudyCardContext {
  if (!card) return {};
  const deck = state.decks.get(card.deck_id);
  return {
    note: state.notes.get(card.note_id),
    deck,
    layout: state.layouts.get(card.layout_id),
    noteType: deck ? state.noteTypes.get(deck.note_type_id) : undefined,
  };
}

/** Today's queue: a custom-study session's own queue, else the (optionally filtered) schedule. */
function buildScreenQueue(
  state: CollectionState,
  studyFilter: ActiveStudyFilter | undefined,
  deckId: string | undefined,
  nowMs: number,
  tzOffsetMinutes: number,
) {
  if (studyFilter?.session) {
    return studyFilter.session.buildQueue(state, { deckId, nowMs, tzOffsetMinutes });
  }
  return buildStudyQueue(state, {
    ...(deckId === undefined ? {} : { deckId }),
    ...(studyFilter === undefined ? {} : { filter: studyFilter.filter }),
    nowMs,
    tzOffsetMinutes,
  });
}

/** Reveal steps with at least one non-empty field on the note (never zero steps). */
function populatedRevealStepsFor(layout: Layout | undefined, note: Note | undefined): string[][] {
  if (!layout || !note) return [];
  const steps = layout.reveal_steps
    .map((stepKeys) => stepKeys.filter((key) => (note.fields[key]?.trim().length ?? 0) > 0))
    .filter((stepKeys) => stepKeys.length > 0);
  return steps.length > 0 ? steps : [layout.reveal_steps[0] ?? []];
}

/** Swipe direction past the given thresholds (px), or `null`. Easy needs 3+ rating buttons. */
function classifySwipe(
  dx: number,
  dy: number,
  ratingMode: RatingButtonMode,
  minX: number,
  minUp: number,
): SwipeIntent {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX >= minX && absX > absY) return dx < 0 ? 'again' : 'good';
  if (dy <= -minUp && absY > absX && ratingMode !== '2') return 'easy';
  return null;
}

const SWIPE_RATING: Record<Exclude<SwipeIntent, null>, ReviewRating> = {
  again: 1,
  good: 3,
  easy: 4,
};

type StudyKeyAction = 'undo' | 'reveal' | 'furigana' | 'speak' | 'slow' | 'edit' | ReviewRating;

const LETTER_KEY_ACTIONS: Record<string, StudyKeyAction> = {
  f: 'furigana',
  r: 'speak',
  s: 'slow',
  z: 'undo',
  e: 'edit',
};

/** Rating keys: the rating, and the fewest rating buttons that show it (§5.1). */
const RATING_KEYS: Record<string, readonly [ReviewRating, number]> = {
  '1': [1, 0],
  ArrowLeft: [1, 0],
  '2': [3, 0],
  ArrowRight: [3, 0],
  '3': [4, 3],
  ArrowUp: [4, 3],
  '4': [2, 4],
  ArrowDown: [2, 4],
};

/** Space / Enter reveal the next step, unless focus is on a button or link (no double activation). */
function confirmKeyAction(e: KeyboardEvent, isFullyRevealed: boolean): StudyKeyAction | undefined {
  if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) {
    return undefined;
  }
  return isFullyRevealed ? undefined : 'reveal';
}

/** Desktop keyboard shortcuts (§5.1 & §5.2). */
function resolveStudyKeyAction(
  e: KeyboardEvent,
  isRevealed: boolean,
  isFullyRevealed: boolean,
  ratingMode: RatingButtonMode,
): StudyKeyAction | undefined {
  const key = e.key;
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'z') return 'undo';
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  if (key === ' ' || key === 'Enter') return confirmKeyAction(e, isFullyRevealed);
  const letter = LETTER_KEY_ACTIONS[key.toLowerCase()];
  if (letter !== undefined) return letter;
  const rating = isRevealed ? RATING_KEYS[key] : undefined;
  return rating && Number(ratingMode) >= rating[1] ? rating[0] : undefined;
}

/** Undo is enabled only when there is something to undo: the session's last answer, else a review. */
function canUndo(session: StudySession | undefined, reviewUndoDepth: number): boolean {
  if (session?.undo) return session.canUndo?.() ?? true;
  return reviewUndoDepth > 0;
}

function layoutLabelFor(layout: Layout, card: Card): string {
  return card.variant > 0 ? `${layout.name} · c${card.variant}` : layout.name;
}

function revealHint(isRevealed: boolean, isFullyRevealed: boolean, capturesFront: boolean) {
  if (isFullyRevealed || (capturesFront && !isRevealed)) return null;
  return isRevealed ? 'Tap or press Space for more' : 'Tap card or press Space to reveal';
}

function caughtUpMessage(
  nextLearningDueAt: number | undefined,
  nowMs: number,
  studyFilter: ActiveStudyFilter | undefined,
  buriedCount: number,
): string {
  if (nextLearningDueAt !== undefined) {
    return `Next learning card is due in ${formatIntervalLabel(nextLearningDueAt, nowMs)}. It will appear automatically.`;
  }
  if (studyFilter) return `No cards in "${studyFilter.label}" are due right now.`;
  if (buriedCount > 0) {
    return `${buriedCount} sibling card(s) are buried until tomorrow's study day.`;
  }
  return 'You have finished all scheduled cards in this selection.';
}

const PANEL_ACCENT_BUTTON_CLASS =
  'rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white';

/** Nothing to study right now: why, and where to go next. */
function CaughtUpPanel({
  message,
  learningPending,
  hasFilter,
  canStudyAll,
  onStudyAll,
  onOpenLibrary,
}: {
  message: string;
  learningPending: boolean;
  hasFilter: boolean;
  canStudyAll: boolean;
  onStudyAll: () => void;
  onOpenLibrary: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
      <h2 className="text-xl font-bold">
        {learningPending ? 'Learning card coming up' : 'All caught up for today!'}
      </h2>
      <p className="max-w-sm text-sm text-[var(--muted)]">{message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {hasFilter && (
          <button
            type="button"
            data-testid="study-filter-clear-empty"
            onClick={() => setStudyFilter(undefined)}
            className={PANEL_ACCENT_BUTTON_CLASS}
          >
            Clear filter
          </button>
        )}
        {canStudyAll && !hasFilter && (
          <button type="button" onClick={onStudyAll} className={PANEL_ACCENT_BUTTON_CLASS}>
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
  );
}

/**
 * Onboarding's starter deck: seeds only that sample deck (lazily) and studies it right away.
 * Rejects when the samples chunk cannot load (stale deploy, offline cache miss), so the caller
 * can keep onboarding open and let the user retry.
 */
// Onboarding decks live behind one seam (`onboarding/starterDecks.ts`), loaded only on demand.
async function startOnboardingDeck(
  slug: string,
  app: Pick<AppContextValue, 'getEventFactory' | 'setActiveDeckId' | 'emitEvents'>,
): Promise<void> {
  const decks = await import('../onboarding/starterDecks.ts');
  await decks.startOnboardingDeck(slug, app);
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
    emitEvents,
    getEventFactory,
    syncState,
    addDeviceLink,
  } = useApp();
  const rubyLanguage = useActiveLanguages().hasFeature('ruby');

  const [revealStep, setRevealStep] = useState(0);
  const deferredSyncPrompt = useDeferredSyncPromptModule(platform.storage);
  const [furiganaOverride, setFuriganaOverride] = useState<boolean | null>(null);
  const [evaluation, setEvaluation] = useState<AnswerEvaluation | null>(null);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [swipe, setSwipe] = useState<SwipeState>(NO_SWIPE);
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
        .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  // Opened from another device's add-device link on a device that already has cards: "Sync my
  // devices" (with that provider preselected) is in Settings here, so go there, once per page
  // load. An empty collection shows it in place instead.
  const hasDecks = decks.length > 0;
  useEffect(() => {
    if (addDeviceLinkRouted === addDeviceLink || !addDeviceLink || !hasDecks || !onOpenSettings) {
      return;
    }
    addDeviceLinkRouted = addDeviceLink;
    onOpenSettings();
  }, [addDeviceLink, hasDecks, onOpenSettings]);

  const nowMs = Date.now();
  const tzOffsetMinutes = -new Date(nowMs).getTimezoneOffset();

  // A filter naming its own decks (e.g. a Study Set saved under another deck) runs on those decks.
  const queueDeckId = resolveStudyQueueDeckId(studyFilter, activeDeckId);
  const queueResult = useMemo(
    () => buildScreenQueue(state, studyFilter, queueDeckId, nowMs, tzOffsetMinutes),
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
  const {
    note: currentNote,
    deck: currentDeck,
    layout: currentLayout,
    noteType: currentNoteType,
  } = resolveCardContext(state, currentCard);

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
    void Promise.all([import('../study/strokePrecache.ts'), platform.getStrokeDataProvider()])
      .then(([precache, strokeProvider]) =>
        precache.precacheUpcomingDrawCards(
          state,
          upcomingDrawCards,
          strokeProvider,
          () => cancelled,
        ),
      )
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
  const populatedRevealSteps = useMemo(
    () => populatedRevealStepsFor(currentLayout, currentNote),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentLayout, currentNote, stateVersion],
  );

  const totalRevealSteps = populatedRevealSteps.length;
  const isRevealed = revealStep > 0;
  const isFullyRevealed = revealStep >= totalRevealSteps;

  // Reset local card reveal state and trigger front auto-play whenever the active card changes
  useEffect(() => {
    setRevealStep(0);
    setFuriganaOverride(null);
    setEvaluation(null);
    setSwipe(NO_SWIPE);
    cardShownAtRef.current = Date.now();

    const autoPlayFront =
      currentLayout?.answer_mode === 'listen' ||
      (Boolean(state.preferences.auto_play_audio) && currentSpeakTiming === 'front');
    if (autoPlayFront && currentCard && currentNote && currentLayout && currentDeck) {
      void audio.speakCard(
        currentCard,
        currentNote,
        currentLayout,
        currentNoteType,
        currentDeck,
        1.0,
      );
    }
    // Only re-run when the active card changes (not on unrelated state ticks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCard?.id]);

  // Ruby (furigana, pinyin) is offered for ja/zh. Korean shows Hanja as plain text, so a Korean
  // card gets the toggle only when ruby already stored in it is hidden on the front.
  const frontRubyHidden =
    Boolean(currentLayout?.hide_furigana_on_front) &&
    Boolean(currentLayout?.front_fields.some((k) => hasRubyMarkup(currentNote?.fields[k] ?? '')));
  const showFuriganaToggle = rubyLanguage || frontRubyHidden;
  const hideFrontRuby =
    furiganaOverride ?? (!isRevealed && Boolean(currentLayout?.hide_furigana_on_front));

  const intervals = useMemo(() => {
    if (!currentCard || !isRevealed) return null;
    const cfg = resolveDeckFsrsConfig(state, currentCard.deck_id, nowMs);
    return previewIntervals(currentCard.schedule, nowMs, cfg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCard, isRevealed, state, stateVersion]);

  const ratingMode = state.preferences.rating_button_mode;

  // Speaks on the 0 -> 1 flip when the layout speaks on reveal. Runs synchronously inside the
  // gesture so iOS Safari allows playback (§7.2).
  const speakOnFirstReveal = useCallback(() => {
    unlockAudio();
    const speakNow =
      revealStep === 0 && state.preferences.auto_play_audio && currentSpeakTiming === 'reveal';
    if (speakNow && currentCard && currentNote && currentLayout && currentDeck) {
      void speakAudioCard(
        currentCard,
        currentNote,
        currentLayout,
        currentNoteType,
        currentDeck,
        1.0,
      );
    }
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
    unlockAudio,
  ]);

  const handleRevealNext = useCallback(() => {
    if (!currentCard) return;
    speakOnFirstReveal();
    setRevealStep((prev) => Math.min(totalRevealSteps, prev + 1));
  }, [currentCard, speakOnFirstReveal, totalRevealSteps]);

  const handleEvaluateAndReveal = useCallback(
    (evalResult: AnswerEvaluation) => {
      speakOnFirstReveal();
      setEvaluation(evalResult);
      setRevealStep((prev) => Math.max(1, Math.min(totalRevealSteps, prev + 1)));
    },
    [speakOnFirstReveal, totalRevealSteps],
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
          typedAnswer === undefined ? undefined : { typedAnswer },
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

  // A layout that shows only readings or only bases has no ruby to hide, so F does nothing there.
  const rubyFlagged =
    currentLayout?.ruby_display === 'readings' || currentLayout?.ruby_display === 'bases';
  const handleToggleFurigana = useCallback(() => {
    if (rubyFlagged || !showFuriganaToggle) return;
    setFuriganaOverride((prev) => !(prev ?? hideFrontRuby));
  }, [hideFrontRuby, rubyFlagged, showFuriganaToggle]);

  // Desktop keyboard shortcuts (§5.1 & §5.2)
  useEffect(() => {
    const runKeyAction = (action: StudyKeyAction) => {
      if (typeof action === 'number') handleRate(action);
      else if (action === 'undo') handleUndo();
      else if (action === 'reveal') handleRevealNext();
      else if (action === 'furigana') handleToggleFurigana();
      else if (action === 'edit') setEditingNote(currentNote ?? null);
      else handleSpeak(action === 'slow' ? 0.75 : 1.0);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (editingNote !== null || isEditableTarget(e.target)) return;
      unlockAudio();
      const action = resolveStudyKeyAction(e, isRevealed, isFullyRevealed, ratingMode);
      if (action === undefined || (action === 'edit' && !currentNote)) return;
      e.preventDefault();
      runKeyAction(action);
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
    setSwipe({ ...NO_SWIPE, active: true });
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
    setSwipe(NO_SWIPE);

    // Swipe left -> Again, right -> Good, up -> Easy
    const intent = isRevealed ? classifySwipe(dx, dy, ratingMode, 72, 80) : null;
    if (intent) {
      handleRate(SWIPE_RATING[intent]);
      return;
    }
    // Small tap advances reveal (suppressed on front of interactive modes)
    const isTap = Math.abs(dx) < 12 && Math.abs(dy) < 12;
    if (
      isTap &&
      revealHint(isRevealed, isFullyRevealed, activeModePlugin.capturesFrontInteraction)
    ) {
      handleRevealNext();
    }
  };

  const handlePointerCancel = () => {
    pointerStartRef.current = null;
    setSwipe(NO_SWIPE);
  };

  const swipeIntent =
    swipe.active && isRevealed ? classifySwipe(swipe.dx, swipe.dy, ratingMode, 48, 56) : null;

  const suggestedRating = evaluation?.suggestedRating;
  const needsAiReview = currentNote?.provenance.source === 'ai' && !currentNote.provenance.reviewed;
  const editingDeck = state.decks.get(editingNote?.deck_id ?? '');

  const caughtUp = !currentCard || !currentNote || !currentLayout || !currentDeck;

  if (decks.length === 0) {
    return (
      <Suspense fallback={null}>
        <LazyEmptyCollection
          storage={platform.storage}
          starterCatalogUrl={platform.starterCatalogUrl}
          collectionEmpty={state.decks.size === 0}
          openedFromAddDeviceLink={addDeviceLink !== undefined}
          onOpenLibrary={onOpenLibrary}
          onOpenSettings={onOpenSettings}
          onStartWithDeck={(deck) =>
            startOnboardingDeck(deck.slug, { getEventFactory, setActiveDeckId, emitEvents })
          }
        />
      </Suspense>
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
          {showFuriganaToggle && (
            <button
              type="button"
              onClick={handleToggleFurigana}
              disabled={rubyFlagged}
              title={
                rubyFlagged
                  ? 'This layout shows readings or bases only (set in Deck options)'
                  : 'Toggle furigana / reading hints (F)'
              }
              aria-pressed={!hideFrontRuby}
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                !hideFrontRuby
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]'
              } disabled:opacity-40`}
            >
              {hideFrontRuby ? 'Ruby Off' : 'Ruby On'}
            </button>
          )}

          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo(studyFilter?.session, undoStack.length)}
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
        <CaughtUpPanel
          message={caughtUpMessage(
            nextLearningDueAt,
            nowMs,
            studyFilter,
            queueResult.buriedNoteIds.size,
          )}
          learningPending={nextLearningDueAt !== undefined}
          hasFilter={Boolean(studyFilter)}
          canStudyAll={activeDeckId !== undefined}
          onStudyAll={() => setActiveDeckId(undefined)}
          onOpenLibrary={onOpenLibrary}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 short:flex-row">
          <StudyCard
            answerMode={currentLayout.answer_mode}
            rubyDisplay={currentLayout.ruby_display}
            deckName={currentDeck.name}
            layoutLabel={layoutLabelFor(currentLayout, currentCard)}
            isRevealed={isRevealed}
            capturesFront={activeModePlugin.capturesFrontInteraction}
            hint={revealHint(
              isRevealed,
              isFullyRevealed,
              activeModePlugin.capturesFrontInteraction,
            )}
            swipe={swipe}
            swipeIntent={swipeIntent}
            showSpeaker={Boolean(
              currentAudioTarget?.attachedMediaHash || currentAudioTarget?.normalizedText,
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

      {/* Deferred onboarding sync step: after the first finished session, below every control.
          One stable position in both branches, so it is mounted while a card is on screen. */}
      {deferredSyncPrompt.mod && (
        <deferredSyncPrompt.mod.DeferredSyncPromptSlot
          storage={platform.storage}
          provider={syncState.provider}
          caughtUp={caughtUp}
          readyAtScreenMount={deferredSyncPrompt.readyAtMount}
          sessionReviewed={undoStack.length > 0}
          onOpenSettings={onOpenSettings}
        />
      )}

      {editingNote && (
        <Suspense fallback={null}>
          <LazyNoteEditDialog
            note={editingNote}
            noteType={state.noteTypes.get(editingDeck?.note_type_id ?? '')}
            {...(editingDeck?.source === undefined ? {} : { deckSource: editingDeck.source })}
            onSave={(note, fields, tags) => updateNote(note, fields, tags)}
            onClose={() => setEditingNote(null)}
          />
        </Suspense>
      )}
    </section>
  );
}
