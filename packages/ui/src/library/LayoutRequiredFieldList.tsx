import { requiredFieldProblem, type Layout, type NoteType } from '@flash/core';

/**
 * Optional cards (layout settings): per layout, "make this card only when <field> is filled".
 * One rule per layout, no template conditionals. The rule is stored on the layout, so it applies
 * to every deck of the note type. Emptying the field later keeps a studied card: it shows as
 * "Empty" in Browse and comes back when the field is filled again.
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
        only when there is audio. This applies to every deck that uses the{' '}
        {noteType?.name ?? 'same'} note type, not just this one. If the field is emptied later,
        studied cards are kept and show as Empty in Words.
      </p>
      {layouts.map((l) => {
        const usable = fields.filter(
          (f) => requiredFieldProblem({ ...l, required_field: f.key }, noteType) === undefined,
        );
        const problem = requiredFieldProblem(l, noteType);
        return (
          <div key={l.id} className="flex flex-col gap-0.5">
            <label className="flex items-center justify-between gap-2 text-xs">
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
                {problem !== undefined && l.required_field !== undefined && (
                  <option value={l.required_field}>Only when {l.required_field} is filled</option>
                )}
                {usable.map((f) => (
                  <option key={f.key} value={f.key}>
                    Only when {f.label} is filled
                  </option>
                ))}
              </select>
            </label>
            {problem !== undefined && (
              <span
                data-testid={`layout-required-field-warning-${l.id}`}
                className="text-[11px] text-amber-700 dark:text-amber-300"
              >
                {problem === 'cloze_text'
                  ? 'Ignored: a cloze layout cannot depend on its own text. Every note gets this card.'
                  : 'Ignored: this note type has no such field. Every note gets this card.'}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
