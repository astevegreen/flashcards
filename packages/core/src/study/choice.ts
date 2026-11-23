/**
 * Deterministic 4-option multiple-choice distractor generator per blueprint §5.2.
 * Pure TypeScript: draws distractors from the same field in the same deck (preferring
 * notes that share at least one tag), avoids duplicates and the correct answer, and
 * falls back gracefully when a deck has fewer than 4 distinct answers.
 */

import type { CollectionState } from '../events/replay.ts';
import type { Card, RubyDisplay } from '../model/types.ts';
import { stripCloze } from '../parsers/cloze.ts';
import { stripRuby } from '../parsers/ruby.ts';

export interface ChoiceOption {
  id: string;
  text: string;
  lang: string;
  isCorrect: boolean;
}

export interface ChoiceQuestion {
  answerFieldKey: string;
  lang: string;
  options: ChoiceOption[];
  /** True when the deck has fewer than 4 unique answers (< 3 distractors available). */
  insufficientDistractors: boolean;
}

/** Deterministic FNV-1a 32-bit hash for reproducible daily option shuffling. */
function hashString32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Dedupe key: the text the card shows (the layout's ruby flag picks readings or bases). */
function normalizeChoiceDedupKey(raw: string, rubyDisplay?: RubyDisplay): string {
  return stripRuby(stripCloze(raw), rubyDisplay)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Generates up to 4 multiple-choice options (1 correct + up to 3 distractors) for `card`.
 */
export function generateChoiceOptions(
  state: CollectionState,
  card: Card,
  studyDayIndex: number,
): ChoiceQuestion {
  const note = state.notes.get(card.note_id);
  const deck = state.decks.get(card.deck_id);
  const layout = state.layouts.get(card.layout_id);
  const noteType = deck ? state.noteTypes.get(deck.note_type_id) : undefined;

  const step0 = layout?.reveal_steps[0] ?? [];
  const nonMediaStep0 = step0.filter((k) => {
    const f = noteType?.fields.find((nf) => nf.key === k);
    return f?.kind !== 'image' && f?.kind !== 'audio';
  });
  const populatedStep0 = nonMediaStep0.filter((k) => Boolean(note?.fields[k]?.trim()));
  const answerFieldKey =
    layout?.answer_field ??
    populatedStep0.find(
      (k) => k === 'meaning' || k === 'translation' || k === 'explanation' || k === 'word',
    ) ??
    populatedStep0[0] ??
    nonMediaStep0[0] ??
    step0[0] ??
    'meaning';

  const fieldMeta = noteType?.fields.find((f) => f.key === answerFieldKey);
  const lang = fieldMeta?.lang ?? deck?.language ?? 'en';

  const correctRaw = note?.fields[answerFieldKey]?.trim() ?? '';
  if (!note || !deck || !correctRaw) {
    return {
      answerFieldKey,
      lang,
      options: [],
      insufficientDistractors: true,
    };
  }

  const correctNorm = normalizeChoiceDedupKey(correctRaw, layout?.ruby_display);
  const noteTags = new Set(note.tags);
  const deckNoteIds = state.noteIdsByDeck.get(card.deck_id);

  const sameTagCandidates: Array<{ noteId: string; text: string; norm: string }> = [];
  const otherDeckCandidates: Array<{ noteId: string; text: string; norm: string }> = [];

  if (deckNoteIds) {
    for (const candidateNoteId of deckNoteIds) {
      if (candidateNoteId === note.id) continue;
      const cand = state.notes.get(candidateNoteId);
      if (!cand || cand.archived) continue;
      const val = cand.fields[answerFieldKey]?.trim();
      if (!val) continue;
      const norm = normalizeChoiceDedupKey(val, layout?.ruby_display);
      if (!norm || norm === correctNorm) continue;

      const sharesTag = noteTags.size > 0 && cand.tags.some((t) => noteTags.has(t));
      if (sharesTag) {
        sameTagCandidates.push({ noteId: cand.id, text: val, norm });
      } else {
        otherDeckCandidates.push({ noteId: cand.id, text: val, norm });
      }
    }
  }

  const rankByHash = (a: { noteId: string }, b: { noteId: string }): number => {
    const ha = hashString32(`${studyDayIndex}:${card.id}:pick:${a.noteId}`);
    const hb = hashString32(`${studyDayIndex}:${card.id}:pick:${b.noteId}`);
    return ha - hb || (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0);
  };

  sameTagCandidates.sort(rankByHash);
  otherDeckCandidates.sort(rankByHash);

  const seenNorms = new Set<string>([correctNorm]);
  const distractors: ChoiceOption[] = [];

  for (const pool of [sameTagCandidates, otherDeckCandidates]) {
    for (const cand of pool) {
      if (distractors.length >= 3) break;
      if (seenNorms.has(cand.norm)) continue;
      seenNorms.add(cand.norm);
      distractors.push({
        id: `choice:${cand.noteId}`,
        text: cand.text,
        lang,
        isCorrect: false,
      });
    }
    if (distractors.length >= 3) break;
  }

  const allOptions: ChoiceOption[] = [
    {
      id: `choice:${note.id}`,
      text: correctRaw,
      lang,
      isCorrect: true,
    },
    ...distractors,
  ];

  // Deterministically order options for (studyDayIndex, card.id)
  allOptions.sort((a, b) => {
    const ha = hashString32(`${studyDayIndex}:${card.id}:order:${a.id}`);
    const hb = hashString32(`${studyDayIndex}:${card.id}:order:${b.id}`);
    return ha - hb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  return {
    answerFieldKey,
    lang,
    options: allOptions,
    insufficientDistractors: distractors.length < 3,
  };
}
