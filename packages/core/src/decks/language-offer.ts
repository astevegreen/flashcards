import type { CollectionState, EventFactory } from '../events/replay.ts';
import type { DeckLanguageOfferedPayload, KnownEvent, UnknownEvent } from '../events/types.ts';
import { guessCjkLanguageFromText } from '../languages/guess-script.ts';
import { noteField } from '../model/note-fields.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../model/presets.ts';
import type { Deck } from '../model/types.ts';

/**
 * The one-time offer to set a deck's language from its text. Decks linked from a sheet before C8
 * (#93) were given `en` whatever their sentences were in, so their audio speaks English. For a
 * Sentence, Cloze or Grammar deck whose text is mostly kana/kanji, Hangul or Hanzi while its
 * language says otherwise, the Library offers once to set the language that text is in
 * (detected as C8 does for new links, `guessCjkLanguageFromText`).
 *
 * Taking it writes a `DeckSettingsChanged` with the new language (undone by another one); either
 * answer writes a `DeckLanguageOffered`, a log-retained record, so the offer never comes back for
 * that deck on any device, after sync, replay or a snapshot. Nothing on the study screen imports
 * this module (§8).
 */

/** The fields of each language-neutral type that hold text in the language being learnt. */
const TEXT_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  [BUILTIN_NOTE_TYPE_IDS.SENTENCE, ['sentence']],
  [BUILTIN_NOTE_TYPE_IDS.CLOZE, ['text']],
  [BUILTIN_NOTE_TYPE_IDS.GRAMMAR, ['pattern', 'example']],
]);

/** Notes looked at per deck; the script guess stops at a few thousand characters anyway. */
const NOTE_SAMPLE = 50;

interface Folded {
  length: number;
  decks: Set<string>;
}

const cache = new WeakMap<readonly UnknownEvent[], Folded>();

function offeredDecks(state: CollectionState): ReadonlySet<string> {
  const events = state.unknownEvents;
  const hit = cache.get(events);
  if (hit?.length === events.length) return hit.decks;
  const decks = new Set<string>();
  for (const ev of events) {
    if (ev.type !== 'DeckLanguageOffered') continue;
    const p = ev.payload as Partial<DeckLanguageOfferedPayload> | null;
    if (typeof p?.deck_id === 'string' && p.deck_id !== '') decks.add(p.deck_id);
  }
  cache.set(events, { length: events.length, decks });
  return decks;
}

/** Whether the deck was already offered a language (taken or not), on any device. */
export function wasDeckLanguageOffered(state: CollectionState, deckId: string): boolean {
  return offeredDecks(state).has(deckId);
}

function primarySubtag(language: string): string {
  return language.split('-')[0]?.toLowerCase() ?? '';
}

function* deckTexts(state: CollectionState, deck: Deck, keys: readonly string[]) {
  let taken = 0;
  for (const noteId of state.noteIdsByDeck.get(deck.id) ?? []) {
    const note = state.notes.get(noteId);
    if (!note || note.archived) continue;
    for (const key of keys) {
      const text = noteField(note, key);
      if (text) yield text;
    }
    if (++taken >= NOTE_SAMPLE) return;
  }
}

/**
 * The language to offer for `deck`, or `undefined` when there is nothing to offer: the deck is
 * archived, not Sentence, Cloze or Grammar, was offered before, its text is not mostly Japanese,
 * Korean or Chinese script, or its language already matches (`zh-Hant` matches Hanzi text).
 */
export function deckLanguageOffer(state: CollectionState, deck: Deck): string | undefined {
  const keys = TEXT_FIELDS.get(deck.note_type_id);
  if (!keys || deck.archived || wasDeckLanguageOffered(state, deck.id)) return undefined;
  const detected = guessCjkLanguageFromText(deckTexts(state, deck, keys));
  if (!detected || primarySubtag(detected) === primarySubtag(deck.language)) return undefined;
  return detected;
}

/**
 * The events for the user's answer: taking the offer sets the deck's language with a
 * `DeckSettingsChanged`; either answer ends with the `DeckLanguageOffered` record.
 */
export function deckLanguageOfferEvents(
  factory: EventFactory,
  deckId: string,
  language: string,
  accepted: boolean,
  nowMs: number,
): KnownEvent[] {
  const events: KnownEvent[] = [];
  if (accepted) {
    events.push(factory.create('DeckSettingsChanged', { deck_id: deckId, language }, nowMs));
  }
  events.push(
    factory.create('DeckLanguageOffered', { deck_id: deckId, language, accepted }, nowMs),
  );
  return events;
}
