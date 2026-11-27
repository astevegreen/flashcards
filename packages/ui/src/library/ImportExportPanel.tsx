import { compareCodeUnits, type Deck } from '@flash/core';
import { Suspense, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { lazyWithRetry } from '../lazy/lazyWithRetry.tsx';
import { useApp } from '../state/AppContext.tsx';
import { IMPORT_EXPORT_PANEL_HEIGHT } from './import-export-layout.ts';

const LazyBringMyCardsPanel = lazyWithRetry(() => import('../import/BringMyCardsPanel.tsx'));
const LazyAnkiImportPanel = lazyWithRetry(() => import('../import/AnkiImportPanel.tsx'));
const LazyCategoryExportPanel = lazyWithRetry(() => import('./CategoryExportPanel.tsx'));

export type ImportExportTab = 'import' | 'export';
type ImportFormat = 'csv' | 'flashpkg' | 'anki';

interface ImportExportPanelProps {
  initialTab?: ImportExportTab;
  initialDeckId?: string;
  /** Bumped by the host when re-targeting the panel (e.g. clicking Export… on a deck row). */
  requestNonce?: number;
  onClose?: () => void;
  onImportFlashpkg: () => Promise<void>;
  onExportAll: () => Promise<void>;
  onExportDeck: (deck: Deck) => Promise<void>;
  onExportDeckForAnki?: ((deck: Deck) => Promise<void>) | undefined;
  onExportScoped: (
    scope: { pageId: string } | { courseId: string },
    label: string,
  ) => Promise<void>;
  collectMediaBlobs: () => Promise<Map<string, Uint8Array>>;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
}

const SELECT_CLASS =
  'min-w-0 max-w-[16rem] truncate rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs';
const SECONDARY_BTN =
  'rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-40';
const PRIMARY_BTN =
  'rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40';

const IMPORT_FORMATS: ReadonlyArray<{ id: ImportFormat; label: string }> = [
  { id: 'csv', label: 'Spreadsheet / CSV' },
  { id: 'flashpkg', label: '.flashpkg' },
  { id: 'anki', label: 'Anki (.apkg)' },
];

function ImportExportPanel({
  initialTab = 'import',
  initialDeckId,
  requestNonce = 0,
  onClose,
  onImportFlashpkg,
  onExportAll,
  onExportDeck,
  onExportDeckForAnki,
  onExportScoped,
  collectMediaBlobs,
  onStatus,
  onError,
}: Readonly<ImportExportPanelProps>) {
  const { state, stateVersion } = useApp();
  const [tab, setTab] = useState<ImportExportTab>(initialTab);
  const [importFormat, setImportFormat] = useState<ImportFormat>('csv');
  const [deckChoice, setDeckChoice] = useState(initialDeckId ?? '');
  const [courseChoice, setCourseChoice] = useState('');
  const [pageChoice, setPageChoice] = useState('');

  const importTabRef = useRef<HTMLButtonElement | null>(null);
  const exportTabRef = useRef<HTMLButtonElement | null>(null);

  // A new open request (tab, deck or nonce) switches the panel in the same render.
  const [request, setRequest] = useState({ initialTab, initialDeckId, requestNonce });
  if (
    request.initialTab !== initialTab ||
    request.initialDeckId !== initialDeckId ||
    request.requestNonce !== requestNonce
  ) {
    setRequest({ initialTab, initialDeckId, requestNonce });
    setTab(initialTab);
    if (initialDeckId) {
      setDeckChoice(initialDeckId);
    }
  }

  const decks = useMemo(
    () =>
      [...state.decks.values()]
        .filter((d) => !d.archived)
        .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  const courses = useMemo(
    () =>
      [...state.courses.values()]
        .filter((c) => !c.archived)
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

  const selectedDeck = decks.find((d) => d.id === deckChoice) ?? decks[0];
  const selectedCourse = courses.find((c) => c.id === courseChoice) ?? courses[0];
  const selectedPage = pages.find((p) => p.id === pageChoice) ?? pages[0];

  const switchTab = (next: ImportExportTab, moveFocus: boolean) => {
    setTab(next);
    if (moveFocus) {
      (next === 'import' ? importTabRef : exportTabRef).current?.focus();
    }
  };

  const handleTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      switchTab(tab === 'import' ? 'export' : 'import', true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      switchTab('import', true);
    } else if (e.key === 'End') {
      e.preventDefault();
      switchTab('export', true);
    }
  };

  return (
    <section
      data-testid="import-export-panel"
      aria-label="Import / Export"
      className={`flex flex-col gap-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 ${IMPORT_EXPORT_PANEL_HEIGHT}`}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">Import / Export</h2>
          <div
            role="tablist"
            aria-label="Import or Export"
            onKeyDown={handleTabKeyDown}
            className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--bg)] p-0.5 text-xs font-semibold"
          >
            <button
              ref={importTabRef}
              id="import-export-tab-import"
              type="button"
              role="tab"
              aria-selected={tab === 'import'}
              aria-controls="import-export-panel-import"
              tabIndex={tab === 'import' ? 0 : -1}
              data-testid="import-export-tab-import"
              onClick={() => switchTab('import', false)}
              className={`rounded-lg px-3 py-1 transition-colors ${
                tab === 'import'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--fg)]'
              }`}
            >
              Import
            </button>
            <button
              ref={exportTabRef}
              id="import-export-tab-export"
              type="button"
              role="tab"
              aria-selected={tab === 'export'}
              aria-controls="import-export-panel-export"
              tabIndex={tab === 'export' ? 0 : -1}
              data-testid="import-export-tab-export"
              onClick={() => switchTab('export', false)}
              className={`rounded-lg px-3 py-1 transition-colors ${
                tab === 'export'
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--fg)]'
              }`}
            >
              Export
            </button>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            data-testid="import-export-close-btn"
            onClick={onClose}
            className={SECONDARY_BTN}
          >
            Close
          </button>
        )}
      </div>

      {tab === 'import' ? (
        <div
          id="import-export-panel-import"
          role="tabpanel"
          aria-labelledby="import-export-tab-import"
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          <div
            role="radiogroup"
            aria-label="Import format"
            className="flex shrink-0 flex-wrap gap-1.5"
          >
            {IMPORT_FORMATS.map((fmt) => {
              const active = importFormat === fmt.id;
              return (
                <button
                  key={fmt.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`import-mode-${fmt.id}`}
                  onClick={() => setImportFormat(fmt.id)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'border-[var(--border)] bg-[var(--bg)] text-[var(--muted)] hover:text-[var(--fg)]'
                  }`}
                >
                  {fmt.label}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {importFormat === 'csv' && (
              <Suspense
                fallback={
                  <div
                    data-testid="bring-my-cards-loading"
                    className="py-6 text-xs text-[var(--muted)]"
                  >
                    Loading spreadsheet import…
                  </div>
                }
              >
                <LazyBringMyCardsPanel embedded />
              </Suspense>
            )}

            {importFormat === 'flashpkg' && (
              <div
                data-testid="import-flashpkg-panel"
                className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4"
              >
                <div>
                  <h3 className="text-sm font-semibold">Import .flashpkg</h3>
                  <p className="text-xs text-[var(--muted)]">
                    Import a full backup, single deck, course, or lesson page saved as a .flashpkg
                    file.
                  </p>
                </div>
                <div>
                  <button
                    type="button"
                    data-testid="import-flashpkg-btn"
                    onClick={() => void onImportFlashpkg()}
                    className={PRIMARY_BTN}
                  >
                    Choose .flashpkg file…
                  </button>
                </div>
              </div>
            )}

            {importFormat === 'anki' && (
              <Suspense
                fallback={
                  <div
                    data-testid="anki-import-loading"
                    className="py-6 text-xs text-[var(--muted)]"
                  >
                    Loading Anki import…
                  </div>
                }
              >
                <LazyAnkiImportPanel embedded />
              </Suspense>
            )}
          </div>
        </div>
      ) : (
        <div
          id="import-export-panel-export"
          role="tabpanel"
          aria-labelledby="import-export-tab-export"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
        >
          {/* Full backup */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-xs font-semibold">Full backup (.flashpkg)</h3>
              <p className="text-[11px] text-[var(--muted)]">
                All decks, notes, layouts, courses, lesson pages, and review history in one file.
              </p>
            </div>
            <button
              type="button"
              data-testid="export-collection-btn"
              disabled={decks.length === 0}
              onClick={() => void onExportAll()}
              className={PRIMARY_BTN}
            >
              Export Backup (.flashpkg)
            </button>
          </div>

          {/* One deck (.flashpkg and Anki .apkg) */}
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
            <div>
              <h3 className="text-xs font-semibold">One deck</h3>
              <p className="text-[11px] text-[var(--muted)]">
                Share or back up a single deck as .flashpkg
                {onExportDeckForAnki ? ' or export it for Anki (.apkg).' : '.'}
              </p>
            </div>
            {decks.length === 0 ? (
              <p className="text-xs text-[var(--muted)]">No active decks to export.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Deck to export"
                  data-testid="export-deck-select"
                  value={selectedDeck?.id ?? ''}
                  onChange={(e) => setDeckChoice(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {decks.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="export-deck-btn"
                  disabled={!selectedDeck}
                  onClick={() => {
                    if (selectedDeck) void onExportDeck(selectedDeck);
                  }}
                  className={SECONDARY_BTN}
                >
                  Export Deck (.flashpkg)
                </button>
                {onExportDeckForAnki && (
                  <button
                    type="button"
                    data-testid="export-deck-anki-btn"
                    disabled={!selectedDeck}
                    onClick={() => {
                      if (selectedDeck) void onExportDeckForAnki(selectedDeck);
                    }}
                    className={SECONDARY_BTN}
                  >
                    Export for Anki (.apkg)
                  </button>
                )}
              </div>
            )}
          </div>

          {/* By tag / category */}
          <Suspense
            fallback={<div className="py-2 text-xs text-[var(--muted)]">Loading tag export…</div>}
          >
            <LazyCategoryExportPanel
              embedded
              collectMediaBlobs={collectMediaBlobs}
              onStatus={onStatus}
              onError={onError}
            />
          </Suspense>

          {/* Course */}
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
            <div>
              <h3 className="text-xs font-semibold">Course (.flashpkg)</h3>
              <p className="text-[11px] text-[var(--muted)]">
                Export one course along with its linked decks and lesson pages.
              </p>
            </div>
            {courses.length === 0 ? (
              <p className="text-xs text-[var(--muted)]">No courses yet.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Course to export"
                  data-testid="export-course-select"
                  value={selectedCourse?.id ?? ''}
                  onChange={(e) => setCourseChoice(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="export-course-btn"
                  disabled={!selectedCourse}
                  onClick={() => {
                    if (selectedCourse) {
                      void onExportScoped({ courseId: selectedCourse.id }, selectedCourse.name);
                    }
                  }}
                  className={SECONDARY_BTN}
                >
                  Export Course (.flashpkg)
                </button>
              </div>
            )}
          </div>

          {/* Lesson page */}
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
            <div>
              <h3 className="text-xs font-semibold">Lesson page (.flashpkg)</h3>
              <p className="text-[11px] text-[var(--muted)]">
                Export a single markdown lesson page and any referenced media.
              </p>
            </div>
            {pages.length === 0 ? (
              <p className="text-xs text-[var(--muted)]">No lesson pages yet.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Lesson page to export"
                  data-testid="export-page-select"
                  value={selectedPage?.id ?? ''}
                  onChange={(e) => setPageChoice(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="export-page-btn"
                  disabled={!selectedPage}
                  onClick={() => {
                    if (selectedPage) {
                      void onExportScoped({ pageId: selectedPage.id }, selectedPage.title);
                    }
                  }}
                  className={SECONDARY_BTN}
                >
                  Export Page (.flashpkg)
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default ImportExportPanel;
