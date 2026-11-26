/**
 * Reads the field references out of an Anki card template (`qfmt` / `afmt`). Only what maps to
 * this app's Layouts is kept: which fields a side shows (in order), with which filters, and
 * which fields are typed answers or TTS sources. Conditionals (`{{#F}}…{{/F}}`) are noted but not
 * evaluated. Single pass over `{{…}}` markers (no regex).
 */

export interface AnkiFieldRef {
  /** Field name exactly as written in the template. */
  field: string;
  /** Filters, outermost first (`{{furigana:Reading}}` -> `['furigana']`). */
  filters: string[];
}

export interface AnkiTemplateSide {
  /** Field references in document order (duplicates kept once). */
  refs: AnkiFieldRef[];
  /**
   * Every field reference with its filters, duplicates included (`{{Reading}}` and
   * `{{kana:Reading}}` on one side are two uses), so a field's furigana handling can follow how
   * the templates actually show it.
   */
  uses: AnkiFieldRef[];
  /** `{{FrontSide}}` appears (answer side only). */
  includesFrontSide: boolean;
  /** `{{type:Field}}` targets. */
  typed: string[];
  /** `{{type:cloze:Field}}` targets. */
  typedCloze: string[];
  /** `{{tts <lang> …:Field}}` targets with their Anki language code (`ja_JP`). */
  tts: Array<{ field: string; lang: string }>;
  /** Fields used as `{{#F}}` / `{{^F}}` conditions. */
  conditions: string[];
}

/** Anki's built-in template names that are not note fields. */
const SPECIAL_NAMES = new Set([
  'FrontSide',
  'Tags',
  'Type',
  'Deck',
  'Subdeck',
  'Card',
  'CardFlag',
  'CardID',
]);

/** Filters that only change how a field renders (all others are treated the same way). */
export const FURIGANA_FILTERS = new Set(['furigana', 'kana', 'kanji']);

/** Keys already in each deduplicated list of the side being parsed. */
interface SeenKeys {
  conditions: Set<string>;
  typed: Set<string>;
  typedCloze: Set<string>;
  tts: Set<string>;
  refs: Set<string>;
}

/** Appends `value` unless `key` is already in the list: a set lookup, not a scan (P9). */
function pushUnique<T>(list: T[], seen: Set<string>, key: string, value: T): void {
  if (seen.has(key)) return;
  seen.add(key);
  list.push(value);
}

function addTag(side: AnkiTemplateSide, seen: SeenKeys, inner: string): void {
  const first = inner[0];
  if (first === '!' || first === '/') return;
  if (first === '#' || first === '^') {
    const name = inner.slice(1).trim();
    if (name) pushUnique(side.conditions, seen.conditions, name, name);
    return;
  }
  const parts = inner.split(':').map((p) => p.trim());
  const field = parts.pop() ?? '';
  if (!field) return;
  if (field === 'FrontSide' && parts.length === 0) {
    side.includesFrontSide = true;
    return;
  }
  if (SPECIAL_NAMES.has(field) && parts.length === 0) return;
  const filters = parts.filter((p) => p.length > 0);
  const head = filters[0] ?? '';
  if (head === 'type') {
    if (filters[1] === 'cloze') pushUnique(side.typedCloze, seen.typedCloze, field, field);
    else pushUnique(side.typed, seen.typed, field, field);
    return;
  }
  if (head.startsWith('tts ') || head === 'tts') {
    const lang = head.slice(4).trim().split(' ')[0] ?? '';
    pushUnique(side.tts, seen.tts, field, { field, lang });
    return;
  }
  side.uses.push({ field, filters });
  pushUnique(side.refs, seen.refs, field, { field, filters });
}

/** Parses one side of an Anki card template. */
export function parseAnkiTemplate(template: string): AnkiTemplateSide {
  const side: AnkiTemplateSide = {
    refs: [],
    uses: [],
    includesFrontSide: false,
    typed: [],
    typedCloze: [],
    tts: [],
    conditions: [],
  };
  const seen: SeenKeys = {
    conditions: new Set(),
    typed: new Set(),
    typedCloze: new Set(),
    tts: new Set(),
    refs: new Set(),
  };
  let pos = 0;
  for (;;) {
    const open = template.indexOf('{{', pos);
    if (open === -1) break;
    const close = template.indexOf('}}', open + 2);
    if (close === -1) break;
    addTag(side, seen, template.slice(open + 2, close).trim());
    pos = close + 2;
  }
  return side;
}
