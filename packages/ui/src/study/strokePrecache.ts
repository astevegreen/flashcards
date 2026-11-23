import type { Card, CollectionState } from '@flash/core';
import {
  extractDrawableCharacters,
  resolveDrawingMode,
  resolveStrokeScriptForLang,
} from '@flash/core/drawing';
import type { StrokeDataProvider } from '@flash/platform';

type StrokeScript = 'ja' | 'zh-Hans';

/** Drawable characters of upcoming graded `draw` cards, grouped by stroke script. */
function collectDrawCharacters(
  state: CollectionState,
  cards: readonly Card[],
): Record<StrokeScript, Set<string>> {
  const byScript: Record<StrokeScript, Set<string>> = { ja: new Set(), 'zh-Hans': new Set() };
  for (const c of cards) {
    const note = state.notes.get(c.note_id);
    const deck = state.decks.get(c.deck_id);
    const layout = state.layouts.get(c.layout_id);
    if (!note || !deck || !layout) continue;
    const noteType = state.noteTypes.get(deck.note_type_id);
    const key = layout.answer_field ?? layout.reveal_steps[0]?.[0] ?? 'word';
    const lang = noteType?.fields.find((f) => f.key === key)?.lang ?? deck.language;
    if (resolveDrawingMode(state.preferences, lang) !== 'graded') continue;
    const script = resolveStrokeScriptForLang(lang);
    for (const ch of extractDrawableCharacters(note.fields[key] ?? '', lang, {
      rubyDisplay: layout.ruby_display,
    })) {
      byScript[script].add(ch);
    }
  }
  return byScript;
}

/**
 * Background lookahead stroke pre-caching for upcoming `draw` cards. Loaded lazily by the Study
 * screen only when such cards are queued, so Flip decks pay 0 KB for it (§8).
 */
export async function precacheUpcomingDrawCards(
  state: CollectionState,
  cards: readonly Card[],
  provider: StrokeDataProvider,
  isCancelled: () => boolean,
): Promise<void> {
  const byScript = collectDrawCharacters(state, cards);
  for (const script of ['ja', 'zh-Hans'] as const) {
    if (byScript[script].size > 0 && !isCancelled()) {
      await provider.precacheCharacters(script, [...byScript[script]]);
    }
  }
}
