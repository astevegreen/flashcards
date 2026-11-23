import {
  createEventFactory,
  replayAllEvents,
  type CollectionState,
} from '../../src/events/replay.ts';
import type { EventPayloadMap, KnownEvent, KnownEventType } from '../../src/events/types.ts';
import { createHlcState } from '../../src/hlc.ts';
import { deriveCardId } from '../../src/ids.ts';
import type { Layout, NoteType } from '../../src/model/types.ts';
import { sha256Hex } from '../../src/sources/hash.ts';

/**
 * A small collection for the Anki export tests (core CSV and the platform `.apkg` round trip):
 * a Japanese vocab note type with ruby, image, audio and multi-line fields, two layouts (flip
 * with furigana hidden on the front, typed), a cloze deck, tags with spaces and a hierarchy,
 * one archived note and one note whose image isn't in the collection's media list.
 */

export const T0 = Date.UTC(2026, 10, 23, 9, 0, 0);
export const VOCAB_DECK = 'deck-ja-vocab';
export const CLOZE_DECK = 'deck-ja-cloze';

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 9]);
export const PNG_HASH = sha256Hex(PNG);
export const MP3_HASH = sha256Hex(MP3);
export const UNKNOWN_HASH = 'f'.repeat(64);

export const VOCAB_TYPE: NoteType = {
  id: 'nt-ja-vocab',
  name: 'Japanese Vocab',
  fields: [
    { key: 'word', label: 'Word', kind: 'text', lang: 'ja' },
    { key: 'meaning', label: 'Meaning', kind: 'text', lang: 'en' },
    { key: 'image', label: 'Picture', kind: 'image', lang: 'ja' },
    { key: 'audio', label: 'Audio', kind: 'audio', lang: 'ja' },
    { key: 'notes', label: 'Notes: extra', kind: 'rich', lang: 'en' },
  ],
};

export const VOCAB_FLIP: Layout = {
  id: 'layout-ja-flip',
  note_type_id: VOCAB_TYPE.id,
  name: 'Recognition',
  front_fields: ['word'],
  reveal_steps: [
    ['meaning', 'image'],
    ['audio', 'notes'],
  ],
  answer_mode: 'flip',
  hide_furigana_on_front: true,
  enabled: true,
};

export const VOCAB_TYPED: Layout = {
  id: 'layout-ja-typed',
  note_type_id: VOCAB_TYPE.id,
  name: 'Production',
  front_fields: ['meaning'],
  reveal_steps: [['word']],
  answer_mode: 'typed',
  answer_field: 'word',
  hide_furigana_on_front: false,
  enabled: true,
};

export const CLOZE_TYPE: NoteType = {
  id: 'nt-ja-cloze',
  name: 'Japanese Cloze',
  fields: [
    { key: 'text', label: 'Text', kind: 'text', lang: 'ja' },
    { key: 'extra', label: 'Extra', kind: 'text', lang: 'en' },
  ],
};

export const CLOZE_LAYOUT: Layout = {
  id: 'layout-ja-cloze',
  note_type_id: CLOZE_TYPE.id,
  name: 'Cloze',
  front_fields: ['text'],
  reveal_steps: [['extra']],
  answer_mode: 'cloze',
  hide_furigana_on_front: false,
  enabled: true,
};

/** Note 1's typed card, suspended. */
export const SUSPENDED_CARD = deriveCardId('note-1', 'layout-ja-typed', 0);

export function buildAnkiExportState(): CollectionState {
  const f = createEventFactory('dev-x', 0, createHlcState('dev-x', T0));
  let t = T0;
  const ev: KnownEvent[] = [];
  const push = <K extends KnownEventType>(type: K, payload: EventPayloadMap[K]) => {
    t += 1000;
    ev.push(f.create(type, payload, t));
  };
  push('MediaAdded', {
    media: { hash: PNG_HASH, ext: 'png', mime: 'image/png', size: PNG.length },
  });
  push('MediaAdded', {
    media: { hash: MP3_HASH, ext: 'mp3', mime: 'audio/mpeg', size: MP3.length },
  });
  push('NoteTypeChanged', { note_type: VOCAB_TYPE });
  push('LayoutChanged', { layout: VOCAB_FLIP });
  push('LayoutChanged', { layout: VOCAB_TYPED });
  push('NoteTypeChanged', { note_type: CLOZE_TYPE });
  push('LayoutChanged', { layout: CLOZE_LAYOUT });
  push('DeckCreated', {
    deck_id: VOCAB_DECK,
    name: 'Japanese::Vocab',
    note_type_id: VOCAB_TYPE.id,
    language: 'ja',
  });
  push('DeckCreated', {
    deck_id: CLOZE_DECK,
    name: 'Japanese Cloze',
    note_type_id: CLOZE_TYPE.id,
    language: 'ja',
  });
  push('NoteUpserted', {
    note_id: 'note-1',
    deck_id: VOCAB_DECK,
    source_key: 'v1',
    created_order: 1,
    fields: {
      word: '日本語[にほんご]を{食べる|たべる}',
      meaning: 'Japanese, "quoted" <b>',
      image: `media:${PNG_HASH}`,
      audio: `media:${MP3_HASH}`,
      notes: 'line one\nline two',
    },
    tags: ['jlpt n5', 'grammar::verbs'],
  });
  push('NoteUpserted', {
    note_id: 'note-2',
    deck_id: VOCAB_DECK,
    source_key: 'anki:AbC123guid',
    created_order: 2,
    fields: { word: 'test[abc] & {今日|きょう}', meaning: 'today' },
    tags: [],
  });
  push('NoteUpserted', {
    note_id: 'note-3',
    deck_id: VOCAB_DECK,
    source_key: 'v3',
    created_order: 3,
    fields: { word: '学校[がっこう]', meaning: 'school', image: `media:${UNKNOWN_HASH}` },
    tags: ['topik'],
  });
  push('NoteUpserted', {
    note_id: 'note-archived',
    deck_id: VOCAB_DECK,
    source_key: 'v4',
    created_order: 4,
    fields: { word: '古い', meaning: 'old' },
  });
  push('NoteArchived', { note_id: 'note-archived' });
  push('NoteUpserted', {
    note_id: 'cloze-1',
    deck_id: CLOZE_DECK,
    source_key: 'c1',
    created_order: 1,
    fields: {
      text: '{{c1::{今日|きょう}::today}}は{{c2::晴れ[はれ]}}です',
      extra: 'weather',
    },
    tags: ['cloze'],
  });
  push('CardSuspended', { card_id: SUSPENDED_CARD });
  return replayAllEvents(ev);
}
