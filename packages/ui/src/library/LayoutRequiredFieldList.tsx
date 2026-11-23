import type { Layout, NoteType } from '@flash/core';

/**
 * Optional cards (layout settings): per layout, "make this card only when <field> is filled".
 * One rule per layout, no template conditionals. Emptying the field later keeps a studied card's
 * history: the card shows as "Empty" in Browse and comes back when the field is filled again.
 */
export function LayoutRequiredFieldList({
  deckId,
  layouts,
  noteType,
  onUpdateLayout,
}: Readonly<{
  deckId: string;
  layouts: readonly Layout[];
  noteType: NoteType | undefined;
  onUpdateLayout: (layout: Layout) => void;
}>) {
  const fields = noteType?.fields ?? [];
  if (layouts.length === 0 || fields.length === 0) return null;
  return (
    <div
      data-testid={`layout-required-field-list-${deckId}`}
      className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
    >
      <div className="text-xs font-semibold text-[var(--fg)]">Layouts: optional cards</div>
      <p className="text-[11px] text-[var(--muted)]">
        Make a layout&apos;s card only for notes where a field is filled, for example a Listen card
        only when there is audio. If the field is emptied later, studied cards keep their history
        and show as Empty in Browse.
      </p>
      {layouts.map((l) => (
        <label key={l.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate text-[var(--muted)]">
            {l.name} ({l.answer_mode})
          </span>
          <select
            aria-label={`Make ${l.name} cards`}
            data-testid={`layout-required-field-${l.id}`}
            value={l.required_field ?? ''}
            onChange={(e) => {
              const next = e.target.value;
              const { required_field: _previous, ...rest } = l;
              onUpdateLayout(next === '' ? rest : { ...rest, required_field: next });
            }}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg)]"
          >
            <option value="">For every note</option>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                Only when {f.label} is filled
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
