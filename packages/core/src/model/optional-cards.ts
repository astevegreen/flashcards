import type { Layout, Note } from './types.ts';

/**
 * Optional cards: a layout may name one `required_field`, and a note gets that layout's card
 * only while the field is filled (a writing card only when the stroke field has data, a
 * listening card only when there is audio). There are no template conditionals.
 *
 * Replay (`events/replay.ts`) keeps a card whose field was emptied after it was studied: the card
 * keeps its schedule and history, is flagged `empty`, stays out of Study and shows as "empty" in
 * Browse. Filling the field again brings it back as a normal card. A card that was never studied
 * is simply not made, so nothing is lost either way.
 */

/** A field counts as filled when it has any non-whitespace character. */
export function isFieldFilled(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/** True when `layout` has no rule, or the note's required field is filled. */
export function layoutRuleMet(note: Note, layout: Layout): boolean {
  const field = layout.required_field;
  if (field === undefined || field === '') return true;
  return isFieldFilled(note.fields[field]);
}

/** True when at least one layout in `layouts` carries a `required_field` rule. */
export function hasOptionalCardRules(layouts: Iterable<Layout>): boolean {
  for (const layout of layouts) {
    if (layout.required_field !== undefined && layout.required_field !== '') return true;
  }
  return false;
}
