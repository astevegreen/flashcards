import { createEventFactory, createHlcState, type CollectionState } from '@flash/core';
import type {
  ANKI_FIELD_LANGUAGES,
  AnkiFieldLanguageOption,
  ankiFieldLanguageEvents,
  AnkiImportedNoteType,
  AnkiImportResult,
  AnkiRawPackage,
  AnkiSkippedReviews,
  importAnkiPackage,
} from '@flash/core/anki';
import { canCreateOrImportDeck } from '@flash/core/license';
import { useEffect, useRef, useState } from 'react';
import { describeImportError } from '../components/describeImportError.ts';
import { useApp } from '../state/AppContext.tsx';
import { ANKI_IMPORT_PANEL_HEIGHT } from './anki-import-layout.ts';
import { putMediaTracked } from '../state/recentMedia.ts';

const MAX_LISTED_WARNINGS = 5;

/** `ready`: the package is read and summarized, waiting for Import. */
type Phase = 'idle' | 'reading' | 'converting' | 'ready' | 'saving' | 'done' | 'error';

const PHASE_TEXT: Record<Phase, string> = {
  idle: 'Choose an .apkg file exported from Anki.',
  reading: 'Reading the Anki package…',
  converting: 'Converting notes and layouts…',
  ready: '',
  saving: 'Saving media and notes…',
  done: '',
  error: '',
};

/** What the panel keeps of the lazily loaded `@flash/core/anki`. */
interface AnkiModule {
  ANKI_FIELD_LANGUAGES: typeof ANKI_FIELD_LANGUAGES;
  ankiFieldLanguageEvents: typeof ankiFieldLanguageEvents;
  importAnkiPackage: typeof importAnkiPackage;
}

/** A package read once (with its review history) and converted as a dry run for the summary. */
interface PreparedPackage {
  raw: AnkiRawPackage;
  preview: AnkiImportResult;
}

const MAX_LISTED_DECKS = 6;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeSkipped(skipped: AnkiSkippedReviews): string {
  const parts: string[] = [];
  if (skipped.manual > 0) parts.push(`${skipped.manual} manual/rescheduled`);
  if (skipped.filtered > 0) parts.push(`${skipped.filtered} filtered-deck (cram)`);
  if (skipped.unknownCard > 0) parts.push(`${skipped.unknownCard} for cards not imported`);
  if (skipped.invalid > 0) parts.push(`${skipped.invalid} unreadable`);
  if (skipped.duplicate > 0) parts.push(`${skipped.duplicate} already imported`);
  return parts.join(', ');
}

/** Plain-text summary of an import (rendered as text nodes, never HTML). */
export function describeAnkiImport(result: AnkiImportResult, includeHistory: boolean): string {
  const { summary } = result;
  const lines = [
    `Imported ${plural(summary.notes, 'note')} into ${plural(summary.decks, 'deck')} (${summary.newDecks} new): ${summary.changedNotes} added or updated, ${plural(summary.noteTypes, 'new note type')}, ${plural(summary.media, 'media file')}.`,
  ];
  if (summary.suspended > 0) {
    lines.push(`Suspended ${plural(summary.suspended, 'card')}, as in Anki.`);
  }
  if (includeHistory) {
    const skipped = describeSkipped(summary.skippedReviews);
    const skippedText = skipped ? ` Skipped: ${skipped}.` : '';
    lines.push(`Review history: ${plural(summary.reviews, 'review')} imported.${skippedText}`);
  }
  return lines.join('\n');
}

/** Deck names of a dry run: existing decks by their current name, new ones from the events. */
function previewDeckNames(result: AnkiImportResult, state: CollectionState): string[] {
  const created = new Map<string, string>();
  for (const event of result.events) {
    if (event.type === 'DeckCreated') created.set(event.payload.deck_id, event.payload.name);
  }
  return result.deckIds.map((id) => {
    const existing = state.decks.get(id);
    return existing ? existing.name : `${created.get(id) ?? id} (new)`;
  });
}

/**
 * Plain-text summary shown before anything is imported (read with history, so it can say how
 * many reviews the box would bring along).
 */
export function describeAnkiPreview(result: AnkiImportResult, state: CollectionState): string {
  const { summary } = result;
  const names = previewDeckNames(result, state);
  const shown = names.slice(0, MAX_LISTED_DECKS).join(', ');
  const more =
    names.length > MAX_LISTED_DECKS ? `, and ${names.length - MAX_LISTED_DECKS} more` : '';
  const lines = [
    `Ready to import ${plural(summary.notes, 'note')} into ${plural(summary.decks, 'deck')} (${summary.newDecks} new): ${summary.changedNotes} to add or update, ${plural(summary.noteTypes, 'new note type')}, ${plural(summary.media, 'media file')}.`,
  ];
  if (names.length > 0) lines.push(`Decks: ${shown}${more}.`);
  if (summary.suspended > 0) {
    lines.push(`${plural(summary.suspended, 'card')} suspended in Anki will stay suspended.`);
  }
  lines.push(
    summary.reviews > 0
      ? `Review history: ${plural(summary.reviews, 'review')} can come along if you tick "Include review history".`
      : 'This package has no review history to bring along.',
  );
  return lines.join('\n');
}

/** The language codes offered for one field: the shared list plus its current value. */
function optionsFor(
  languages: readonly AnkiFieldLanguageOption[],
  current: string,
): AnkiFieldLanguageOption[] {
  if (languages.some((l) => l.code === current)) return [...languages];
  return [...languages, { code: current, label: current }];
}

interface FieldLanguagesProps {
  noteTypes: readonly AnkiImportedNoteType[];
  languages: readonly AnkiFieldLanguageOption[];
  onChange: (noteType: AnkiImportedNoteType, fieldKey: string, lang: string) => void;
}

/**
 * Phase 14: the language detected for each imported field, with an accessible select to correct
 * it. Values come from the collection (so a correction shows at once and survives re-imports).
 */
function AnkiFieldLanguages({ noteTypes, languages, onChange }: Readonly<FieldLanguagesProps>) {
  const { state } = useApp();
  if (noteTypes.length === 0) return null;
  return (
    <div data-testid="anki-field-languages" className="mt-3 flex flex-col gap-2">
      <div>
        <p className="font-semibold text-[var(--fg)]">Field languages</p>
        <p className="text-[11px] text-[var(--muted)]">
          Detected from the text. Change any that are wrong: speech and text display use it.
        </p>
      </div>
      {noteTypes.map((nt) => {
        const current = new Map(
          (state.noteTypes.get(nt.noteTypeId)?.fields ?? []).map((f) => [f.key, f.lang]),
        );
        return (
          <fieldset
            key={nt.noteTypeId}
            className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-[var(--border)] p-2"
          >
            <legend className="max-w-full px-1 text-[11px] font-semibold break-words">
              {nt.name}
            </legend>
            {nt.fields.map((field) => {
              const value = current.get(field.key) ?? field.lang;
              return (
                <label
                  key={field.key}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1"
                >
                  <span className="min-w-0 break-words">{field.name}</span>
                  <select
                    aria-label={`Language of ${field.name} (${nt.name})`}
                    data-testid={`anki-field-lang-${field.key}`}
                    value={value}
                    onChange={(e) => onChange(nt, field.key, e.target.value)}
                    className="max-w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-xs"
                  >
                    {optionsFor(languages, value).map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}

export interface PendingAnkiFile {
  name: string;
  bytes: Uint8Array;
}

export interface AnkiImportPanelProps {
  /** Called after a successful import with the decks the package filled. */
  onImported?: (deckIds: readonly string[]) => void;
  /**
   * A package the guided "Bring my cards" flow already detected: read and summarized once on
   * mount, then imported when the user presses Import (review history off unless ticked).
   */
  pendingFile?: PendingAnkiFile;
  /** Drop the panel's own border and fixed height (it sits inside another fixed-height box). */
  embedded?: boolean;
  /** Told when an import starts and ends, so a host can hold controls that would interrupt it. */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * Library "Import Anki (.apkg)" (Phase 12). Lazily loaded together with `@flash/core/anki`; the
 * SQLite/zstd reader runs in a Web Worker behind `platform.getAnkiPackageReader`. Review history
 * is opt-in (off by default). Every message renders as plain text.
 */
export function AnkiImportPanel({
  onImported,
  pendingFile,
  embedded = false,
  onBusyChange,
}: Readonly<AnkiImportPanelProps>) {
  const { platform, state, entitlement, emitEvents, getEventFactory } = useApp();
  const [includeHistory, setIncludeHistory] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState(PHASE_TEXT.idle);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [imported, setImported] = useState<AnkiImportedNoteType[]>([]);
  const [prepared, setPrepared] = useState<PreparedPackage | null>(null);
  const ankiModule = useRef<AnkiModule | null>(null);
  // Bytes of the pending file already imported: they are transferred to the reader Worker, so a
  // second run (a re-render passing an equal file) would fail on a detached buffer.
  const startedPending = useRef<Uint8Array | null>(null);
  const busy = phase === 'reading' || phase === 'converting' || phase === 'saving';
  const readerAvailable = typeof platform.getAnkiPackageReader === 'function';

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const go = (next: Phase) => {
    setPhase(next);
    setMessage(PHASE_TEXT[next]);
  };

  const fail = (text: string) => {
    setPhase('error');
    setMessage(text);
  };

  const tzOffsetMinutes = () => -new Date().getTimezoneOffset();

  /** Reads the package once, with its history, and converts it as a dry run for the summary. */
  const prepare = async (bytes: Uint8Array) => {
    if (!platform.getAnkiPackageReader) return;
    go('reading');
    const reader = await platform.getAnkiPackageReader();
    const raw = await reader.read(bytes, { includeReviewHistory: true });
    go('converting');
    const mod = await import('@flash/core/anki');
    ankiModule.current = mod;
    // A throwaway factory: the dry run must not use up this device's event sequence numbers.
    const dryRun = createEventFactory('dry-run', 0, createHlcState('dry-run', Date.now()));
    const preview = mod.importAnkiPackage(raw, state, dryRun, {
      includeReviewHistory: true,
      tzOffsetMinutes: tzOffsetMinutes(),
    });
    setPrepared({ raw, preview });
    setWarnings([...new Set(preview.warnings)]);
    setPhase('ready');
    setMessage(describeAnkiPreview(preview, state));
  };

  /** Converts again against the collection as it is now, then stores media and events. */
  const commit = async (pkg: PreparedPackage, withHistory: boolean) => {
    const mod = ankiModule.current;
    if (!mod) return;
    go('converting');
    const result = mod.importAnkiPackage(pkg.raw, state, getEventFactory(), {
      includeReviewHistory: withHistory,
      tzOffsetMinutes: tzOffsetMinutes(),
    });
    if (result.summary.newDecks > 0) {
      const activeDecks = [...state.decks.values()].filter((d) => !d.archived).length;
      const gate = canCreateOrImportDeck(activeDecks + result.summary.newDecks - 1, entitlement);
      if (!gate.allowed) {
        fail(gate.reason ?? 'Free tier deck limit reached.');
        return;
      }
    }
    go('saving');
    for (const media of result.extractedMedia) {
      await putMediaTracked(platform.storage, {
        hash: media.hash,
        mime: media.mime,
        bytes: media.bytes,
      });
    }
    if (result.events.length > 0) emitEvents(result.events);
    setPrepared(null);
    setWarnings([...new Set(result.warnings)]);
    setImported(result.noteTypes);
    setPhase('done');
    setMessage(describeAnkiImport(result, withHistory));
    onImported?.(result.deckIds);
  };

  const prepareSafely = async (bytes: Uint8Array) => {
    setWarnings([]);
    setImported([]);
    setPrepared(null);
    try {
      await prepare(bytes);
    } catch (err) {
      fail(describeImportError(err));
    }
  };

  const handleImport = async () => {
    if (!prepared) return;
    try {
      await commit(prepared, includeHistory);
    } catch (err) {
      fail(describeImportError(err));
    }
  };

  const handlePick = async () => {
    try {
      const picked = await platform.files.pickFile({ accept: '.apkg' });
      if (!picked) return;
      await prepareSafely(picked.bytes);
    } catch (err) {
      fail(describeImportError(err));
    }
  };

  useEffect(() => {
    if (!pendingFile || startedPending.current === pendingFile.bytes) return;
    startedPending.current = pendingFile.bytes;
    void prepareSafely(pendingFile.bytes);
    // The pending file is read exactly once; later renders must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFile]);

  const handleLanguage = (noteType: AnkiImportedNoteType, fieldKey: string, lang: string) => {
    const mod = ankiModule.current;
    if (!mod) return;
    const events = mod.ankiFieldLanguageEvents(state, noteType, fieldKey, lang, getEventFactory());
    if (events.length > 0) emitEvents(events);
  };

  const statusTone = phase === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-[var(--muted)]';
  const frame = embedded
    ? 'flex h-full min-h-0 flex-col gap-3'
    : `flex flex-col gap-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 ${ANKI_IMPORT_PANEL_HEIGHT}`;
  const pickLabel = pendingFile ? 'Choose another .apkg…' : 'Choose .apkg file…';

  return (
    <section data-testid="anki-import-panel" aria-label="Import from Anki" className={frame}>
      <div className="shrink-0">
        <h2 className="text-sm font-semibold">Import from Anki</h2>
        <p className="text-xs text-[var(--muted)]">
          Notes, note types, cloze, tags and media from an Anki .apkg export. Each Anki deck becomes
          a deck here; scheduling starts fresh unless you include review history. A summary comes
          first; nothing is imported until you press Import.
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            data-testid="anki-include-history"
            checked={includeHistory}
            disabled={busy}
            onChange={(e) => setIncludeHistory(e.target.checked)}
          />
          <span>Include review history</span>
        </label>
        <button
          type="button"
          data-testid="anki-import-btn"
          disabled={busy || phase !== 'ready' || !prepared}
          onClick={() => void handleImport()}
          className="rounded-lg bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          Import
        </button>
        <button
          type="button"
          data-testid="anki-pick-file-btn"
          disabled={busy || !readerAvailable}
          onClick={() => void handlePick()}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-40"
        >
          {pickLabel}
        </button>
      </div>
      {/* One fixed box for the status and any warnings: it fills the rest of the fixed-height
          panel and scrolls, so finishing an import never moves the Library below. */}
      <div data-testid="anki-import-status-area" className="min-h-0 flex-1 overflow-y-auto text-xs">
        <output
          aria-live="polite"
          data-testid="anki-import-status"
          data-phase={phase}
          className={`block whitespace-pre-line ${statusTone}`}
        >
          {readerAvailable ? message : 'Anki import is not available on this device.'}
        </output>
        {warnings.length > 0 && (
          <ul
            data-testid="anki-import-warnings"
            className="mt-2 list-disc pl-5 text-[11px] text-[var(--muted)]"
          >
            {warnings.slice(0, MAX_LISTED_WARNINGS).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
            {warnings.length > MAX_LISTED_WARNINGS && (
              <li>…and {warnings.length - MAX_LISTED_WARNINGS} more</li>
            )}
          </ul>
        )}
        {phase === 'done' && ankiModule.current && (
          <AnkiFieldLanguages
            noteTypes={imported}
            languages={ankiModule.current.ANKI_FIELD_LANGUAGES}
            onChange={handleLanguage}
          />
        )}
      </div>
    </section>
  );
}

export default AnkiImportPanel;
