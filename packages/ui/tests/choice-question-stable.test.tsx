// @vitest-environment happy-dom
import {
  BUILTIN_NOTE_TYPE_IDS,
  createEventFactory,
  createHlcState,
  deriveCardId,
  deriveNoteId,
  replayAllEvents,
  type CollectionState,
  type FlashEvent,
} from '@flash/core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { choiceAnswerMode } from '../src/study/answerModes/ChoiceMode.tsx';
import type { AnswerModeRenderProps } from '../src/study/answerModes/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.UTC(2026, 4, 1, 9, 0, 0);
const DECK = 'deck-choice-stable';
const LAYOUT = 'layout:vocab-ko:recognition';
const MEANINGS: Record<string, string> = {
  n1: 'apple',
  n2: 'banana',
  n3: 'grape',
  n4: 'strawberry',
  n5: 'melon',
  n6: 'peach',
  n7: 'plum',
  n8: 'cherry',
};

function build(meanings: Record<string, string>): CollectionState {
  const f = createEventFactory('dev-a', 0, createHlcState('dev-a', T0));
  const events: FlashEvent[] = [
    f.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: 'Fruit',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
        created_at: T0,
      },
      T0,
    ),
    ...Object.entries(meanings).map(([key, meaning], i) =>
      f.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(DECK, key),
          deck_id: DECK,
          source_key: key,
          fields: { word: `w-${key}`, meaning },
          tags: ['fruit'],
          created_order: i,
        },
        T0 + i + 1,
      ),
    ),
  ];
  return replayAllEvents(events);
}

function propsFor(state: CollectionState): AnswerModeRenderProps {
  const card = state.cards.get(deriveCardId(deriveNoteId(DECK, 'n1'), LAYOUT, 0));
  const note = card && state.notes.get(card.note_id);
  const deck = state.decks.get(DECK);
  const layout = state.layouts.get(LAYOUT);
  if (!card || !note || !deck || !layout) throw new Error('fixture is incomplete');
  return {
    state,
    card,
    note,
    deck,
    layout: { ...layout, front_fields: [] },
    noteType: undefined,
    fieldMetaByKey: new Map(),
    populatedRevealSteps: layout.reveal_steps,
    revealStep: 0,
    isRevealed: false,
    isFullyRevealed: false,
    hideFrontRuby: false,
    pinyinToneColors: false,
    studyDayIndex: 20_500,
    evaluation: null,
    onRevealNext: () => {},
    onEvaluateAndReveal: () => {},
  };
}

let root: Root | undefined;
let host: HTMLElement | undefined;

function options(): string[] {
  return [...(host?.querySelectorAll('[data-testid^="choice-option-"]') ?? [])].map(
    (b) => b.textContent ?? '',
  );
}

function show(props: AnswerModeRenderProps): void {
  host ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(host);
  act(() => root?.render(createElement('div', null, choiceAnswerMode.render(props))));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('the open Choice question (§11)', () => {
  it('keeps its options when only other notes change, and rebuilds when its own note does', () => {
    show(propsFor(build(MEANINGS)));
    const before = options();
    expect(before).toHaveLength(4);

    // Every other note is edited, as a sync from another device would do.
    const edited = Object.fromEntries(
      Object.entries(MEANINGS).map(([k, v]) => [k, k === 'n1' ? v : `${v} (edited on B)`]),
    );
    show(propsFor(build(edited)));
    expect(options()).toEqual(before);

    // An edit of the card's own note is part of the question, so it rebuilds.
    show(propsFor(build({ ...edited, n1: 'a green apple' })));
    expect(options().join('|')).toContain('a green apple');
    expect(options()).not.toEqual(before);
  });
});
