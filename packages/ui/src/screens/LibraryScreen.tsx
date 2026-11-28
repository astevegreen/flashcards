import {
  buildStudyQueue,
  compareCodeUnits,
  deckLanguageOffer,
  getDeckDescription,
  getDeckFolder,
  getDeckOrganization,
  getDeckPreset,
  getEnabledLayoutsForDeck,
  listDeckFolders,
  listDeckPresets,
  uuidv7,
  type AnswerMode,
  type RubyDisplay,
  type Deck,
  type DeckSettings,
  type Layout,
  type NewCardOrder,
  type NoteType,
  type Page,
  type SpeakTiming,
  deckNoteType,
  noteField,
} from '@flash/core';
import { canCreateOrImportDeck } from '@flash/core/license';
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { CoursesPanel } from '../components/CoursesPanel.tsx';
import { describeImportError } from '../components/describeImportError.ts';
import { LayoutRequiredFieldList } from '../library/LayoutRequiredFieldList.tsx';
import { RubyDisplaySelect } from '../library/RubyDisplaySelect.tsx';
import { DeckDescriptionField, DeckOverview } from '../library/DeckDescription.tsx';
import { DeckOrganizationPanel } from '../library/DeckOrganizationPanel.tsx';
import { IMPORT_EXPORT_PANEL_HEIGHT } from '../library/import-export-layout.ts';
import type { ImportExportTab } from '../library/ImportExportPanel.tsx';
import DeckLanguageOffer, { type DeckLanguageChange } from '../library/DeckLanguageOffer.tsx';
import { runPresetCatchUp } from '../library/presetCatchUp.ts';
import { useDeckOrganization } from '../library/useDeckOrganization.ts';
import { setStudyFilter } from '../study/filterStore.ts';
import { useActiveLanguages } from '../state/useActiveLanguages.ts';
import { SourcesPanel } from '../components/SourcesPanel.tsx';
import { isExportCancelled } from '../export/exportCancelled.ts';
import { useApp } from '../state/AppContext.tsx';
import { useLibraryActions } from '../state/libraryActions.ts';
import { useSyncState } from '../state/syncStateStore.ts';
import { importFlashpkgBytes, type LibraryImportContext } from '../import/libraryImports.ts';

const LazyPageViewer = lazyWithRetry(() => import('../pages/PageViewer.tsx'), {
  closeWith: 'onBack',
});
const LazyPageEditor = lazyWithRetry(() => import('../pages/PageEditor.tsx'), {
  closeWith: 'onCancel',
});
const LazyFsrsOptimizerPanel = lazyWithRetry(() => import('../fsrs/FsrsOptimizerPanel.tsx'));
const LazyImportExportPanel = lazyWithRetry(() => import('../library/ImportExportPanel.tsx'));

/** Furigana only exists in Japanese text, so only Japanese decks hide it on the front by default. */
/** The device clock and its local time-zone offset, as `buildStudyQueue` takes them. */
function readLocalClock(): { nowMs: number; tzOffsetMinutes: number } {
  const nowMs = Date.now();
  return { nowMs, tzOffsetMinutes: -new Date(nowMs).getTimezoneOffset() };
}

function isJapaneseLanguage(language: string): boolean {
  const norm = language.toLowerCase();
  return norm === 'ja' || norm.startsWith('ja-');
}

function DeckOptionsPanel({
  deck,
  noteType,
  onUpdateSettings,
  onOpenDeckExport,
  onArchiveDeck,
  onAddLayout,
  onUpdateLayout,
}: {
  deck: Deck;
  noteType: NoteType | undefined;
  onUpdateSettings: (
    deckId: string,
    patch: { name?: string; archived?: boolean; settings?: Partial<DeckSettings> },
  ) => void;
  onOpenDeckExport: (deck: Deck) => void;
  onArchiveDeck: (deck: Deck) => void;
  onAddLayout: (layout: Layout, deckId: string) => void;
  onUpdateLayout: (layout: Layout) => void;
}) {
  const { platform, state, stateVersion } = useApp();
  const { rescheduleDeck } = useLibraryActions();
  const organize = useDeckOrganization();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const deckPreset = useMemo(() => getDeckPreset(state, deck.id), [state, stateVersion, deck.id]);
  const deckFolder = useMemo(
    () => getDeckFolder(state, deck.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, deck.id],
  );
  const presets = useMemo(
    () => listDeckPresets(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );
  const folders = useMemo(
    () => listDeckFolders(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const rubyLanguage = useActiveLanguages().hasFeature('ruby');
  const [rescheduleStatus, setRescheduleStatus] = useState<string | null>(null);
  const [newPerDayDraft, setNewPerDayDraft] = useState(String(deck.settings.new_cards_per_day));
  const [maxRevDraft, setMaxRevDraft] = useState(String(deck.settings.max_reviews_per_day));
  const [retentionDraft, setRetentionDraft] = useState(String(deck.settings.target_retention));
  // A limit that changes (a commit here, a sync, another tab) refills its draft during the render
  // that sees the new value; a limit that stays the same keeps whatever is being typed.
  const { new_cards_per_day, max_reviews_per_day, target_retention } = deck.settings;
  const [seenLimits, setSeenLimits] = useState({
    newPerDay: new_cards_per_day,
    maxRev: max_reviews_per_day,
    retention: target_retention,
  });
  if (
    seenLimits.newPerDay !== new_cards_per_day ||
    seenLimits.maxRev !== max_reviews_per_day ||
    seenLimits.retention !== target_retention
  ) {
    setSeenLimits({
      newPerDay: new_cards_per_day,
      maxRev: max_reviews_per_day,
      retention: target_retention,
    });
    if (seenLimits.newPerDay !== new_cards_per_day) setNewPerDayDraft(String(new_cards_per_day));
    if (seenLimits.maxRev !== max_reviews_per_day) setMaxRevDraft(String(max_reviews_per_day));
    if (seenLimits.retention !== target_retention) setRetentionDraft(String(target_retention));
  }

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
          const raw = noteField(note, targetField) ?? '';
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
        const raw = noteField(note, targetField) ?? '';
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

  const noteTypeLayouts = useMemo(
    () => [...state.layouts.values()].filter((l) => l.note_type_id === deck.note_type_id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion, deck.note_type_id],
  );

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
  const [rubyDisplay, setRubyDisplay] = useState<RubyDisplay>('both');

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
      hide_furigana_on_front:
        isJapaneseLanguage(deck.language) && layoutMode !== 'typed' && layoutMode !== 'draw',
      enabled: false,
      ...(rubyDisplay !== 'both' ? { ruby_display: rubyDisplay } : {}),
      ...(layoutMode === 'typed' || layoutMode === 'choice' || layoutMode === 'draw'
        ? { answer_field: effectiveAnswer }
        : {}),
      ...(layoutMode === 'cloze' && clozeTyped ? { cloze_typed: true } : {}),
    };
    onAddLayout(newLayout, deck.id);
    setLayoutName('');
    setRubyDisplay('both');
  };

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-[var(--border)] pt-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">Folder</span>
          <select
            aria-label="Deck folder"
            data-testid={`deck-folder-select-${deck.id}`}
            value={deckFolder?.id ?? ''}
            onChange={(e) => organize.setDeckFolder(deck.id, e.target.value || null)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
          >
            <option value="">No folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--muted)]">Options</span>
          <select
            aria-label="Deck options preset"
            data-testid={`deck-preset-select-${deck.id}`}
            value={deckPreset?.id ?? ''}
            onChange={(e) => organize.setDeckPreset(deck.id, e.target.value || null)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
          >
            <option value="">This deck’s own settings</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                Preset: {p.name}
              </option>
            ))}
          </select>
        </label>

        {!deckPreset && (
          <div className="flex items-end">
            <button
              type="button"
              data-testid={`save-as-preset-${deck.id}`}
              onClick={() => organize.createPreset(`${deck.name} options`, deck.id)}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--surface-2)]"
            >
              Save these settings as a preset
            </button>
          </div>
        )}
      </div>

      <DeckDescriptionField deck={deck} />

      {deckPreset && (
        <p
          data-testid={`deck-preset-summary-${deck.id}`}
          className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--muted)]"
        >
          Uses the preset “{deckPreset.name}”: {deckPreset.settings.new_cards_per_day} new cards and
          up to {deckPreset.settings.max_reviews_per_day} reviews a day for this deck, target
          retention {deckPreset.settings.target_retention}. Edit the preset under Folders and option
          presets.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {!deckPreset && (
          <>
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
          </>
        )}

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

      <Suspense fallback={null}>
        {deckPreset ? (
          <LazyFsrsOptimizerPanel preset={deckPreset} />
        ) : (
          <LazyFsrsOptimizerPanel deck={deck} />
        )}
      </Suspense>

      {(rubyLanguage || noteTypeLayouts.some((l) => l.ruby_display)) &&
        noteTypeLayouts.length > 0 && (
          <div
            data-testid={`layout-ruby-list-${deck.id}`}
            className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
          >
            <div className="text-xs font-semibold text-[var(--fg)]">Layouts: ruby display</div>
            {noteTypeLayouts.map((l) => (
              <label key={l.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-[var(--muted)]">
                  {l.name} ({l.answer_mode})
                </span>
                <RubyDisplaySelect
                  label={`Ruby shows for ${l.name}`}
                  value={l.ruby_display ?? 'both'}
                  onChange={(next) => onUpdateLayout({ ...l, ruby_display: next })}
                />
              </label>
            ))}
          </div>
        )}

      <LayoutRequiredFieldList
        deckId={deck.id}
        layouts={noteTypeLayouts}
        noteType={noteType}
        onUpdateLayout={onUpdateLayout}
      />

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

        {rubyLanguage && (
          <label className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
            <span>Ruby shows</span>
            <RubyDisplaySelect value={rubyDisplay} onChange={setRubyDisplay} />
          </label>
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
          data-testid={`export-deck-shortcut-${deck.id}`}
          onClick={() => onOpenDeckExport(deck)}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--surface-2)]"
        >
          Export…
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
  /** `undefined` = all decks (used by "Study folder", which also sets a Study filter). */
  onStudyDeck: (deckId: string | undefined) => void;
  /** Switches to the Words tab filtered to this deck. */
  onViewWords?: (deckId: string) => void;
  /** Opens the Import / Export panel on a specific tab when navigated here from Settings. */
  initialImportExport?: { tab: ImportExportTab; nonce: number };
}

export function LibraryScreen({
  onStudyDeck,
  onViewWords,
  initialImportExport,
}: Readonly<LibraryScreenProps>) {
  const {
    platform,
    state,
    stateVersion,
    entitlement,
    emitEvents,
    getEventFactory,
    updateDeckSettings,
    markBackupCompleted,
    meta,
  } = useApp();
  const { createDeck, toggleDeckLayout, upsertLayout, upsertPage } = useLibraryActions();
  const syncState = useSyncState();

  // Opening the Library copies every preset into any member deck that fell behind it (also run
  // after each sync, from AppContext). Once per visit; a read-only device writes nothing.
  const readOnly = syncState.readOnly;
  useEffect(() => {
    if (!readOnly) runPresetCatchUp(state, getEventFactory(), emitEvents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [expandedDeckId, setExpandedDeckId] = useState<string | null>(null);
  // Deck whose overview (description before study) is open.
  const [overviewDeckId, setOverviewDeckId] = useState<string | null>(null);
  // The deck language just set from the one-time offer, while its Undo is shown.
  const [languageChange, setLanguageChange] = useState<DeckLanguageChange | null>(null);
  const [showArchivedDecks, setShowArchivedDecks] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckNoteTypeId, setNewDeckNoteTypeId] = useState('preset:vocab-ko');
  const [newDeckLang, setNewDeckLang] = useState('ko');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [importExportPanel, setImportExportPanel] = useState<{
    open: boolean;
    tab: ImportExportTab;
    deckId?: string;
    nonce: number;
  }>(() =>
    initialImportExport
      ? { open: true, tab: initialImportExport.tab, nonce: initialImportExport.nonce }
      : { open: false, tab: 'import', nonce: 0 },
  );
  const importExportRef = useRef<HTMLDivElement | null>(null);

  // A new request from the shell (a share target, a menu entry) opens the panel on its tab during
  // the render that receives it.
  const [seenImportExport, setSeenImportExport] = useState(initialImportExport);
  if (seenImportExport !== initialImportExport) {
    setSeenImportExport(initialImportExport);
    if (initialImportExport) {
      setImportExportPanel({
        open: true,
        tab: initialImportExport.tab,
        nonce: initialImportExport.nonce,
      });
    }
  }

  const openDeckExport = (deck: Deck) => {
    setImportExportPanel((prev) => ({
      open: true,
      tab: 'export',
      deckId: deck.id,
      nonce: prev.nonce + 1,
    }));
    importExportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  // Lazy Lesson Page Viewer / Editor modal-like view state
  const [viewingPageId, setViewingPageId] = useState<string | null>(null);
  const [editingPage, setEditingPage] = useState<Page | 'new' | null>(null);

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const archivedDecks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => d.archived)
        .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const pages = useMemo(
    () =>
      [...state.pages.values()].sort(
        (a, b) => compareCodeUnits(a.title, b.title) || compareCodeUnits(a.id, b.id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const noteTypes = useMemo(
    () => [...state.noteTypes.values()],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  // Read on every render, as before: each render shows the due counts as of that moment.
  const { nowMs, tzOffsetMinutes } = readLocalClock();
  const queues = new Map(
    decks.map((d) => [d.id, buildStudyQueue(state, { deckId: d.id, nowMs, tzOffsetMinutes })]),
  );

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
    createDeck(newDeckName, newDeckNoteTypeId, newDeckLang);
    setNewDeckName('');
    setStatusMessage(`Created deck "${newDeckName.trim()}".`);
    setErrorMessage(null);
  };

  const handleArchiveDeck = (deck: Deck) => {
    updateDeckSettings(deck.id, { archived: true });
    if (expandedDeckId === deck.id) setExpandedDeckId(null);
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

  const importContext = (): LibraryImportContext => ({
    platform,
    state,
    entitlement,
    getEventFactory,
    emitEvents,
  });

  const handleImportFlashpkg = async () => {
    try {
      const picked = await platform.files.pickFile({ accept: '.flashpkg,.zip' });
      if (!picked) return;
      setStatusMessage(await importFlashpkgBytes(importContext(), picked.bytes));
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

  const handleExportDeckForAnki = async (deck: Deck) => {
    try {
      const { exportAnkiApkg } = await import('../export/ankiApkgExport.ts');
      setStatusMessage(await exportAnkiApkg(platform, state, { deckIds: [deck.id] }));
      setErrorMessage(null);
    } catch (err) {
      if (isExportCancelled(err)) {
        setStatusMessage('Export cancelled.');
        setErrorMessage(null);
        return;
      }
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
      // The same file as Settings > Export Backup: a `.flashpkg` any build imports, plus the
      // review history a restore needs, streamed to the file on native shells.
      const { saveFullBackupFile } = await import('../backups/backupRunner.ts');
      const dateStamp = new Date().toISOString().slice(0, 10);
      await saveFullBackupFile(platform, state, {
        deviceId: meta?.deviceId ?? platform.deviceId,
        ...(meta?.collectionId !== undefined ? { collectionId: meta.collectionId } : {}),
        fileName: `flashcards-backup-${dateStamp}.flashpkg`,
      });
      await markBackupCompleted();
      setStatusMessage(`Exported full collection backup (${decks.length} deck(s)).`);
      setErrorMessage(null);
    } catch (err) {
      if (isExportCancelled(err)) {
        setStatusMessage('Export cancelled.');
        setErrorMessage(null);
        return;
      }
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

  const renderDeckRow = (deck: Deck) => {
    const description = getDeckDescription(state, deck.id);
    const queue =
      queues.get(deck.id) ?? buildStudyQueue(state, { deckId: deck.id, nowMs, tzOffsetMinutes });
    const noteCount = [...state.notes.values()].filter(
      (n) => n.deck_id === deck.id && !n.archived,
    ).length;
    const deckLayouts = [...state.layouts.values()].filter(
      (l) => l.note_type_id === deck.note_type_id,
    );
    const enabledIds = new Set(getEnabledLayoutsForDeck(state, deck).map((l) => l.id));
    const isExpanded = expandedDeckId === deck.id;
    // A read-only device can't write the answer, so it is not asked.
    const languageOffer = readOnly ? undefined : deckLanguageOffer(state, deck);
    const changedLanguage = languageChange?.deckId === deck.id ? languageChange : undefined;

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
              <span className="text-emerald-600 dark:text-emerald-400">{queue.counts.due} due</span>
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
              aria-expanded={description ? overviewDeckId === deck.id : undefined}
              onClick={() => {
                // A deck with a description shows its overview first; others start at once.
                if (description) {
                  setOverviewDeckId((prev) => (prev === deck.id ? null : deck.id));
                } else {
                  onStudyDeck(deck.id);
                }
              }}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              Study
            </button>

            {onViewWords && (
              <button
                type="button"
                data-testid={`view-words-${deck.id}`}
                onClick={() => onViewWords(deck.id)}
                className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--surface-2)]"
              >
                View words
              </button>
            )}

            <button
              type="button"
              onClick={() => setExpandedDeckId(isExpanded ? null : deck.id)}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--muted)] hover:bg-[var(--surface-2)]"
            >
              {isExpanded ? 'Hide' : 'Options'}
            </button>
          </div>
        </div>

        {(languageOffer !== undefined || changedLanguage !== undefined) && (
          <DeckLanguageOffer
            deck={deck}
            offer={languageOffer}
            change={changedLanguage}
            onChanged={setLanguageChange}
            onClose={() => setLanguageChange(null)}
          />
        )}

        {description && overviewDeckId === deck.id && (
          <DeckOverview
            deck={deck}
            description={description}
            counts={queue.counts}
            onStart={() => {
              setOverviewDeckId(null);
              onStudyDeck(deck.id);
            }}
            onClose={() => setOverviewDeckId(null)}
          />
        )}

        {isExpanded && (
          <DeckOptionsPanel
            deck={deck}
            noteType={deckNoteType(state, deck)}
            onUpdateSettings={updateDeckSettings}
            onOpenDeckExport={openDeckExport}
            onArchiveDeck={handleArchiveDeck}
            onUpdateLayout={(layout) => upsertLayout(layout)}
            onAddLayout={(layout, dId) => {
              upsertLayout(layout, dId);
              setStatusMessage(`Added "${layout.name}" (${layout.answer_mode}) layout.`);
            }}
          />
        )}
      </div>
    );
  };

  const renderFolderSection = (
    key: string,
    title: string,
    folderDecks: readonly Deck[],
    folderId?: string,
  ) => {
    const totals = { new: 0, learning: 0, due: 0 };
    for (const d of folderDecks) {
      const counts = queues.get(d.id)?.counts;
      totals.new += counts?.new ?? 0;
      totals.learning += counts?.learning ?? 0;
      totals.due += counts?.due ?? 0;
    }
    return (
      <section
        key={key}
        data-testid={folderId ? `folder-section-${folderId}` : 'folder-section-none'}
        aria-label={title}
        className="flex flex-col gap-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{title}</h2>
            <span className="text-xs text-[var(--muted)]">
              {folderDecks.length} deck(s) · {totals.new} new · {totals.learning} learning ·{' '}
              {totals.due} due
            </span>
          </div>
          {folderId && folderDecks.length > 0 && (
            <button
              type="button"
              data-testid={`study-folder-${folderId}`}
              onClick={() => {
                // One session over the folder's decks, as a Study filter on "All decks".
                setStudyFilter({
                  label: title,
                  filter: { deckIds: folderDecks.map((d) => d.id) },
                  scope: { deckId: undefined },
                });
                onStudyDeck(undefined);
              }}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              Study folder
            </button>
          )}
        </div>
        {folderDecks.length === 0 ? (
          <p className="px-1 text-xs text-[var(--muted)]">
            No decks yet. Choose this folder in a deck’s Options.
          </p>
        ) : (
          folderDecks.map(renderDeckRow)
        )}
      </section>
    );
  };

  // One level of folders, for display and "Study folder" only. With no folders the list is flat.
  const renderDeckList = () => {
    const folders = listDeckFolders(state);
    if (folders.length === 0) return decks.map(renderDeckRow);
    const { folderByDeck } = getDeckOrganization(state);
    const unfiled = decks.filter((d) => !folderByDeck.has(d.id));
    return [
      ...folders.map((f) =>
        renderFolderSection(
          f.id,
          f.name,
          decks.filter((d) => folderByDeck.get(d.id) === f.id),
          f.id,
        ),
      ),
      ...(unfiled.length > 0 ? [renderFolderSection('none', 'Not in a folder', unfiled)] : []),
    ];
  };

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Decks</h1>
          <p className="text-xs text-[var(--muted)]">
            Your decks: create, organize, set options, import and export.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="import-export-btn"
            aria-expanded={importExportPanel.open}
            aria-controls="import-export-region"
            onClick={() =>
              setImportExportPanel((prev) => ({
                ...prev,
                open: !prev.open,
              }))
            }
            className="rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90"
          >
            Import / Export
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

      {/* Unified Import / Export panel: fixed height shared with Suspense fallback to prevent layout shift */}
      <div ref={importExportRef}>
        {importExportPanel.open && (
          <div id="import-export-region">
            <Suspense
              fallback={
                <div
                  data-testid="import-export-loading"
                  className={`rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--muted)] ${IMPORT_EXPORT_PANEL_HEIGHT}`}
                >
                  Loading Import / Export…
                </div>
              }
            >
              <LazyImportExportPanel
                initialTab={importExportPanel.tab}
                {...(importExportPanel.deckId !== undefined
                  ? { initialDeckId: importExportPanel.deckId }
                  : {})}
                requestNonce={importExportPanel.nonce}
                onClose={() => setImportExportPanel((prev) => ({ ...prev, open: false }))}
                onImportFlashpkg={handleImportFlashpkg}
                onExportAll={handleExportAll}
                onExportDeck={handleExportDeck}
                onExportDeckForAnki={
                  platform.getAnkiPackageReader ? handleExportDeckForAnki : undefined
                }
                onExportScoped={handleExportScoped}
                collectMediaBlobs={collectMediaBlobs}
                onStatus={(msg) => {
                  setStatusMessage(msg);
                  setErrorMessage(null);
                }}
                onError={(msg) => setErrorMessage(msg)}
              />
            </Suspense>
          </div>
        )}
      </div>

      {/* Phase 3 Sources & Subscriptions */}
      <SourcesPanel
        onStatusMessage={(msg) => {
          setStatusMessage(msg);
          setErrorMessage(null);
        }}
        onErrorMessage={(msg) => setErrorMessage(msg)}
      />

      <DeckOrganizationPanel />

      {/* Deck List */}
      <div className="flex flex-col gap-3">
        {renderDeckList()}

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

      {/* Create Deck (tables, pasted rows and files come in through Bring my cards) */}
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
      </div>
    </section>
  );
}
