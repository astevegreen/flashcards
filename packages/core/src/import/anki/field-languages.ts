import type { CollectionState, EventFactory } from '../../events/replay.ts';
import type { KnownEvent } from '../../events/types.ts';
import type { AnkiImportedNoteType } from './convert.ts';

/**
 * Changing the language of an imported Anki field after the import (Phase 14). Anki stores no
 * field language, so the importer guesses one from each field's scripts; the import summary
 * shows that guess per field and lets the person correct it. A change is ordinary events: a
 * `NoteTypeChanged` with the field (and its companion image/audio fields) in the new language,
 * plus `DeckSettingsChanged` for the imported decks whose language came from that field.
 */

export interface AnkiFieldLanguageOption {
  code: string;
  label: string;
}

/** Languages the field-language editor offers (a field's current language is always kept too). */
export const ANKI_FIELD_LANGUAGES: readonly AnkiFieldLanguageOption[] = [
  { code: 'ko', label: 'Korean' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh-Hans', label: 'Chinese (Simplified)' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)' },
  { code: 'en', label: 'English' },
];

/** A short BCP 47-shaped tag (`ko`, `zh-Hant`, `pt-BR`): letters, digits and hyphens only. */
export function isAnkiFieldLanguage(code: string): boolean {
  if (code.length < 2 || code.length > 35 || code.startsWith('-') || code.endsWith('-')) {
    return false;
  }
  for (const ch of code) {
    const ok =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '-';
    if (!ok) return false;
  }
  return true;
}

function noteTypeEvent(
  state: CollectionState,
  imported: AnkiImportedNoteType,
  fieldKey: string,
  lang: string,
  factory: EventFactory,
  nowMs: number,
): KnownEvent | undefined {
  const noteType = state.noteTypes.get(imported.noteTypeId);
  const field = imported.fields.find((f) => f.key === fieldKey);
  if (!noteType || !field) return undefined;
  const keys = new Set([field.key, ...field.mediaKeys]);
  let changed = false;
  const fields = noteType.fields.map((f) => {
    if (!keys.has(f.key) || f.lang === lang) return f;
    changed = true;
    return { ...f, lang };
  });
  if (!changed) return undefined;
  return factory.create('NoteTypeChanged', { note_type: { ...noteType, fields } }, nowMs);
}

function deckEvents(
  state: CollectionState,
  imported: AnkiImportedNoteType,
  lang: string,
  factory: EventFactory,
  nowMs: number,
): KnownEvent[] {
  const events: KnownEvent[] = [];
  for (const deckId of imported.deckIds) {
    const deck = state.decks.get(deckId);
    if (!deck || deck.language === lang) continue;
    events.push(factory.create('DeckSettingsChanged', { deck_id: deckId, language: lang }, nowMs));
  }
  return events;
}

/**
 * Events that set `fieldKey` of an imported note type to `lang`; empty when nothing changes, the
 * note type or field is gone, or `lang` is not a language tag.
 */
export function ankiFieldLanguageEvents(
  state: CollectionState,
  imported: AnkiImportedNoteType,
  fieldKey: string,
  lang: string,
  factory: EventFactory,
  nowMs: number = Date.now(),
): KnownEvent[] {
  if (!isAnkiFieldLanguage(lang)) return [];
  const events: KnownEvent[] = [];
  const noteType = noteTypeEvent(state, imported, fieldKey, lang, factory, nowMs);
  if (noteType) events.push(noteType);
  if (fieldKey === imported.languageFieldKey) {
    events.push(...deckEvents(state, imported, lang, factory, nowMs));
  }
  return events;
}
