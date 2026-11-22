import {
  buildStudyQueue,
  decodeUtf8,
  getEnabledLayoutsForDeck,
  uuidv7,
  type AnswerMode,
  type Deck,
  type DeckSettings,
  type Layout,
  type NewCardOrder,
  type NoteType,
  type Page,
  type SpeakTiming,
} from '@flash/core';
import { canCreateOrImportDeck } from '@flash/core/license';
import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CoursesPanel } from '../components/CoursesPanel.tsx';
import { describeImportError } from '../components/describeImportError.ts';
import { SourcesPanel } from '../components/SourcesPanel.tsx';
import { useApp } from '../state/AppContext.tsx';

const LazyPageViewer = lazy(() => import('../pages/PageViewer.tsx'));
const LazyPageEditor = lazy(() => import('../pages/PageEditor.tsx'));

function DeckOptionsPanel({
  deck,
  noteType,
  onUpdateSettings,
  onExportDeck,
  onArchiveDeck,
  onAddLayout,
}: {
  deck: Deck;
  noteType: NoteType | undefined;
  onUpdateSettings: (
    deckId: string,
    patch: { name?: string; archived?: boolean; settings?: Partial<DeckSettings> },
  ) => void;
  onExportDeck: (deck: Deck) => void;
  onArchiveDeck: (deck: Deck) => void;
  onAddLayout: (layout: Layout, deckId: string) => void;
}) {
  const { platform, state, stateVersion, rescheduleDeck } = useApp();
  const [rescheduleStatus, setRescheduleStatus] = useState<string | null>(null);
  const [newPerDayDraft, setNewPerDayDraft] = useState(String(deck.settings.new_cards_per_day));
  const [maxRevDraft, setMaxRevDraft] = useState(String(deck.settings.max_reviews_per_day));
  const [retentionDraft, setRetentionDraft] = useState(String(deck.settings.target_retention));

  // Offline stroke pre-cache status for `draw`-capable decks (§6.4)
  const [strokeCoverage, setStrokeCoverage] = useState<{
    script: 'ja' | 'zh-Hans';
    cached: number;
    total: number;
  } | null>(null);
  const [precachingStrokes, setPrecachingStrokes] = useState(false);
  const [precacheStatus, setPrecacheStatus] = useState<string | null>(null);

  const deckHasDraw = useMemo(() => {
    const enabled = getEnabledLayoutsForDeck(state, deck);
    if (enabled.some((l) => l.answer_mode === 'draw')) return true;
    const norm = deck.language.toLowerCase();
    return norm === 'ja' || norm.startsWith('ja-') || norm === 'zh' || norm.startsWith('zh-');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, state, stateVersion]);

  useEffect(() => {
    if (!deckHasDraw || !platform.getStrokeDataProvider) return;
    let cancelled = false;
    void Promise.all([import('@flash/core/drawing'), platform.getStrokeDataProvider()])
      .then(async ([drawing, provider]) => {
        if (cancelled) return;
        const script = drawing.resolveStrokeScriptForLang(deck.language);
        const chars = new Set<string>();
        const targetField =
          noteType?.fields.find((f) => f.key === 'word' || f.key === 'character')?.key ??
          noteType?.fields[0]?.key ??
          'word';
        for (const note of state.notes.values()) {
          if (note.archived || note.deck_id !== deck.id) continue;
          const raw = note.fields[targetField] ?? '';
          for (const ch of drawing.extractDrawableCharacters(raw, deck.language)) {
            chars.add(ch);
          }
        }
        const cov = await provider.getCacheCoverage(script, [...chars]);
        if (!cancelled) {
          setStrokeCoverage({ script, cached: cov.cached, total: cov.total });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.id, deck.language, deckHasDraw, noteType, platform, stateVersion]);

  const handlePrecacheDeckStrokes = async () => {
    if (!platform.getStrokeDataProvider) return;
    setPrecachingStrokes(true);
    setPrecacheStatus(null);
    try {
      const [drawing, provider] = await Promise.all([
        import('@flash/core/drawing'),
        platform.getStrokeDataProvider(),
      ]);
      const script = drawing.resolveStrokeScriptForLang(deck.language);
      const chars = new Set<string>();
      const targetField =
        noteType?.fields.find((f) => f.key === 'word' || f.key === 'character')?.key ??
        noteType?.fields[0]?.key ??
        'word';
      for (const note of state.notes.values()) {
        if (note.archived || note.deck_id !== deck.id) continue;
        const raw = note.fields[targetField] ?? '';
        for (const ch of drawing.extractDrawableCharacters(raw, deck.language)) {
          chars.add(ch);
        }
      }
      const list = [...chars];
      const res = await provider.precacheCharacters(script, list, {
        onProgress: (p) => {
          setStrokeCoverage({ script, cached: p.cached, total: p.total });
          setPrecacheStatus(`Pre-caching ${p.completed}/${p.total}…`);
        },
      });
      setStrokeCoverage({ script, cached: res.cached, total: list.length });
      setPrecacheStatus(
        res.failed.length === 0
          ? `Cached ${res.cached}/${list.length} characters for offline drawing.`
          : `Cached ${res.cached}/${list.length} (${res.failed.length} unavailable in pack host).`,
      );
    } catch (err) {
      setPrecacheStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setPrecachingStrokes(false);
    }
  };

  // New Answer Mode Layout form
  const textFields = useMemo(
    () =>
      (noteType?.fields ?? []).filter(
        (f) => f.kind !== 'image' && f.kind !== 'audio' && f.key !== 'audio',
      ),
    [noteType],
  );
  const [layoutMode, setLayoutMode] = useState<AnswerMode>('typed');
  const [layoutName, setLayoutName] = useState('');
  const [frontFieldKey, setFrontFieldKey] = useState(textFields[0]?.key ?? 'word');
  const [answerFieldKey, setAnswerFieldKey] = useState(
    textFields.find((f) => f.key === 'meaning' || f.key === 'reading')?.key ??
      textFields[1]?.key ??
      textFields[0]?.key ??
      'meaning',
  );
  const [speakFieldKey, setSpeakFieldKey] = useState(
    textFields.find((f) => f.tts)?.key ?? textFields[0]?.key ?? 'word',
  );
  const [speakOn, setSpeakOn] = useState<SpeakTiming>('front');
  const [clozeTyped, setClozeTyped] = useState(false);

  useEffect(() => {
    setNewPerDayDraft(String(deck.settings.new_cards_per_day));
  }, [deck.settings.new_cards_per_day]);

  useEffect(() => {
    setMaxRevDraft(String(deck.settings.max_reviews_per_day));
  }, [deck.settings.max_reviews_per_day]);

  useEffect(() => {
    setRetentionDraft(String(deck.settings.target_retention));
  }, [deck.settings.target_retention]);

  const commitNewPerDay = () => {
    const parsed = Number(newPerDayDraft);
    if (Number.isFinite(parsed) && newPerDayDraft.trim() !== '') {
      const clamped = Math.max(0, Math.min(999, Math.round(parsed)));
      if (clamped !== deck.settings.new_cards_per_day) {
        onUpdateSettings(deck.id, { settings: { new_cards_per_day: clamped } });
      }
      setNewPerDayDraft(String(clamped));
    } else {
      setNewPerDayDraft(String(deck.settings.new_cards_per_day));
    }
  };

  const commitMaxRev = () => {
    const parsed = Number(maxRevDraft);
    if (Number.isFinite(parsed) && maxRevDraft.trim() !== '') {
      const clamped = Math.max(1, Math.min(9999, Math.round(parsed)));
      if (clamped !== deck.settings.max_reviews_per_day) {
        onUpdateSettings(deck.id, { settings: { max_reviews_per_day: clamped } });
      }
      setMaxRevDraft(String(clamped));
    } else {
      setMaxRevDraft(String(deck.settings.max_reviews_per_day));
    }
  };

  const commitRetention = () => {
    const parsed = Number(retentionDraft);
    if (Number.isFinite(parsed) && parsed >= 0.7 && parsed <= 0.99) {
      const rounded = Math.round(parsed * 100) / 100;
      if (rounded !== deck.settings.target_retention) {
        onUpdateSettings(deck.id, { settings: { target_retention: rounded } });
      }
      setRetentionDraft(String(rounded));
    } else {
      setRetentionDraft(String(deck.settings.target_retention));
    }
  };

  const handleCreateLayout = (e: FormEvent) => {
    e.preventDefault();
    const effectiveFront = frontFieldKey || textFields[0]?.key || 'word';
    const effectiveAnswer = answerFieldKey || textFields[1]?.key || effectiveFront;
    const allFieldKeys = (noteType?.fields ?? [])
      .filter((f) => f.kind !== 'audio' && f.key !== 'audio')
      .map((f) => f.key);
    const remainingFields = allFieldKeys.filter(
      (k) => k !== effectiveFront && k !== effectiveAnswer,
    );
    const step1 = [effectiveAnswer, ...(remainingFields.includes('image') ? ['image'] : [])];
    const step2 = remainingFields.filter((k) => k !== 'image');
    const modeTitle =
      layoutName.trim() ||
      (layoutMode === 'typed'
        ? 'Typed'
        : layoutMode === 'choice'
          ? 'Choice'
          : layoutMode === 'cloze'
            ? 'Cloze'
            : layoutMode === 'listen'
              ? 'Listen'
              : layoutMode === 'draw'
                ? 'Draw'
                : 'Flip');

    const newLayout: Layout = {
      id: `layout:custom:${deck.note_type_id}:${layoutMode}:${uuidv7().slice(0, 8)}`,
      note_type_id: deck.note_type_id,
      name: modeTitle,
      front_fields: [effectiveFront],
      reveal_steps: step2.length > 0 ? [step1, step2] : [step1],
      answer_mode: layoutMode,
      speak_field: speakFieldKey || effectiveFront,
      speak_on: layoutMode === 'listen' ? 'front' : speakOn,
      hide_furigana_on_front: layoutMode !== 'typed' && layoutMode !== 'draw',
      enabled: false,
      ...(layoutMode === 'typed' || layoutMode === 'choice' || layoutMode === 'draw'
        ? { answer_field: effectiveAnswer }
        : {}),
      ...(layoutMode === 'cloze' && clozeTyped ? { cloze_typed: true } : {}),
    };
    onAddLayout(newLayout, deck.id);
    setLayoutName('');
  };

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-[var(--border)] pt-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">New cards / day</span>
          <input
            type="number"
            min={0}
            max={999}
            value={newPerDayDraft}
            onChange={(e) => {
              setNewPerDayDraft(e.target.value);
              const v = Number(e.target.value);
              if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 999) {
                onUpdateSettings(deck.id, { settings: { new_cards_per_day: Math.round(v) } });
              }
            }}
            onBlur={commitNewPerDay}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">Max reviews / day</span>
          <input
            type="number"
            min={1}
            max={9999}
            value={maxRevDraft}
            onChange={(e) => {
              setMaxRevDraft(e.target.value);
              const v = Number(e.target.value);
              if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= 1 && v <= 9999) {
                onUpdateSettings(deck.id, { settings: { max_reviews_per_day: Math.round(v) } });
              }
            }}
            onBlur={commitMaxRev}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">Target retention (0.70–0.99)</span>
          <input
            type="number"
            step={0.01}
            min={0.7}
            max={0.99}
            aria-label="Target retention"
            value={retentionDraft}
            onChange={(e) => setRetentionDraft(e.target.value)}
            onBlur={commitRetention}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitRetention();
              }
            }}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">New card order</span>
          <select
            value={deck.settings.new_card_order}
            onChange={(e) =>
              onUpdateSettings(deck.id, {
                settings: { new_card_order: e.target.value as NewCardOrder },
              })
            }
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
          >
            <option value="source">Source order</option>
            <option value="random">Random (daily)</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">New study day starts at</span>
          <select
            aria-label="Deck day start hour"
            data-testid={`deck-day-start-${deck.id}`}
            value={
              deck.settings.day_start_hour !== undefined &&
              deck.settings.day_start_hour >= 0 &&
              deck.settings.day_start_hour <= 23
                ? String(deck.settings.day_start_hour)
                : 'default'
            }
            onChange={(e) =>
              onUpdateSettings(deck.id, {
                settings: {
                  // LWW settings can't be unset, so -1 means "use the collection default".
                  day_start_hour: e.target.value === 'default' ? -1 : Number(e.target.value),
                },
              })
            }
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
          >
            <option value="default">
              Collection default ({String(state.preferences.day_start_hour).padStart(2, '0')}:00)
            </option>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={String(h)}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          data-testid={`reschedule-deck-${deck.id}`}
          onClick={() => {
            if (
              typeof window !== 'undefined' &&
              !window.confirm(
                `Reschedule every card in "${deck.name}" using the current target retention (${deck.settings.target_retention})? Past review history is kept; only due dates are recalculated.`,
              )
            ) {
              return;
            }
            rescheduleDeck(deck.id);
            setRescheduleStatus('Existing cards rescheduled with the current weights.');
          }}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 font-medium hover:bg-[var(--surface-2)]"
        >
          Reschedule existing cards with new weights
        </button>
        <span className="text-[var(--muted)]">
          {rescheduleStatus ??
            'Retention changes apply to future reviews only unless you reschedule.'}
        </span>
      </div>

      {/* Add Answer Mode Layout (§5.2) */}
      <form
        onSubmit={handleCreateLayout}
        data-testid={`add-layout-form-${deck.id}`}
        className="flex flex-wrap items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
      >
        <div className="w-full text-xs font-semibold text-[var(--fg)]">Add Answer Mode Layout</div>
        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          <span>Mode</span>
          <select
            aria-label="Answer mode"
            value={layoutMode}
            onChange={(e) => {
              const next = e.target.value as AnswerMode;
              setLayoutMode(next);
              if (next === 'draw') {
                const meaningKey = textFields.find((f) => f.key === 'meaning')?.key;
                const targetKey = textFields.find(
                  (f) => f.key === 'word' || f.key === 'character',
                )?.key;
                if (meaningKey) setFrontFieldKey(meaningKey);
                if (targetKey) setAnswerFieldKey(targetKey);
                setSpeakOn('reveal');
              }
            }}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
          >
            <option value="typed">Typed Answer</option>
            <option value="choice">Multiple Choice (4)</option>
            <option value="cloze">Cloze Deletion</option>
            <option value="listen">Listen (Audio Prompt)</option>
            <option value="draw">Draw (Stroke Practice)</option>
            <option value="flip">Flip</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          <span>Label</span>
          <input
            type="text"
            aria-label="Layout label"
            placeholder={layoutMode}
            value={layoutName}
            onChange={(e) => setLayoutName(e.target.value)}
            className="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
          />
        </label>

        {textFields.length > 0 && (
          <>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
              <span>Prompt field</span>
              <select
                aria-label="Prompt field"
                value={frontFieldKey}
                onChange={(e) => setFrontFieldKey(e.target.value)}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
              >
                {textFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>

            {(layoutMode === 'typed' || layoutMode === 'choice' || layoutMode === 'draw') && (
              <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
                <span>Answer field</span>
                <select
                  aria-label="Answer field"
                  value={answerFieldKey}
                  onChange={(e) => setAnswerFieldKey(e.target.value)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
                >
                  {textFields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
              <span>Speak field</span>
              <select
                aria-label="Speak field"
                value={speakFieldKey}
                onChange={(e) => setSpeakFieldKey(e.target.value)}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
              >
                {textFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>

            {layoutMode !== 'listen' && (
              <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
                <span>Auto-speak</span>
                <select
                  aria-label="Auto-speak"
                  value={speakOn}
                  onChange={(e) => setSpeakOn(e.target.value as SpeakTiming)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
                >
                  <option value="front">Front</option>
                  <option value="reveal">On reveal</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
            )}
          </>
        )}

        {layoutMode === 'cloze' && (
          <label className="flex items-center gap-1.5 pb-1 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              checked={clozeTyped}
              onChange={(e) => setClozeTyped(e.target.checked)}
            />
            <span>Type blanks</span>
          </label>
        )}

        <button
          type="submit"
          data-testid={`add-layout-submit-${deck.id}`}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
        >
          + Add Layout
        </button>
      </form>

      {/* Per-Deck Offline Stroke Cache (§6.4) */}
      {deckHasDraw && strokeCoverage && strokeCoverage.total > 0 && (
        <div
          data-testid={`deck-stroke-cache-${deck.id}`}
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs"
        >
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-[var(--fg)]">
              Offline Drawing Strokes (
              {strokeCoverage.script === 'ja' ? 'JA · KanjiVG' : 'ZH · Make Me a Hanzi'})
            </span>
            <span data-testid="deck-stroke-coverage" className="text-[11px] text-[var(--muted)]">
              {strokeCoverage.cached} / {strokeCoverage.total} unique characters cached offline
              {precacheStatus ? ` · ${precacheStatus}` : ''}
            </span>
          </div>
          <button
            type="button"
            data-testid="precache-deck-strokes-btn"
            disabled={precachingStrokes}
            onClick={() => void handlePrecacheDeckStrokes()}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)] disabled:opacity-40"
          >
            {precachingStrokes ? 'Pre-caching…' : 'Pre-cache Strokes'}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onExportDeck(deck)}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--surface-2)]"
        >
          Export Deck (.flashpkg)
        </button>
        {deck.source?.kind === 'google_sheets' &&
          deck.source.uri?.startsWith('https://docs.google.com/spreadsheets/') && (
            <a
              href={deck.source.uri}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--surface-2)]"
            >
              Open Source Sheet ↗
            </a>
          )}
        <button
          type="button"
          data-testid={`archive-deck-btn-${deck.id}`}
          onClick={() => onArchiveDeck(deck)}
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-500/20 dark:text-rose-400"
        >
          Archive Deck
        </button>
      </div>
    </div>
  );
}

export interface LibraryScreenProps {
  onStudyDeck: (deckId: string) => void;
}

export function LibraryScreen({ onStudyDeck }: LibraryScreenProps) {
  const {
    platform,
    state,
    stateVersion,
    entitlement,
    emitEvents,
    getEventFactory,
    createDeck,
    updateDeckSettings,
    toggleDeckLayout,
    upsertLayout,
    upsertPage,
    markBackupCompleted,
  } = useApp();

  const [expandedDeckId, setExpandedDeckId] = useState<string | null>(null);
  const [showArchivedDecks, setShowArchivedDecks] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckNoteTypeId, setNewDeckNoteTypeId] = useState('preset:vocab-ko');
  const [newDeckLang, setNewDeckLang] = useState('ko');
  const [csvTargetDeckId, setCsvTargetDeckId] = useState('');
  const [csvPaste, setCsvPaste] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Lazy Lesson Page Viewer / Editor modal-like view state
  const [viewingPageId, setViewingPageId] = useState<string | null>(null);
  const [editingPage, setEditingPage] = useState<Page | 'new' | null>(null);

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const archivedDecks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => d.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const pages = useMemo(
    () => [...state.pages.values()].sort((a, b) => a.title.localeCompare(b.title)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const noteTypes = useMemo(
    () => [...state.noteTypes.values()],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const nowMs = Date.now();
  const tzOffsetMinutes = -new Date(nowMs).getTimezoneOffset();

  const effectiveCsvDeckId = csvTargetDeckId || decks[0]?.id || '';

  const viewingPage = viewingPageId ? state.pages.get(viewingPageId) : undefined;

  const collectMediaBlobs = async (): Promise<Map<string, Uint8Array>> => {
    const map = new Map<string, Uint8Array>();
    for (const hash of state.media.keys()) {
      const blob = await platform.storage.getMedia(hash);
      if (blob) {
        map.set(hash, blob.bytes);
      }
    }
    return map;
  };

  const handleCreateDeck = (e: FormEvent) => {
    e.preventDefault();
    if (!newDeckName.trim()) return;
    const gate = canCreateOrImportDeck(decks.length, entitlement);
    if (!gate.allowed) {
      setErrorMessage(gate.reason ?? 'Free tier deck limit reached.');
      return;
    }
    const id = createDeck(newDeckName, newDeckNoteTypeId, newDeckLang);
    setNewDeckName('');
    setCsvTargetDeckId(id);
    setStatusMessage(`Created deck "${newDeckName.trim()}".`);
    setErrorMessage(null);
  };

  const handleArchiveDeck = (deck: Deck) => {
    updateDeckSettings(deck.id, { archived: true });
    if (expandedDeckId === deck.id) setExpandedDeckId(null);
    if (csvTargetDeckId === deck.id) setCsvTargetDeckId('');
    setStatusMessage(`Archived deck "${deck.name}". Reviews remain safely preserved.`);
    setErrorMessage(null);
  };

  const handleRestoreDeck = (deck: Deck) => {
    const gate = canCreateOrImportDeck(decks.length, entitlement);
    if (!gate.allowed) {
      setErrorMessage(gate.reason ?? 'Free tier deck limit reached.');
      return;
    }
    updateDeckSettings(deck.id, { archived: false });
    setStatusMessage(`Restored deck "${deck.name}" with full review history.`);
    setErrorMessage(null);
  };

  const runCsvImport = async (csvText: string, deckId: string) => {
    const deck = state.decks.get(deckId);
    if (!deck) {
      setErrorMessage('Select or create a deck before importing CSV/TSV.');
      return;
    }
    const noteType = state.noteTypes.get(deck.note_type_id);
    if (!noteType) {
      setErrorMessage('Deck note type not found.');
      return;
    }
    const { buildEventsFromCsv } = await import('@flash/core/csv');
    const result = buildEventsFromCsv(csvText, {
      deckId: deck.id,
      noteType,
      eventFactory: getEventFactory(),
    });
    if (result.events.length > 0) {
      emitEvents(result.events);
    }
    const warnSuffix = result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : '';
    setStatusMessage(`Imported ${result.importedCount} note(s) into "${deck.name}"${warnSuffix}.`);
    setErrorMessage(null);
  };

  const handleImportCsvFile = async () => {
    try {
      const picked = await platform.files.pickFile({ accept: '.csv,.tsv,.txt' });
      if (!picked) return;
      const text = decodeUtf8(picked.bytes);
      let targetDeckId = effectiveCsvDeckId;
      if (!targetDeckId) {
        const gate = canCreateOrImportDeck(decks.length, entitlement);
        if (!gate.allowed) {
          setErrorMessage(gate.reason ?? 'Free tier deck limit reached.');
          return;
        }
        const baseName = picked.name.replace(/\.(csv|tsv|txt)$/i, '');
        targetDeckId = createDeck(baseName || 'Imported Deck', newDeckNoteTypeId, newDeckLang);
      }
      await runCsvImport(text, targetDeckId);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportCsvPaste = async (e: FormEvent) => {
    e.preventDefault();
    if (!csvPaste.trim()) return;
    try {
      await runCsvImport(csvPaste, effectiveCsvDeckId);
      setCsvPaste('');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportFlashpkg = async () => {
    try {
      const picked = await platform.files.pickFile({ accept: '.flashpkg,.zip' });
      if (!picked) return;
      const { importFlashpkg } = await import('@flash/core/flashpkg');
      const result = importFlashpkg(picked.bytes, state, getEventFactory());
      const netNewDecks = Math.max(0, result.decksImported - result.upgradedDecks);
      if (netNewDecks > 0) {
        const gate = canCreateOrImportDeck(decks.length + netNewDecks - 1, entitlement);
        if (!gate.allowed) {
          setErrorMessage(gate.reason ?? 'Free tier deck limit reached.');
          return;
        }
      }
      for (const media of result.extractedMedia) {
        await platform.storage.putMedia({
          hash: media.hash,
          mime: media.mime,
          bytes: media.bytes,
        });
      }
      if (result.events.length > 0) {
        emitEvents(result.events);
      }
      setStatusMessage(
        `Imported "${result.manifest.name}" (${result.decksImported} deck(s), ${result.notesImported} note(s), ${result.pagesImported} page(s), ${result.upgradedDecks} upgraded).`,
      );
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(describeImportError(err));
    }
  };

  const handleExportDeck = async (deck: Deck) => {
    try {
      const { exportFlashpkg } = await import('@flash/core/flashpkg');
      const mediaBlobs = await collectMediaBlobs();
      const bytes = exportFlashpkg(state, { deckId: deck.id, name: deck.name, mediaBlobs });
      const slug =
        deck.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'deck';
      await platform.files.downloadFile(`${slug}.flashpkg`, bytes, 'application/zip');
      await markBackupCompleted();
      setStatusMessage(`Exported "${deck.name}" as ${slug}.flashpkg.`);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExportScoped = async (
    scope: { pageId: string } | { courseId: string },
    label: string,
  ) => {
    try {
      const { exportFlashpkg } = await import('@flash/core/flashpkg');
      const mediaBlobs = await collectMediaBlobs();
      const bytes = exportFlashpkg(state, { ...scope, name: label, mediaBlobs });
      const slug =
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || ('pageId' in scope ? 'page' : 'course');
      await platform.files.downloadFile(`${slug}.flashpkg`, bytes, 'application/zip');
      setStatusMessage(`Exported "${label}" as ${slug}.flashpkg.`);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExportAll = async () => {
    try {
      const { exportFlashpkg } = await import('@flash/core/flashpkg');
      const mediaBlobs = await collectMediaBlobs();
      const bytes = exportFlashpkg(state, {
        name: 'Flashcards Collection Backup',
        mediaBlobs,
      });
      const dateStamp = new Date().toISOString().slice(0, 10);
      await platform.files.downloadFile(
        `flashcards-backup-${dateStamp}.flashpkg`,
        bytes,
        'application/zip',
      );
      await markBackupCompleted();
      setStatusMessage(`Exported full collection backup (${decks.length} deck(s)).`);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  // Active Lesson Page Editor or Reader (strictly lazy-loaded)
  if (editingPage !== null) {
    return (
      <section className="flex flex-col gap-4">
        <Suspense
          fallback={
            <div className="py-12 text-center text-sm text-[var(--muted)]">Loading editor…</div>
          }
        >
          <LazyPageEditor
            initialPage={editingPage === 'new' ? null : editingPage}
            onSave={(input) => {
              const savedId = upsertPage(input);
              setEditingPage(null);
              setViewingPageId(savedId);
              setStatusMessage(`Saved lesson page "${input.title}".`);
            }}
            onCancel={() => setEditingPage(null)}
          />
        </Suspense>
      </section>
    );
  }

  if (viewingPage) {
    return (
      <section className="flex flex-col gap-4">
        <Suspense
          fallback={
            <div className="py-12 text-center text-sm text-[var(--muted)]">Loading lesson…</div>
          }
        >
          <LazyPageViewer
            page={viewingPage}
            onBack={() => setViewingPageId(null)}
            onEdit={(p) => setEditingPage(p)}
            onStudyDeck={onStudyDeck}
          />
        </Suspense>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Library</h1>
          <p className="text-xs text-[var(--muted)]">
            Manage decks, answer-mode layouts, courses, lesson pages, and offline files.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="import-csv-btn"
            onClick={() => void handleImportCsvFile()}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]"
          >
            Import CSV/TSV
          </button>
          <button
            type="button"
            data-testid="import-flashpkg-btn"
            onClick={() => void handleImportFlashpkg()}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]"
          >
            Import .flashpkg
          </button>
          <button
            type="button"
            data-testid="export-collection-btn"
            onClick={() => void handleExportAll()}
            disabled={decks.length === 0}
            className="rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            Export Backup (.flashpkg)
          </button>
        </div>
      </div>

      {statusMessage && (
        <div
          role="status"
          data-testid="library-status"
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 whitespace-pre-line text-sm text-rose-700 dark:text-rose-300"
        >
          {errorMessage}
        </div>
      )}

      {/* Phase 3 Sources & Subscriptions */}
      <SourcesPanel
        onStatusMessage={(msg) => {
          setStatusMessage(msg);
          setErrorMessage(null);
        }}
        onErrorMessage={(msg) => setErrorMessage(msg)}
      />

      {/* Deck List */}
      <div className="flex flex-col gap-3">
        {decks.map((deck) => {
          const queue = buildStudyQueue(state, { deckId: deck.id, nowMs, tzOffsetMinutes });
          const noteCount = [...state.notes.values()].filter(
            (n) => n.deck_id === deck.id && !n.archived,
          ).length;
          const deckLayouts = [...state.layouts.values()].filter(
            (l) => l.note_type_id === deck.note_type_id,
          );
          const enabledIds = new Set(getEnabledLayoutsForDeck(state, deck).map((l) => l.id));
          const isExpanded = expandedDeckId === deck.id;

          return (
            <div
              key={deck.id}
              data-testid={`deck-row-${deck.id}`}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-base font-semibold">{deck.name}</h2>
                    <span className="rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted)]">
                      {deck.language}
                    </span>
                    {deck.source && deck.source.kind !== 'native' && (
                      <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                        {deck.source.kind === 'google_sheets'
                          ? 'Google Sheet'
                          : deck.source.kind === 'local_file'
                            ? 'Local Folder'
                            : deck.source.kind === 'package_url'
                              ? `Subscribed${deck.source.package_version ? ` v${deck.source.package_version}` : ''}`
                              : 'Package'}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
                    <span>{noteCount} notes</span>
                    <span className="text-sky-600 dark:text-sky-400">{queue.counts.new} new</span>
                    <span className="text-amber-600 dark:text-amber-400">
                      {queue.counts.learning} learning
                    </span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {queue.counts.due} due
                    </span>
                  </div>
                </div>

                {/* 1-tap Layout toggles (Recognition, Production, custom Typed/Choice/Cloze/Listen) */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {deckLayouts.map((layout) => {
                    const active = enabledIds.has(layout.id);
                    return (
                      <button
                        key={layout.id}
                        type="button"
                        aria-pressed={active}
                        data-testid={`layout-toggle-${deck.id}-${layout.name.toLowerCase()}`}
                        onClick={() => toggleDeckLayout(deck.id, layout.id)}
                        className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-2)]'
                        }`}
                      >
                        {layout.name}
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => onStudyDeck(deck.id)}
                    className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                  >
                    Study
                  </button>

                  <button
                    type="button"
                    onClick={() => setExpandedDeckId(isExpanded ? null : deck.id)}
                    className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--muted)] hover:bg-[var(--surface-2)]"
                  >
                    {isExpanded ? 'Hide' : 'Options'}
                  </button>
                </div>
              </div>

              {isExpanded && (
                <DeckOptionsPanel
                  deck={deck}
                  noteType={state.noteTypes.get(deck.note_type_id)}
                  onUpdateSettings={updateDeckSettings}
                  onExportDeck={(d) => void handleExportDeck(d)}
                  onArchiveDeck={handleArchiveDeck}
                  onAddLayout={(layout, dId) => {
                    upsertLayout(layout, dId);
                    setStatusMessage(`Added "${layout.name}" (${layout.answer_mode}) layout.`);
                  }}
                />
              )}
            </div>
          );
        })}

        {archivedDecks.length > 0 && (
          <div
            data-testid="archived-decks-panel"
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3"
          >
            <button
              type="button"
              data-testid="toggle-archived-decks-btn"
              aria-expanded={showArchivedDecks}
              onClick={() => setShowArchivedDecks((prev) => !prev)}
              className="flex w-full items-center justify-between text-left text-xs font-semibold text-[var(--muted)] hover:text-[var(--fg)]"
            >
              <span>Archived Decks ({archivedDecks.length})</span>
              <span>{showArchivedDecks ? 'Hide' : 'Show'}</span>
            </button>
            {showArchivedDecks && (
              <div className="mt-2.5 flex flex-col gap-2">
                {archivedDecks.map((deck) => (
                  <div
                    key={deck.id}
                    data-testid={`archived-deck-row-${deck.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[var(--fg)]">{deck.name}</span>
                      <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                        {deck.language}
                      </span>
                    </div>
                    <button
                      type="button"
                      data-testid={`restore-deck-btn-${deck.id}`}
                      onClick={() => handleRestoreDeck(deck)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-semibold text-[var(--fg)] hover:bg-[var(--surface-2)]"
                    >
                      Restore Deck
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Phase 4 Courses (§2.3) */}
      <CoursesPanel
        onOpenPage={(pageId) => {
          if (state.pages.has(pageId)) {
            setViewingPageId(pageId);
          }
        }}
        onStudyDeck={onStudyDeck}
        onExportCourse={(course) => void handleExportScoped({ courseId: course.id }, course.name)}
      />

      {/* Phase 4 Lesson Pages (§2.3) */}
      <section
        data-testid="pages-panel"
        className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Lesson Pages ({pages.length})</h2>
            <p className="text-xs text-[var(--muted)]">
              Markdown grammar guides with ruby, audio prompts, examples, and inline study cards.
            </p>
          </div>
          <button
            type="button"
            data-testid="new-page-btn"
            onClick={() => setEditingPage('new')}
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
          >
            + New Page
          </button>
        </div>

        {pages.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">No lesson pages yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {pages.map((page) => (
              <div
                key={page.id}
                data-testid={`page-row-${page.slug}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold">{page.title}</span>
                    {page.lang && (
                      <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                        {page.lang}
                      </span>
                    )}
                    {page.read_at !== undefined && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                        Read ✓
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    data-testid={`open-page-${page.slug}`}
                    onClick={() => setViewingPageId(page.id)}
                    className="rounded-lg bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white hover:opacity-90"
                  >
                    Read
                  </button>
                  <button
                    type="button"
                    data-testid={`edit-page-${page.slug}`}
                    onClick={() => setEditingPage(page)}
                    className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    data-testid={`export-page-${page.slug}`}
                    onClick={() => void handleExportScoped({ pageId: page.id }, page.title)}
                    className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
                  >
                    Export
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Create Deck & Quick CSV/TSV Paste */}
      <div className="grid gap-4 md:grid-cols-2">
        <form
          onSubmit={handleCreateDeck}
          className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <h2 className="text-sm font-semibold">Create New Deck</h2>
          <input
            type="text"
            placeholder="Deck name (e.g., TOPIK II Verbs)"
            value={newDeckName}
            onChange={(e) => setNewDeckName(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              aria-label="Note type"
              value={newDeckNoteTypeId}
              onChange={(e) => setNewDeckNoteTypeId(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-xs"
            >
              {noteTypes.map((nt) => (
                <option key={nt.id} value={nt.id}>
                  {nt.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Primary language"
              value={newDeckLang}
              onChange={(e) => setNewDeckLang(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-xs"
            >
              <option value="ko">Korean (ko)</option>
              <option value="ja">Japanese (ja)</option>
              <option value="zh-Hans">Mandarin (zh-Hans)</option>
              <option value="en">English (en)</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={!newDeckName.trim()}
            className="rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            Create Deck
          </button>
        </form>

        <form
          onSubmit={(e) => void handleImportCsvPaste(e)}
          className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Paste CSV / TSV</h2>
            {decks.length > 0 && (
              <select
                aria-label="Target deck for CSV paste"
                value={effectiveCsvDeckId}
                onChange={(e) => setCsvTargetDeckId(e.target.value)}
                className="max-w-[11rem] truncate rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
              >
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <textarea
            rows={3}
            data-testid="csv-paste-input"
            placeholder={'Word,Meaning,Tags\n감사합니다,thank you,polite'}
            value={csvPaste}
            onChange={(e) => setCsvPaste(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs"
          />
          <button
            type="submit"
            data-testid="csv-paste-submit"
            disabled={!csvPaste.trim() || !effectiveCsvDeckId}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
          >
            Import Pasted Rows
          </button>
        </form>
      </div>
    </section>
  );
}
