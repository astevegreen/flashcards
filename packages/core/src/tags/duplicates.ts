import type { CollectionState } from '../events/replay.ts';
import { normalizeAddedTag } from '../events/tag-adds.ts';
import type { NoteTagsAddedPayload } from '../events/types.ts';
import { normalizeLanguage } from '../languages/normalize.ts';
import type { Note, NoteType } from '../model/types.ts';
import { stripRichText } from '../parsers/rich-text.ts';
import { parseRuby } from '../parsers/ruby.ts';

/**
 * Duplicate finder (Browse): notes in different decks whose key field is the same text, mainly
 * imported lists (HSK, JLPT) that overlap the user's own decks. Import already skips duplicates
 * inside one deck (`source_key`); this looks across the whole collection, read-only. Acting on a
 * group (open, tag, archive) goes through the ordinary Browse events (`tags/bulk.ts`).
 */

export interface DuplicateGroup {
  /** The normalized key text the notes share. */
  key: string;
  /** Normalized deck language the group belongs to (`ja`, `zh-Hans`, `ko`, ...). */
  language: string;
  /** Note ids, sorted by deck name, then note id. */
  noteIds: string[];
  /** Distinct deck ids in the group, sorted by id. */
  deckIds: string[];
}

export interface FindDuplicateOptions {
  /**
   * Only groups whose notes sit in two or more decks (default `true`). With `false`, two notes of
   * one deck with the same key also form a group.
   */
  acrossDecksOnly?: boolean;
  /** Include archived notes (default `false`). Notes of archived decks are always left out. */
  includeArchived?: boolean;
}

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;

/**
 * Width and jamo variants folded to their standard forms: the Halfwidth and Fullwidth Forms
 * block (full-width Latin and digits, half-width katakana and Hangul) and Hangul Compatibility
 * Jamo. Only these runs get NFKC; the rest of the text keeps NFC, because full NFKC would also
 * rewrite circled numbers, unit squares and similar symbols. CJK compatibility ideographs
 * (U+F900 block) are canonical singletons, so plain NFC already maps them to the unified form.
 */
const WIDTH_AND_JAMO_VARIANTS = /[\u3131-\u318e\uff01-\uffef]+/gu;

/**
 * Normalizes a key field for comparison: Unicode NFC, width and compatibility-jamo variants
 * folded, ruby markup (`漢字[かな]`, `{base|reading}`) reduced to one side, whitespace trimmed and
 * inner runs collapsed to one space. Case is kept, so `Polish` and `polish` stay apart.
 *
 * Ruby keeps its base (`学校[がっこう]` -> `学校`), except in Korean decks, where the Hangul side
 * wins (`學校[학교]` -> `학교`), so a Hanja-annotated note matches a plain Hangul one.

 *
 * The field editor's rich-text markup is stripped first (`{b:학교}` -> `학교`), cloze answers
 * included, so bold / colour spans don't hide a match.
 */
export function normalizeDuplicateKey(value: string, language?: string): string {
  const folded = stripRichText(value)
    .normalize('NFC')
    .replace(WIDTH_AND_JAMO_VARIANTS, (run) => run.normalize('NFKC'))
    .normalize('NFC');
  const korean = language !== undefined && normalizeLanguage(language) === 'ko';
  const plain = parseRuby(folded)
    .map((seg) => {
      if (seg.type === 'text') return seg.value;
      if (korean && HANGUL.test(seg.reading) && !HANGUL.test(seg.base)) return seg.reading;
      return seg.base;
    })
    .join('');
  return plain.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** The note type's key field: the field marked `sortKey`, else the first field. */
export function duplicateKeyField(noteType: NoteType | undefined): string | undefined {
  if (!noteType) return undefined;
  return (noteType.fields.find((f) => f.sortKey) ?? noteType.fields[0])?.key;
}

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Groups notes with the same normalized key field and deck language. Deterministic: groups are
 * sorted by language, then key; notes by deck name, then note id.
 */
export function findDuplicateGroups(
  state: CollectionState,
  options: FindDuplicateOptions = {},
): DuplicateGroup[] {
  const acrossDecksOnly = options.acrossDecksOnly ?? true;
  const keyFieldByNoteType = new Map<string, string | undefined>();
  const buckets = new Map<string, { key: string; language: string; notes: Note[] }>();

  for (const note of state.notes.values()) {
    if (note.archived && options.includeArchived !== true) continue;
    const deck = state.decks.get(note.deck_id);
    if (!deck || deck.archived) continue;
    let field = keyFieldByNoteType.get(deck.note_type_id);
    if (!keyFieldByNoteType.has(deck.note_type_id)) {
      field = duplicateKeyField(state.noteTypes.get(deck.note_type_id));
      keyFieldByNoteType.set(deck.note_type_id, field);
    }
    if (field === undefined) continue;
    const language = normalizeLanguage(deck.language);
    const key = normalizeDuplicateKey(note.fields[field] ?? '', language);
    if (key === '') continue;
    const bucketKey = `${language}\u0000${key}`;
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.notes.push(note);
    else buckets.set(bucketKey, { key, language, notes: [note] });
  }

  const deckName = (id: string) => state.decks.get(id)?.name ?? '';
  const groups: DuplicateGroup[] = [];
  for (const { key, language, notes } of buckets.values()) {
    if (notes.length < 2) continue;
    const deckIds = [...new Set(notes.map((n) => n.deck_id))].sort(cmpStr);
    if (acrossDecksOnly && deckIds.length < 2) continue;
    const noteIds = [...notes]
      .sort((a, b) => cmpStr(deckName(a.deck_id), deckName(b.deck_id)) || cmpStr(a.id, b.id))
      .map((n) => n.id);
    groups.push({ key, language, noteIds, deckIds });
  }
  return groups.sort((a, b) => cmpStr(a.language, b.language) || cmpStr(a.key, b.key));
}

/** The tag the duplicate finder adds, so the notes can be found again with `#duplicate`. */
export const DUPLICATE_TAG = 'duplicate';

/**
 * Set-union `NoteTagsAdded` payloads tagging exactly `noteIds` with {@link DUPLICATE_TAG}
 * (sorted by note id, skipping unknown notes and notes that already carry it). Unlike a
 * `NoteUpserted` tag rewrite, an add never overwrites a concurrent tag edit on another device.
 */
export function planDuplicateTagAdds(
  state: CollectionState,
  noteIds: Iterable<string>,
): NoteTagsAddedPayload[] {
  const tag = normalizeAddedTag(DUPLICATE_TAG);
  const out: NoteTagsAddedPayload[] = [];
  for (const id of [...new Set(noteIds)].sort(cmpStr)) {
    const note = state.notes.get(id);
    if (!note || note.tags.some((t) => normalizeAddedTag(t) === tag)) continue;
    out.push({ note_id: id, tags: [tag] });
  }
  return out;
}
