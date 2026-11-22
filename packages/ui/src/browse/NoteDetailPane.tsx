import {
  compareHlc,
  formatIntervalLabel,
  getCardStateKinds,
  stripCloze,
  type Card,
  type CardStateKind,
  type Note,
  type NoteTypeField,
} from '@flash/core';
import { RichText } from '../components/RichText.tsx';
import { useApp } from '../state/AppContext.tsx';

const STATE_LABEL: Record<'new' | 'learning' | 'review', string> = {
  new: 'New',
  learning: 'Learning',
  review: 'Review',
};

function learningStateLabel(kinds: ReadonlySet<CardStateKind>): string {
  if (kinds.has('new')) return STATE_LABEL.new;
  return kinds.has('learning') ? STATE_LABEL.learning : STATE_LABEL.review;
}

/** Due line for a card: never-studied, due now, or the interval until due. */
function dueLabel(card: Card, kinds: ReadonlySet<CardStateKind>, nowMs: number): string {
  if (kinds.has('new')) return 'Not studied yet';
  if (card.schedule.due <= nowMs) return 'Due now';
  return `Due in ${formatIntervalLabel(card.schedule.due, nowMs)}`;
}

function FieldValue({
  field,
  value,
  pinyinToneColors,
}: {
  field: NoteTypeField;
  value: string;
  pinyinToneColors: boolean;
}) {
  if (!value.trim()) return <span className="text-[var(--muted)]">—</span>;
  // Media fields hold a `media:<sha256>` reference, never text worth showing.
  if (field.kind === 'image' || field.kind === 'audio') {
    return (
      <span className="text-[var(--muted)]">{field.kind === 'image' ? 'Image' : 'Audio'}</span>
    );
  }
  return (
    <RichText
      text={stripCloze(value)}
      lang={field.lang}
      hideRuby={false}
      pinyinToneColors={pinyinToneColors}
    />
  );
}

export interface NoteDetailPaneProps {
  note: Note;
  onEdit: (note: Note) => void;
}

/**
 * Browse split view detail pane (Phase 13, tablets / desktop): every field of the selected note,
 * its categories and each card's schedule. Read-only; Edit opens the same editor as a row tap.
 * Text goes through `RichText` (ruby / pinyin markup only), never raw HTML.
 */
export function NoteDetailPane({ note, onEdit }: NoteDetailPaneProps) {
  const { state } = useApp();
  const deck = state.decks.get(note.deck_id);
  const noteType = deck ? state.noteTypes.get(deck.note_type_id) : undefined;
  const fields: NoteTypeField[] =
    noteType?.fields ??
    Object.keys(note.fields).map((key) => ({
      key,
      label: key,
      kind: 'text',
      lang: deck?.language ?? 'en',
    }));
  const nowMs = Date.now();
  const ctx = { nowMs, tzOffsetMinutes: -new Date(nowMs).getTimezoneOffset() };
  // compareHlc is the shared code-unit string comparator (deterministic, locale-free).
  const cards = [...(state.cardIdsByNote.get(note.id) ?? [])]
    .sort(compareHlc)
    .map((id) => state.cards.get(id))
    .filter((c): c is Card => c !== undefined);
  const pinyinToneColors = state.preferences.pinyin_tone_colors;
  const headline = fields[0];

  return (
    <section
      data-testid="browse-detail"
      aria-label="Note details"
      className="flex min-w-0 flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div
          data-testid="browse-detail-headline"
          className="min-w-0 text-3xl font-bold leading-tight"
        >
          {headline ? (
            <FieldValue
              field={headline}
              value={note.fields[headline.key] ?? ''}
              pinyinToneColors={pinyinToneColors}
            />
          ) : (
            '(empty)'
          )}
        </div>
        <button
          type="button"
          data-testid="browse-detail-edit"
          onClick={() => onEdit(note)}
          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--accent)]"
        >
          Edit
        </button>
      </div>

      <p className="text-xs text-[var(--muted)]">
        {deck?.name ?? 'Unknown deck'}
        {noteType ? ` · ${noteType.name}` : ''}
        {note.archived ? ' · Archived' : ''}
      </p>

      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {fields.slice(1).map((field) => (
          <div key={field.key} className="contents">
            <dt className="text-xs font-medium text-[var(--muted)]">{field.label}</dt>
            <dd className="min-w-0 break-words">
              <FieldValue
                field={field}
                value={note.fields[field.key] ?? ''}
                pinyinToneColors={pinyinToneColors}
              />
            </dd>
          </div>
        ))}
      </dl>

      {note.tags.length > 0 && (
        <ul aria-label="Categories" className="flex flex-wrap gap-1.5">
          {note.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--muted)]"
            >
              #{tag}
            </li>
          ))}
        </ul>
      )}

      {cards.length > 0 && (
        <ul aria-label="Cards" className="flex flex-col gap-2">
          {cards.map((card) => {
            const kinds = getCardStateKinds(state, card, ctx);
            const layout = state.layouts.get(card.layout_id);
            return (
              <li
                key={card.id}
                data-testid={`browse-detail-card-${card.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs"
              >
                <span className="font-semibold">
                  {layout?.name ?? 'Card'}
                  {card.variant > 0 ? ` · c${card.variant}` : ''}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-[var(--muted)]">
                  <span>{learningStateLabel(kinds)}</span>
                  <span>{dueLabel(card, kinds, nowMs)}</span>
                  <span>
                    {card.schedule.reps} reviews · {card.schedule.lapses} lapses
                  </span>
                  {kinds.has('suspended') && <span className="font-semibold">Suspended</span>}
                  {kinds.has('leech') && (
                    <span className="font-semibold text-rose-700 dark:text-rose-300">Leech</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
