import {
  buildStudyQueue,
  decodeUtf8,
  getEnabledLayoutsForDeck,
  type Deck,
  type NewCardOrder,
} from '@flash/core';
import { useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../state/AppContext.tsx';

export interface LibraryScreenProps {
  onStudyDeck: (deckId: string) => void;
}

export function LibraryScreen({ onStudyDeck }: LibraryScreenProps) {
  const {
    platform,
    state,
    stateVersion,
    emitEvents,
    getEventFactory,
    createDeck,
    updateDeckSettings,
    toggleDeckLayout,
    markBackupCompleted,
  } = useApp();

  const [expandedDeckId, setExpandedDeckId] = useState<string | null>(null);
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckNoteTypeId, setNewDeckNoteTypeId] = useState('preset:vocab-ko');
  const [newDeckLang, setNewDeckLang] = useState('ko');
  const [csvTargetDeckId, setCsvTargetDeckId] = useState('');
  const [csvPaste, setCsvPaste] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
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

  const handleCreateDeck = (e: FormEvent) => {
    e.preventDefault();
    if (!newDeckName.trim()) return;
    const id = createDeck(newDeckName, newDeckNoteTypeId, newDeckLang);
    setNewDeckName('');
    setCsvTargetDeckId(id);
    setStatusMessage(`Created deck "${newDeckName.trim()}".`);
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
      if (result.events.length > 0) {
        emitEvents(result.events);
      }
      setStatusMessage(
        `Imported "${result.manifest.name}" (${result.decksImported} deck(s), ${result.notesImported} note(s), ${result.upgradedDecks} upgraded).`,
      );
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExportDeck = async (deck: Deck) => {
    try {
      const { exportFlashpkg } = await import('@flash/core/flashpkg');
      const bytes = exportFlashpkg(state, { deckId: deck.id, name: deck.name });
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

  const handleExportAll = async () => {
    try {
      const { exportFlashpkg } = await import('@flash/core/flashpkg');
      const bytes = exportFlashpkg(state, { name: 'Flashcards Collection Backup' });
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

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Library</h1>
          <p className="text-xs text-[var(--muted)]">
            Manage decks, toggle Recognition/Production layouts, and import or export offline files.
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
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-700 dark:text-rose-300"
        >
          {errorMessage}
        </div>
      )}

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
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold">{deck.name}</h2>
                    <span className="rounded-md bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted)]">
                      {deck.language}
                    </span>
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

                {/* 1-tap Recognition / Production layout toggles */}
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
                <div className="mt-4 grid gap-3 border-t border-[var(--border)] pt-4 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-[var(--muted)]">New cards / day</span>
                    <input
                      type="number"
                      min={0}
                      max={999}
                      value={deck.settings.new_cards_per_day}
                      onChange={(e) =>
                        updateDeckSettings(deck.id, {
                          settings: { new_cards_per_day: Math.max(0, Number(e.target.value)) },
                        })
                      }
                      className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-[var(--muted)]">Max reviews / day</span>
                    <input
                      type="number"
                      min={1}
                      max={9999}
                      value={deck.settings.max_reviews_per_day}
                      onChange={(e) =>
                        updateDeckSettings(deck.id, {
                          settings: { max_reviews_per_day: Math.max(1, Number(e.target.value)) },
                        })
                      }
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
                      value={deck.settings.target_retention}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (val >= 0.7 && val <= 0.99) {
                          updateDeckSettings(deck.id, { settings: { target_retention: val } });
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
                        updateDeckSettings(deck.id, {
                          settings: { new_card_order: e.target.value as NewCardOrder },
                        })
                      }
                      className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
                    >
                      <option value="source">Source order</option>
                      <option value="random">Random (daily)</option>
                    </select>
                  </label>

                  <div className="flex items-end sm:col-span-2 lg:col-span-4">
                    <button
                      type="button"
                      onClick={() => void handleExportDeck(deck)}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--surface-2)]"
                    >
                      Export Deck (.flashpkg)
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

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
