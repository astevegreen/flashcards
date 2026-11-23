import type { Layout, Note, NoteType } from './types.ts';

/**
 * Optional cards: a layout may name one `required_field`, and a note gets that layout's card
 * only while the field is filled (a listening card only when there is audio, a writing card only
 * when a stroke field has data). There are no template conditionals.
 *
 * Replay (`events/replay.ts`) keeps a card whose field was emptied after it was studied: the card
 * keeps its schedule, is flagged `empty`, stays out of Study and shows as "empty" in Browse.
 * Filling the field again brings it back as a normal card. A card that was never studied is
 * simply not made. Reviews are never deleted from the event log either way.
 *
 * A rule only counts when it names a field of the layout's note type, and never on a cloze
 * layout's own text fields (emptying those would change which cloze variants exist, so studied
 * c1/c2 cards could not be kept). Any other rule is ignored: every note gets the card.
 */

/** A field counts as filled when it has any non-whitespace character. */
export function isFieldFilled(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/**
 * Why a layout's `required_field` can't be used, if it can't: `unknown_field` (not a field of
 * the note type, or the note type is unknown) or `cloze_text` (a cloze layout's front field).
 */
export function requiredFieldProblem(
  layout: {
    answer_mode: Layout['answer_mode'];
    front_fields: readonly string[];
    required_field?: string | undefined;
  },
  noteType: { fields: readonly { key: string }[] } | undefined,
): 'unknown_field' | 'cloze_text' | undefined {
  const field = layout.required_field;
  if (field === undefined || field === '') return undefined;
  if (!noteType?.fields.some((f) => f.key === field)) return 'unknown_field';
  if (layout.answer_mode === 'cloze' && layout.front_fields.includes(field)) return 'cloze_text';
  return undefined;
}

/** The field the layout's rule really checks, or `undefined` when it has no usable rule. */
export function effectiveRequiredField(
  layout: Layout,
  noteType: NoteType | undefined,
): string | undefined {
  const field = layout.required_field;
  if (field === undefined || field === '') return undefined;
  return requiredFieldProblem(layout, noteType) === undefined ? field : undefined;
}

/** True when `layout` has no usable rule, or the note's required field is filled. */
export function layoutRuleMet(note: Note, layout: Layout, noteType: NoteType | undefined): boolean {
  const field = effectiveRequiredField(layout, noteType);
  return field === undefined || isFieldFilled(note.fields[field]);
}

/** True when at least one layout in `layouts` carries a `required_field` (usable or not). */
export function hasOptionalCardRules(layouts: Iterable<Layout>): boolean {
  for (const layout of layouts) {
    if (layout.required_field !== undefined && layout.required_field !== '') return true;
  }
  return false;
}
