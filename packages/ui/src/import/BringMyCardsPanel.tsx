import { decodeUtf8 } from '@flash/core';
import type { DetectedImport } from '@flash/core/import-detect';
import { lazy, Suspense, useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { describeImportError } from '../components/describeImportError.ts';
import { useApp } from '../state/AppContext.tsx';
import { BRING_MY_CARDS_PANEL_HEIGHT } from './bring-my-cards-layout.ts';
import {
  assertCanAddDecks,
  importCsvIntoDeck,
  importFlashpkgBytes,
  type LibraryImportContext,
} from './libraryImports.ts';

const LazyAnkiImportPanel = lazy(() => import('./AnkiImportPanel.tsx'));

/** Same cap as the largest importer accepts (Anki packages, §13). */
const MAX_IMPORT_BYTES = 300 * 1024 * 1024;
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const DEFAULT_NOTE_TYPE_ID = 'preset:vocab-ko';
const MAX_LISTED_HEADERS = 6;

const LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'ko', label: 'Korean (ko)' },
  { code: 'ja', label: 'Japanese (ja)' },
  { code: 'zh-Hans', label: 'Mandarin (zh-Hans)' },
  { code: 'en', label: 'English (en)' },
];

type CsvDetection = Extract<DetectedImport, { kind: 'csv' }>;

type Route =
  | { kind: 'input'; message: string; tone: 'muted' | 'error' }
  | { kind: 'reading'; name: string }
  | { kind: 'anki'; name: string; bytes: Uint8Array }
  | { kind: 'flashpkg'; name: string; phase: 'importing' | 'done' | 'error'; message: string }
  | { kind: 'csv'; name: string; text: string; detected: CsvDetection }
  | { kind: 'google-sheets'; spreadsheetId: string; url: string };

const INITIAL_ROUTE: Route = { kind: 'input', message: '', tone: 'muted' };

function useImportContext(): LibraryImportContext {
  const { platform, state, entitlement, getEventFactory, emitEvents } = useApp();
  return { platform, state, entitlement, getEventFactory, emitEvents };
}

/** `cards.csv` -> `cards` (the CSV route's suggested deck name). */
function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  return base.trim() || 'Imported Deck';
}

const BUTTON =
  'rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-40';
const PRIMARY_BUTTON =
  'rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40';
const FIELD =
  'min-w-0 max-w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs';

function toneClass(error: boolean): string {
  return error ? 'text-rose-700 dark:text-rose-300' : 'text-[var(--muted)]';
}

// ---------------------------------------------------------------------------------------------
// Input: drop zone, file picker, Sheets link
// ---------------------------------------------------------------------------------------------

interface InputViewProps {
  busyName: string | null;
  message: string;
  error: boolean;
  onFile: (name: string, bytes: Uint8Array) => void;
  onTooLarge: (name: string) => void;
  onLink: (text: string) => void;
}

function InputView({ busyName, message, error, onFile, onTooLarge, onLink }: InputViewProps) {
  const { platform } = useApp();
  const [link, setLink] = useState('');
  const [dragging, setDragging] = useState(false);
  const busy = busyName !== null;

  const handlePick = async () => {
    const picked = await platform.files.pickFile();
    if (picked) onFile(picked.name, picked.bytes);
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file || busy) return;
    if (file.size > MAX_IMPORT_BYTES) {
      onTooLarge(file.name);
      return;
    }
    onFile(file.name, new Uint8Array(await file.arrayBuffer()));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onLink(link);
  };

  const status = busyName === null ? message : `Reading "${busyName}"…`;
  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="bring-drop-zone"
        data-dragging={dragging}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => void handleDrop(e)}
        className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-3 text-center text-xs ${dragging ? 'border-[var(--accent)] bg-[var(--surface-2)]' : 'border-[var(--border)]'}`}
      >
        <p className="font-medium">Drop a file here, or</p>
        <button
          type="button"
          data-testid="bring-pick-file-btn"
          disabled={busy}
          onClick={() => void handlePick()}
          className={BUTTON}
        >
          Choose a file…
        </button>
        <p className="text-[11px] break-words text-[var(--muted)]">
          Anki .apkg, .flashpkg, or CSV/TSV (Flashcards Deluxe exports too)
        </p>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-xs">
          <span>Or paste a Google Sheets link</span>
          <input
            type="text"
            inputMode="url"
            data-testid="bring-link-input"
            value={link}
            disabled={busy}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            className={`w-full ${FIELD}`}
          />
        </label>
        <button
          type="submit"
          data-testid="bring-link-submit"
          disabled={busy || link.trim() === ''}
          className={BUTTON}
        >
          Use link
        </button>
      </form>
      <output
        aria-live="polite"
        data-testid="bring-status"
        className={`block min-h-[4.5rem] text-xs break-words whitespace-pre-line ${toneClass(error)}`}
      >
        {status}
      </output>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// CSV / TSV (incl. Flashcards Deluxe): pick the target deck, then the existing CSV importer
// ---------------------------------------------------------------------------------------------

function csvLabel(detected: CsvDetection): string {
  const kind =
    detected.dialect === 'flashcards-deluxe' ? 'Flashcards Deluxe file' : 'CSV/TSV table';
  const delimiter = detected.delimiter === '\t' ? 'tab-separated' : 'comma-separated';
  return `${kind} (${delimiter})`;
}

function headerList(headers: readonly string[]): string {
  const shown = headers.slice(0, MAX_LISTED_HEADERS).join(', ');
  return headers.length > MAX_LISTED_HEADERS ? `${shown}, …` : shown;
}

interface NewDeckFieldsProps {
  deckName: string;
  noteTypeId: string;
  language: string;
  disabled: boolean;
  onDeckName: (v: string) => void;
  onNoteType: (v: string) => void;
  onLanguage: (v: string) => void;
}

function NewDeckFields(props: Readonly<NewDeckFieldsProps>) {
  const { state } = useApp();
  const noteTypes = [...state.noteTypes.values()];
  return (
    <>
      <label className="flex min-w-0 flex-col gap-1">
        <span>Deck name</span>
        <input
          type="text"
          data-testid="bring-csv-deck-name"
          value={props.deckName}
          disabled={props.disabled}
          onChange={(e) => props.onDeckName(e.target.value)}
          className={FIELD}
        />
      </label>
      <div className="flex min-w-0 flex-wrap gap-2">
        <label className="flex min-w-0 flex-1 basis-32 flex-col gap-1">
          <span>Note type</span>
          <select
            data-testid="bring-csv-note-type"
            value={props.noteTypeId}
            disabled={props.disabled}
            onChange={(e) => props.onNoteType(e.target.value)}
            className={FIELD}
          >
            {noteTypes.map((nt) => (
              <option key={nt.id} value={nt.id}>
                {nt.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 basis-32 flex-col gap-1">
          <span>Language</span>
          <select
            data-testid="bring-csv-language"
            value={props.language}
            disabled={props.disabled}
            onChange={(e) => props.onLanguage(e.target.value)}
            className={FIELD}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}

interface CsvRouteProps {
  name: string;
  text: string;
  detected: CsvDetection;
}

function CsvRoute({ name, text, detected }: Readonly<CsvRouteProps>) {
  const { state, createDeck } = useApp();
  const ctx = useImportContext();
  const decks = [...state.decks.values()].filter((d) => !d.archived);
  const [target, setTarget] = useState('new');
  const [deckName, setDeckName] = useState(baseName(name));
  const [noteTypeId, setNoteTypeId] = useState(
    state.noteTypes.has(DEFAULT_NOTE_TYPE_ID)
      ? DEFAULT_NOTE_TYPE_ID
      : ([...state.noteTypes.keys()][0] ?? ''),
  );
  const [language, setLanguage] = useState('ko');
  const [phase, setPhase] = useState<'idle' | 'importing' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const locked = phase === 'importing' || phase === 'done';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPhase('importing');
    setMessage('Importing…');
    try {
      let deckId = target;
      if (target === 'new') {
        assertCanAddDecks(ctx, 1);
        deckId = createDeck(deckName.trim() || baseName(name), noteTypeId, language);
      }
      const outcome = await importCsvIntoDeck(ctx, text, deckId);
      setPhase('done');
      setMessage(outcome.message);
    } catch (err) {
      setPhase('error');
      setMessage(describeImportError(err));
    }
  };

  const hint =
    detected.dialect === 'flashcards-deluxe'
      ? 'Text 1, Text 2, … fill the note type’s fields in order; Category columns become tags.'
      : 'Columns are matched to the note type’s fields by name; Tags and Card ID are kept.';
  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      data-testid="bring-csv-form"
      className="flex flex-col gap-2 text-xs"
    >
      <p className="break-words">
        <span className="font-semibold">{csvLabel(detected)}</span>: {headerList(detected.headers)}
      </p>
      <p className="text-[11px] text-[var(--muted)]">{hint}</p>
      <label className="flex min-w-0 flex-col gap-1">
        <span>Import into</span>
        <select
          data-testid="bring-csv-target"
          value={target}
          disabled={locked}
          onChange={(e) => setTarget(e.target.value)}
          className={FIELD}
        >
          <option value="new">A new deck</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      {target === 'new' && (
        <NewDeckFields
          deckName={deckName}
          noteTypeId={noteTypeId}
          language={language}
          disabled={locked}
          onDeckName={setDeckName}
          onNoteType={setNoteTypeId}
          onLanguage={setLanguage}
        />
      )}
      <div>
        <button
          type="submit"
          data-testid="bring-csv-import-btn"
          disabled={locked || (target === 'new' && !noteTypeId)}
          className={PRIMARY_BUTTON}
        >
          Import
        </button>
      </div>
      <output
        aria-live="polite"
        data-testid="bring-csv-status"
        data-phase={phase}
        className={`block min-h-[2.5rem] break-words whitespace-pre-line ${toneClass(phase === 'error')}`}
      >
        {message}
      </output>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Google Sheets: the existing linked-source flow (Picker or a pasted link)
// ---------------------------------------------------------------------------------------------

interface SheetsRouteProps {
  spreadsheetId: string;
  url: string;
}

function useGoogleConnected(): boolean | null {
  const { platform } = useApp();
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!platform.googleOAuthConfigured) return undefined;
    void platform
      .getGoogleAuth()
      .then((auth) => auth.isConnected())
      .catch(() => false)
      .then((value) => {
        if (!cancelled) setConnected(value);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);
  return connected;
}

const PICKER_HINT =
  'If Google says the file is not found, use "Choose it with Google Picker": Google only lets this app open Sheets you pick there.';

function SheetsRoute({ spreadsheetId, url }: Readonly<SheetsRouteProps>) {
  const { platform, state, getEventFactory, emitEvents } = useApp();
  const ctx = useImportContext();
  const connected = useGoogleConnected();
  const [phase, setPhase] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const configured = platform.googleOAuthConfigured;
  const busy = phase === 'working';

  const runLink = async (pick: boolean) => {
    setPhase('working');
    setMessage(pick ? 'Opening Google Picker…' : 'Linking the Sheet…');
    try {
      assertCanAddDecks(ctx, 1);
      const files = pick
        ? await (await platform.getGooglePicker()).pickSheetsAndDocs()
        : [{ id: spreadsheetId, name: 'Google Sheet', mimeType: GOOGLE_SHEET_MIME, url }];
      if (files.length === 0) {
        setPhase('idle');
        setMessage('');
        return;
      }
      const { linkPickedGoogleFiles } = await import('../sources/sourceRunner.ts');
      const runCtx = { platform, getState: () => state, getEventFactory, emitEvents };
      const summary = await linkPickedGoogleFiles(files, runCtx);
      if (summary.errors.length > 0) {
        setPhase('error');
        setMessage(`${summary.errors.join('\n')}\n${pick ? '' : PICKER_HINT}`.trim());
        return;
      }
      setPhase('done');
      setMessage(
        `Linked ${files.length} Google file(s): ${summary.importedNotes} note(s). It stays linked under Sources and refreshes from there.`,
      );
    } catch (err) {
      setPhase('error');
      setMessage(describeImportError(err));
    }
  };

  const signIn = async () => {
    try {
      await (await platform.getGoogleAuth()).signIn({ intent: 'sources' });
    } catch (err) {
      setPhase('error');
      setMessage(describeImportError(err));
    }
  };

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="bring-sheets">
      <p className="break-all">
        <span className="font-semibold">Google Sheets link</span>: {url}
      </p>
      {!configured && (
        <p className="text-[var(--muted)]">
          Google sign-in isn’t set up in this build, so Sheets can’t be linked here. Download the
          Sheet as CSV and choose that file instead.
        </p>
      )}
      {configured && (
        <div className="flex flex-wrap gap-2">
          {connected === false && (
            <button
              type="button"
              data-testid="bring-sheets-connect-btn"
              onClick={() => void signIn()}
              className={PRIMARY_BUTTON}
            >
              Connect Google
            </button>
          )}
          <button
            type="button"
            data-testid="bring-sheets-link-btn"
            disabled={busy || phase === 'done' || connected !== true}
            onClick={() => void runLink(false)}
            className={PRIMARY_BUTTON}
          >
            Link this Sheet
          </button>
          <button
            type="button"
            data-testid="bring-sheets-picker-btn"
            disabled={busy || connected !== true}
            onClick={() => void runLink(true)}
            className={BUTTON}
          >
            Choose it with Google Picker
          </button>
        </div>
      )}
      <output
        aria-live="polite"
        data-testid="bring-sheets-status"
        data-phase={phase}
        className={`block min-h-[2.5rem] break-words whitespace-pre-line ${toneClass(phase === 'error')}`}
      >
        {message}
      </output>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

const DETECTED_LABEL: Record<Exclude<Route['kind'], 'input' | 'reading'>, string> = {
  anki: 'Anki package',
  flashpkg: '.flashpkg package',
  csv: 'Table',
  'google-sheets': 'Google Sheet',
};

/** The panel's subtitle once a format was detected, or `undefined` before that. */
function detectedLabel(route: Route): string | undefined {
  if (route.kind === 'input' || route.kind === 'reading') return undefined;
  const label = DETECTED_LABEL[route.kind];
  return route.kind === 'google-sheets' ? label : `${label}: ${route.name}`;
}

function RouteBody({ route }: Readonly<{ route: Route }>) {
  if (route.kind === 'anki') {
    return (
      <Suspense fallback={<p className="text-xs text-[var(--muted)]">Loading Anki import…</p>}>
        <LazyAnkiImportPanel embedded pendingFile={{ name: route.name, bytes: route.bytes }} />
      </Suspense>
    );
  }
  if (route.kind === 'csv') {
    return <CsvRoute name={route.name} text={route.text} detected={route.detected} />;
  }
  if (route.kind === 'google-sheets') {
    return <SheetsRoute spreadsheetId={route.spreadsheetId} url={route.url} />;
  }
  if (route.kind === 'flashpkg') {
    return (
      <output
        aria-live="polite"
        data-testid="bring-flashpkg-status"
        data-phase={route.phase}
        className={`block text-xs break-words whitespace-pre-line ${toneClass(route.phase === 'error')}`}
      >
        {route.message}
      </output>
    );
  }
  return null;
}

/**
 * Phase 14 guided import: one place to drop or pick a file or paste a Google Sheets link. The
 * format is detected from the content (`@flash/core/import-detect`, never the extension alone)
 * and handed to the existing importer: the Anki panel, the CSV/TSV importer, the `.flashpkg`
 * importer, or the linked Google Sheets source. Lazily loaded; every message is plain text.
 */
export function BringMyCardsPanel() {
  const ctx = useImportContext();
  const [route, setRoute] = useState<Route>(INITIAL_ROUTE);

  const fail = (message: string) => setRoute({ kind: 'input', message, tone: 'error' });

  const runFlashpkg = async (name: string, bytes: Uint8Array) => {
    setRoute({ kind: 'flashpkg', name, phase: 'importing', message: 'Importing the package…' });
    try {
      const message = await importFlashpkgBytes(ctx, bytes);
      setRoute({ kind: 'flashpkg', name, phase: 'done', message });
    } catch (err) {
      setRoute({ kind: 'flashpkg', name, phase: 'error', message: describeImportError(err) });
    }
  };

  const routeDetected = (detected: DetectedImport, name: string, bytes: Uint8Array) => {
    if (detected.kind === 'anki') setRoute({ kind: 'anki', name, bytes });
    else if (detected.kind === 'flashpkg') void runFlashpkg(name, bytes);
    else if (detected.kind === 'csv')
      setRoute({ kind: 'csv', name, text: decodeUtf8(bytes), detected });
    else if (detected.kind === 'unsupported') fail(detected.message);
  };

  const handleFile = async (name: string, bytes: Uint8Array) => {
    if (bytes.byteLength > MAX_IMPORT_BYTES) {
      fail(`"${name}" is too large to import here (the limit is 300 MB).`);
      return;
    }
    setRoute({ kind: 'reading', name });
    try {
      const { detectImportFile } = await import('@flash/core/import-detect');
      routeDetected(detectImportFile(bytes, name), name, bytes);
    } catch (err) {
      fail(describeImportError(err));
    }
  };

  const handleLink = async (text: string) => {
    const { detectImportText } = await import('@flash/core/import-detect');
    const detected = detectImportText(text);
    if (detected.kind === 'google-sheets') {
      setRoute({ kind: 'google-sheets', spreadsheetId: detected.spreadsheetId, url: detected.url });
    } else if (detected.kind === 'unsupported') {
      fail(detected.message);
    } else {
      fail('Paste a Google Sheets link here. To import a file, drop it above or choose it.');
    }
  };

  const detected = detectedLabel(route);
  const routed = detected !== undefined;
  return (
    <section
      data-testid="bring-my-cards-panel"
      aria-label="Bring my cards"
      className={`flex flex-col gap-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 ${BRING_MY_CARDS_PANEL_HEIGHT}`}
    >
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="text-sm font-semibold">Bring my cards</h2>
          <p className="text-xs break-words text-[var(--muted)]">
            {detected ??
              'Import from Anki, Flashcards Deluxe, a .flashpkg backup or Google Sheets. The format is detected for you.'}
          </p>
        </div>
        {routed && (
          <button
            type="button"
            data-testid="bring-start-over-btn"
            onClick={() => setRoute(INITIAL_ROUTE)}
            className={BUTTON}
          >
            Start over
          </button>
        )}
      </div>
      <div
        data-testid="bring-route"
        data-kind={route.kind}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {routed ? (
          <RouteBody route={route} />
        ) : (
          <InputView
            busyName={route.kind === 'reading' ? route.name : null}
            message={route.kind === 'input' ? route.message : ''}
            error={route.kind === 'input' && route.tone === 'error'}
            onFile={(n, b) => void handleFile(n, b)}
            onTooLarge={(n) => fail(`"${n}" is too large to import here (the limit is 300 MB).`)}
            onLink={(t) => void handleLink(t)}
          />
        )}
      </div>
    </section>
  );
}

export default BringMyCardsPanel;
