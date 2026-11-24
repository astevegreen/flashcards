import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  type CollectionState,
} from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import {
  planFindReplace,
  planFindReplaceUndo,
  type FindReplaceOptions,
} from '../src/tags/find-replace.ts';

const BASE = Date.UTC(2026, 10, 1, 1, 0, 0);
const HASH = 'a'.repeat(64);
const f = createEventFactory('dev-a', 0, createHlcState('dev-a', BASE));
let t = BASE;

function buildState(): CollectionState {
  const events: FlashEvent[] = [];
  const deck = (id: string, extra: Record<string, unknown> = {}) =>
    events.push(
      f.create(
        'DeckCreated',
        {
          deck_id: id,
          name: id,
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          ...extra,
        },
        (t += 1),
      ),
    );
  const note = (deckId: string, key: string, fields: Record<string, string>) =>
    events.push(
      f.create(
        'NoteUpserted',
        { note_id: deriveNoteId(deckId, key), deck_id: deckId, source_key: key, fields },
        (t += 1),
      ),
    );
  deck('ko');
  deck('sheet', { source: { kind: 'google_sheet', spreadsheet_id: 's', sheet_name: 'Sheet1' } });
  note('ko', 'a', {
    word: '사과',
    meaning: 'Apple, an apple',
    notes: `An apple a day. media:${HASH}`,
    image: `media:${HASH}`,
  });
  note('ko', 'b', { word: '바나나', meaning: 'banana' });
  note('ko', 'c', { word: '포도', meaning: 'grape' });
  note('sheet', 'a', { word: '배', meaning: 'pear, apple-like' });
  return applyEvents(createEmptyState(), events);
}

const ALL = ['ko', 'sheet'].flatMap((d) => ['a', 'b', 'c'].map((k) => deriveNoteId(d, k)));
const A = deriveNoteId('ko', 'a');

function run(state: CollectionState, options: FindReplaceOptions, ids: string[] = ALL) {
  return planFindReplace(state, ids, options);
}

describe('find and replace across notes', () => {
  it('replaces case-insensitively by default, only in changed fields', () => {
    const state = buildState();
    const plan = run(state, { find: 'apple', replace: 'pomme' });
    expect(plan.error).toBeUndefined();
    expect(plan.changedNoteCount).toBe(2);
    expect(plan.replacementCount).toBe(4);
    const a = plan.payloads.find((p) => p.note_id === A);
    expect(a?.fields).toEqual({
      meaning: 'pomme, an pomme',
      notes: `An pomme a day. media:${HASH}`,
    });
    // Tags are left alone (no tags register write).
    expect(a && 'tags' in a).toBe(false);
  });

  it('matches case when asked', () => {
    const plan = run(buildState(), { find: 'Apple', replace: 'X', matchCase: true });
    expect(plan.replacementCount).toBe(1);
    expect(plan.payloads[0]?.fields).toEqual({ meaning: 'X, an apple' });
  });

  it('never touches media references or image and audio fields', () => {
    const plan = run(buildState(), { find: 'a', replace: 'b' }, [A]);
    const fields = plan.payloads[0]?.fields ?? {};
    expect(fields['image']).toBeUndefined();
    expect(fields['notes']).toContain(`media:${HASH}`);
    expect(fields['notes']?.startsWith('bn bpple b dby.')).toBe(true);
  });

  it('limits the search to one field', () => {
    const plan = run(buildState(), { find: 'apple', replace: 'x', fieldKey: 'notes' });
    expect(plan.changes.map((c) => c.fieldKey)).toEqual(['notes']);
  });

  it('treats the text literally unless regex is on', () => {
    const state = buildState();
    expect(run(state, { find: 'a.', replace: '' }).changedNoteCount).toBe(0);
    const plan = run(state, { find: '(\\w+)a\\b', replace: '[$1]', regex: true }, [
      deriveNoteId('ko', 'b'),
    ]);
    expect(plan.payloads[0]?.fields).toEqual({ meaning: '[banan]' });
    const literal = run(state, { find: 'banana', replace: '$1 $& $$' }, [deriveNoteId('ko', 'b')]);
    expect(literal.payloads[0]?.fields).toEqual({ meaning: '$1 $& $$' });
  });

  it('expands regex groups with lookbehind, named groups and $&', () => {
    const state = buildState();
    const ids = [deriveNoteId('ko', 'c')];
    expect(
      run(state, { find: '(?<=gr)a(?<rest>pe)', replace: 'o$<rest>!', regex: true }, ids)
        .payloads[0]?.fields,
    ).toEqual({ meaning: 'grope!' });
    expect(
      run(state, { find: 'ape', replace: '<$&>', regex: true }, ids).payloads[0]?.fields,
    ).toEqual({ meaning: 'gr<ape>' });
  });

  it('works on Hangul and skips zero-length matches', () => {
    const state = buildState();
    expect(run(state, { find: '사과', replace: '능금' }, [A]).payloads[0]?.fields).toEqual({
      word: '능금',
    });
    expect(run(state, { find: 'x*', replace: '!', regex: true }).changedNoteCount).toBe(0);
  });

  it('refuses an empty search and an invalid pattern', () => {
    const state = buildState();
    expect(run(state, { find: '', replace: 'x' }).error).toEqual({ code: 'empty_find' });
    expect(run(state, { find: '(', replace: 'x', regex: true }).error?.code).toBe('invalid_regex');
    // A literal "(" is fine.
    expect(run(state, { find: '(', replace: 'x' }).error).toBeUndefined();
  });

  it('counts changed notes in linked decks', () => {
    expect(run(buildState(), { find: 'apple', replace: 'x' }).linkedNoteCount).toBe(1);
  });

  it('undo restores the old text only where the field still holds the replaced text', () => {
    const state = buildState();
    const plan = run(state, { find: 'apple', replace: 'pomme' });
    applyEvents(
      state,
      plan.payloads.map((p) => f.create('NoteUpserted', p, (t += 1))),
    );
    expect(state.notes.get(A)?.fields['meaning']).toBe('pomme, an pomme');
    // Edited again since: that field is kept.
    applyEvents(state, [
      f.create(
        'NoteUpserted',
        { note_id: A, deck_id: 'ko', source_key: 'a', fields: { notes: 'rewritten' } },
        (t += 1),
      ),
    ]);
    const undo = planFindReplaceUndo(state, plan.changes);
    expect(undo.restoredCount).toBe(2);
    expect(undo.skippedCount).toBe(1);
    applyEvents(
      state,
      undo.payloads.map((p) => f.create('NoteUpserted', p, (t += 1))),
    );
    expect(state.notes.get(A)?.fields['meaning']).toBe('Apple, an apple');
    expect(state.notes.get(A)?.fields['notes']).toBe('rewritten');
    expect(state.notes.get(deriveNoteId('sheet', 'a'))?.fields['meaning']).toBe('pear, apple-like');
  });
});
