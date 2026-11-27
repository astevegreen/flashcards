import { BUILTIN_NOTE_TYPE_IDS, BUILTIN_NOTE_TYPES } from './presets.ts';
import type { Deck, NoteType } from './types.ts';

/**
 * Built-in note types that are not tied to one language: a Korean, Japanese or English deck can
 * each use them. The tags on their target-language fields are only defaults, so the deck's own
 * language takes their place (see {@link noteTypeForDeck}).
 */
export const LANGUAGE_NEUTRAL_NOTE_TYPE_IDS: ReadonlySet<string> = new Set([
  BUILTIN_NOTE_TYPE_IDS.CLOZE,
  BUILTIN_NOTE_TYPE_IDS.SENTENCE,
  BUILTIN_NOTE_TYPE_IDS.GRAMMAR,
]);

/** The fields of each language-neutral type written in the language being learnt. */
const TARGET_LANGUAGE_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [BUILTIN_NOTE_TYPE_IDS.CLOZE, new Set(['text', 'audio'])],
  [BUILTIN_NOTE_TYPE_IDS.SENTENCE, new Set(['sentence', 'reading', 'audio'])],
  [BUILTIN_NOTE_TYPE_IDS.GRAMMAR, new Set(['pattern', 'example', 'audio'])],
]);

const cache = new WeakMap<NoteType, Map<string, NoteType>>();

function fieldLang(kind: string, deckLanguage: string): string {
  // A Chinese reading is pinyin, which is never spoken with a Chinese voice.
  if (kind === 'reading' && deckLanguage.toLowerCase().startsWith('zh')) return 'zh-Latn-pinyin';
  return deckLanguage;
}

/**
 * The note type as a deck sees it. A language-neutral built-in (Sentence, Cloze, Grammar) gets
 * the deck's language on its target-language fields, so a Korean sentence is spoken with a Korean
 * voice and set in Korean type. A field whose language is no longer the preset's default keeps it
 * (someone set it on purpose). Every other note type comes back unchanged. The result is cached
 * per note type and language, so it is the same object on every render.
 */
export function noteTypeForDeck(noteType: NoteType, deckLanguage: string | undefined): NoteType {
  const targets = TARGET_LANGUAGE_FIELDS.get(noteType.id);
  if (!targets || !deckLanguage) return noteType;
  let byLang = cache.get(noteType);
  if (!byLang) {
    byLang = new Map();
    cache.set(noteType, byLang);
  }
  const hit = byLang.get(deckLanguage);
  if (hit) return hit;
  // The built-ins are seeded from code, not from events, so a field whose language is not the
  // one it ships with was given it by an event (synced, restored or imported): someone chose it.
  const preset = BUILTIN_NOTE_TYPES.find((p) => p.id === noteType.id)?.fields;
  let changed = false;
  const fields = noteType.fields.map((f) => {
    if (!targets.has(f.key) || preset?.find((p) => p.key === f.key)?.lang !== f.lang) return f;
    const lang = fieldLang(f.kind, deckLanguage);
    if (lang === f.lang) return f;
    changed = true;
    return { ...f, lang };
  });
  const out = changed ? { ...noteType, fields } : noteType;
  byLang.set(deckLanguage, out);
  return out;
}

/** The deck's note type with its field languages resolved for the deck ({@link noteTypeForDeck}). */
export function deckNoteType(
  state: { readonly noteTypes: ReadonlyMap<string, NoteType> },
  deck: Pick<Deck, 'note_type_id' | 'language'> | undefined,
): NoteType | undefined {
  if (!deck) return undefined;
  const noteType = state.noteTypes.get(deck.note_type_id);
  return noteType ? noteTypeForDeck(noteType, deck.language) : undefined;
}
