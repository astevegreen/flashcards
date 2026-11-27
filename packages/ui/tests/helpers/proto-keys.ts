// Fixtures for the S4 tests: field keys that exist only on Object.prototype (`constructor`,
// `toString`) which a layout or note type names but the note lacks. A raw `note.fields[key]` read
// answers with the inherited function there; `noteField` answers undefined.
import {
  createEventFactory,
  createHlcState,
  deriveNoteId,
  type FlashEvent,
  type Layout,
  type NoteType,
} from '@flash/core';
import { expect, vi } from 'vitest';
import type { AnswerModeRenderProps } from '../../src/study/answerModes/types.ts';

export const PROTO_KEYS = ['constructor', 'toString'];
const FIELD_KEYS = [...PROTO_KEYS, 'word'];
const T0 = Date.UTC(2026, 4, 1, 9, 0, 0);

export const protoNote = {
  id: 'note-proto',
  deck_id: 'deck-proto-a',
  fields: { word: 'hello' },
  tags: [],
} as unknown as AnswerModeRenderProps['note'];

export const protoLayout = (over: Partial<Layout> = {}): Layout => ({
  id: 'layout:proto',
  note_type_id: 'nt-proto',
  name: 'Proto',
  front_fields: FIELD_KEYS,
  reveal_steps: [FIELD_KEYS, ['toString']],
  answer_mode: 'flip',
  hide_furigana_on_front: false,
  enabled: true,
  ...over,
});

const textField = (key: string, sortKey = false) => ({
  key,
  label: key,
  kind: 'text' as const,
  lang: 'en',
  ...(sortKey ? { sortKey } : {}),
});

/** Field keys `constructor`, `toString`, then `word` (the duplicate key). */
const PROTO_TYPE: NoteType = {
  id: 'nt-proto',
  name: 'Proto',
  fields: [textField('constructor'), textField('toString'), textField('word', true)],
};
/** No `word` or `character` field, so the drawing code falls back to the first field. */
const PROTO_PLAIN_TYPE: NoteType = {
  id: 'nt-proto-plain',
  name: 'Proto plain',
  fields: [textField('constructor'), textField('toString'), textField('other', true)],
};

/**
 * Three Japanese decks of notes that lack every proto key: A and B share a duplicate key
 * (`word`), C uses the plain type. Each deck has one enabled flip layout.
 */
export function protoEvents(): FlashEvent[] {
  const f = createEventFactory('dev-proto', 0, createHlcState('dev-proto', T0));
  const events: FlashEvent[] = [
    f.create('NoteTypeChanged', { note_type: PROTO_TYPE }, T0),
    f.create('NoteTypeChanged', { note_type: PROTO_PLAIN_TYPE }, T0),
    f.create('LayoutChanged', { layout: protoLayout() }, T0),
    f.create(
      'LayoutChanged',
      {
        layout: protoLayout({
          id: 'layout:proto-plain',
          note_type_id: 'nt-proto-plain',
          front_fields: PROTO_KEYS,
          reveal_steps: [PROTO_KEYS],
          answer_mode: 'draw',
        }),
      },
      T0,
    ),
  ];
  const decks: [string, string, string][] = [
    ['deck-proto-a', 'Proto A', 'nt-proto'],
    ['deck-proto-b', 'Proto B', 'nt-proto'],
    ['deck-proto-c', 'Proto C', 'nt-proto-plain'],
  ];
  decks.forEach(([deckId, name, typeId], i) => {
    events.push(
      f.create(
        'DeckCreated',
        { deck_id: deckId, name, note_type_id: typeId, language: 'ja', created_at: T0 },
        T0 + i,
      ),
      f.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(deckId, 'n1'),
          deck_id: deckId,
          source_key: 'n1',
          fields: typeId === 'nt-proto' ? { word: 'dup' } : { other: 'x' },
          tags: [],
          created_order: 0,
        },
        T0 + i,
      ),
    );
  });
  return events;
}

/** Fails when React logged "Functions are not valid as a React child" or anything else. */
export function spyConsoleErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

export function expectNoProtoLeak(container: HTMLElement) {
  const html = container.innerHTML;
  expect(html).not.toContain('native code');
  for (const key of PROTO_KEYS) expect(html).not.toContain(`field-${key}`);
}
