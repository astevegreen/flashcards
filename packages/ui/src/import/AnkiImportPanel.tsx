import type { AnkiImportResult, AnkiSkippedReviews } from '@flash/core/anki';
import { canCreateOrImportDeck } from '@flash/core/license';
import { useState } from 'react';
import { describeImportError } from '../components/describeImportError.ts';
import { useApp } from '../state/AppContext.tsx';

/** Keep in step with the Suspense fallback in LibraryScreen, so nothing jumps when it loads. */
const ANKI_IMPORT_PANEL_MIN_HEIGHT = 'min-h-[13rem]';

const MAX_LISTED_WARNINGS = 5;

type Phase = 'idle' | 'reading' | 'converting' | 'saving' | 'done' | 'error';

const PHASE_TEXT: Record<Phase, string> = {
  idle: 'Choose an .apkg file exported from Anki.',
  reading: 'Reading the Anki package…',
  converting: 'Converting notes and layouts…',
  saving: 'Saving media and notes…',
  done: '',
  error: '',
};

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
  if (includeHistory) {
    const skipped = describeSkipped(summary.skippedReviews);
    const skippedText = skipped ? ` Skipped: ${skipped}.` : '';
    lines.push(`Review history: ${plural(summary.reviews, 'review')} imported.${skippedText}`);
  }
  return lines.join('\n');
}

export interface AnkiImportPanelProps {
  /** Called after a successful import with the decks the package filled. */
  onImported?: (deckIds: readonly string[]) => void;
}

/**
 * Library "Import Anki (.apkg)" (Phase 12). Lazily loaded together with `@flash/core/anki`; the
 * SQLite/zstd reader runs in a Web Worker behind `platform.getAnkiPackageReader`. Review history
 * is opt-in (off by default). Every message renders as plain text.
 */
export function AnkiImportPanel({ onImported }: Readonly<AnkiImportPanelProps>) {
  const { platform, state, entitlement, emitEvents, getEventFactory } = useApp();
  const [includeHistory, setIncludeHistory] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState(PHASE_TEXT.idle);
  const [warnings, setWarnings] = useState<string[]>([]);
  const busy = phase === 'reading' || phase === 'converting' || phase === 'saving';
  const readerAvailable = typeof platform.getAnkiPackageReader === 'function';

  const go = (next: Phase) => {
    setPhase(next);
    setMessage(PHASE_TEXT[next]);
  };

  const fail = (text: string) => {
    setPhase('error');
    setMessage(text);
  };

  const runImport = async (bytes: Uint8Array) => {
    if (!platform.getAnkiPackageReader) return;
    go('reading');
    const reader = await platform.getAnkiPackageReader();
    const raw = await reader.read(bytes, { includeReviewHistory: includeHistory });
    go('converting');
    const { importAnkiPackage } = await import('@flash/core/anki');
    const result = importAnkiPackage(raw, state, getEventFactory(), {
      includeReviewHistory: includeHistory,
      tzOffsetMinutes: -new Date().getTimezoneOffset(),
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
      await platform.storage.putMedia({ hash: media.hash, mime: media.mime, bytes: media.bytes });
    }
    if (result.events.length > 0) emitEvents(result.events);
    setWarnings([...new Set(result.warnings)]);
    setPhase('done');
    setMessage(describeAnkiImport(result, includeHistory));
    onImported?.(result.deckIds);
  };

  const handlePick = async () => {
    setWarnings([]);
    try {
      const picked = await platform.files.pickFile({ accept: '.apkg' });
      if (!picked) return;
      await runImport(picked.bytes);
    } catch (err) {
      fail(describeImportError(err));
    }
  };

  const statusTone = phase === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-[var(--muted)]';

  return (
    <section
      data-testid="anki-import-panel"
      aria-label="Import from Anki"
      className={`flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 ${ANKI_IMPORT_PANEL_MIN_HEIGHT}`}
    >
      <div>
        <h2 className="text-sm font-semibold">Import from Anki</h2>
        <p className="text-xs text-[var(--muted)]">
          Notes, note types, cloze, tags and media from an Anki .apkg export. Each Anki deck becomes
          a deck here; scheduling starts fresh unless you include review history.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            data-testid="anki-include-history"
            checked={includeHistory}
            disabled={busy}
            onChange={(e) => setIncludeHistory(e.target.checked)}
          />
          Include review history
        </label>
        <button
          type="button"
          data-testid="anki-pick-file-btn"
          disabled={busy || !readerAvailable}
          onClick={() => void handlePick()}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--fg)] hover:opacity-90 disabled:opacity-40"
        >
          Choose .apkg file…
        </button>
      </div>
      <div
        role="status"
        aria-live="polite"
        data-testid="anki-import-status"
        data-phase={phase}
        className={`min-h-[3.75rem] whitespace-pre-line text-xs ${statusTone}`}
      >
        {readerAvailable ? message : 'Anki import is not available on this device.'}
      </div>
      {warnings.length > 0 && (
        <ul
          data-testid="anki-import-warnings"
          className="list-disc pl-5 text-[11px] text-[var(--muted)]"
        >
          {warnings.slice(0, MAX_LISTED_WARNINGS).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
          {warnings.length > MAX_LISTED_WARNINGS && (
            <li>…and {warnings.length - MAX_LISTED_WARNINGS} more</li>
          )}
        </ul>
      )}
    </section>
  );
}

export default AnkiImportPanel;
