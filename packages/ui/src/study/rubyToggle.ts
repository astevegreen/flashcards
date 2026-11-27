import { hasRubyMarkup, type Layout, type Note, noteField } from '@flash/core';

/**
 * True when the layout hides ruby on the front and the card's front fields actually store ruby.
 * Korean shows Hanja as plain text (no ruby options), but a Korean note that already carries
 * Hangul-over-Hanja ruby keeps the Ruby toggle so its hidden reading stays reachable.
 */
export function frontRubyHidden(
  layout: Pick<Layout, 'hide_furigana_on_front' | 'front_fields'> | undefined,
  note: Pick<Note, 'fields'> | undefined,
): boolean {
  if (!layout?.hide_furigana_on_front || !note) return false;
  return layout.front_fields.some((key) => hasRubyMarkup(noteField(note, key) ?? ''));
}

/** The Study toolbar's Ruby toggle: shown for ruby languages (ja, zh) or hidden stored ruby. */
export function showRubyToggle(
  rubyLanguage: boolean,
  layout: Pick<Layout, 'hide_furigana_on_front' | 'front_fields'> | undefined,
  note: Pick<Note, 'fields'> | undefined,
): boolean {
  return rubyLanguage || frontRubyHidden(layout, note);
}
