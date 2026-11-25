import { describe, expect, it } from 'vitest';
import { resolveCardAudioTarget } from '../src/audio/tts.ts';
import { createEventFactory, replayAllEvents } from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { deriveNoteId } from '../src/ids.ts';
import { planAnkiModel } from '../src/import/anki/model-plan.ts';
import type { AnkiModel, AnkiNote } from '../src/import/anki/types.ts';
import type { Layout } from '../src/model/types.ts';
import { generateChoiceOptions } from '../src/study/choice.ts';

const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);

const layoutBase: Omit<Layout, 'id' | 'name' | 'front_fields' | 'answer_mode'> = {
  note_type_id: 'nt-proto',
  reveal_steps: [['toString']],
  hide_furigana_on_front: false,
  enabled: true,
};

/** A note type whose field keys shadow `Object.prototype`, and a note that leaves them empty. */
function protoCollection() {
  const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
  const events: FlashEvent[] = [
    f.create(
      'NoteTypeChanged',
      {
        note_type: {
          id: 'nt-proto',
          name: 'Proto',
          fields: [
            { key: 'word', label: 'Word', kind: 'text', lang: 'en' },
            { key: 'constructor', label: 'C', kind: 'text', lang: 'en', tts: true },
            { key: 'toString', label: 'S', kind: 'text', lang: 'en' },
          ],
        },
      },
      t0,
    ),
    f.create(
      'LayoutChanged',
      {
        layout: {
          ...layoutBase,
          id: 'l-cloze',
          name: 'Cloze',
          front_fields: ['constructor'],
          answer_mode: 'cloze',
        },
      },
      t0 + 1,
    ),
    f.create(
      'LayoutChanged',
      {
        layout: {
          ...layoutBase,
          id: 'l-choice',
          name: 'Choice',
          front_fields: ['word'],
          answer_mode: 'choice',
          answer_field: 'toString',
          speak_field: 'valueOf',
          required_field: 'word',
        },
      },
      t0 + 2,
    ),
    f.create(
      'DeckCreated',
      {
        deck_id: 'd1',
        name: 'Proto',
        note_type_id: 'nt-proto',
        language: 'en',
        settings: { enabled_layout_ids: ['l-cloze', 'l-choice'] },
      },
      t0 + 3,
    ),
    f.create(
      'NoteUpserted',
      {
        note_id: deriveNoteId('d1', 'k1'),
        deck_id: 'd1',
        source_key: 'k1',
        fields: { word: 'school' },
      },
      t0 + 4,
    ),
  ];
  return events;
}

describe('field keys that shadow Object.prototype (S4)', () => {
  it('replay, choice and TTS read only the note’s own fields', () => {
    const state = replayAllEvents(protoCollection());
    const cards = [...state.cards.values()];
    expect(cards.map((c) => c.layout_id).sort()).toEqual(['l-choice', 'l-cloze']);

    const choiceCard = cards.find((c) => c.layout_id === 'l-choice');
    if (!choiceCard) throw new Error('choice card missing');
    const question = generateChoiceOptions(state, choiceCard, 0);
    expect(question.options).toEqual([]);

    const note = state.notes.get(choiceCard.note_id);
    const layout = state.layouts.get('l-choice');
    const deck = state.decks.get('d1');
    if (!note || !layout || !deck) throw new Error('collection incomplete');
    const target = resolveCardAudioTarget(note, layout, state.noteTypes.get('nt-proto'), deck);
    expect(target.attachedMediaHash).toBeUndefined();
  });

  it('Anki import never plans a field key named after an Object.prototype member', () => {
    const model = {
      id: '1',
      name: 'M',
      kind: 'standard',
      fields: [
        { ord: 0, name: 'Constructor' },
        { ord: 1, name: 'Meaning' },
      ],
      templates: [{ ord: 0, name: 'Card 1', qfmt: '{{Constructor}}', afmt: '{{Meaning}}' }],
    } as unknown as AnkiModel;
    const note = { fields: ['', 'x'] } as unknown as AnkiNote;
    const plan = planAnkiModel(model, [note], {
      templateOrdsWithCards: new Set([0]),
      collectionUsesKana: false,
      isUsableMedia: () => false,
    });
    expect(plan.noteType.fields.map((f) => f.key)).toEqual(['constructor_2', 'meaning']);
  });
});
