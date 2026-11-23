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

function pushUnique<T>(list: T[], value: T, same: (a: T) => boolean): void {
  if (!list.some(same)) list.push(value);
}

function addTag(side: AnkiTemplateSide, inner: string): void {
  const first = inner[0];
  if (first === '!' || first === '/') return;
  if (first === '#' || first === '^') {
    const name = inner.slice(1).trim();
    if (name) pushUnique(side.conditions, name, (c) => c === name);
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
    if (filters[1] === 'cloze') pushUnique(side.typedCloze, field, (f) => f === field);
    else pushUnique(side.typed, field, (f) => f === field);
    return;
  }
  if (head.startsWith('tts ') || head === 'tts') {
    const lang = head.slice(4).trim().split(' ')[0] ?? '';
    pushUnique(side.tts, { field, lang }, (t) => t.field === field);
    return;
  }
  side.uses.push({ field, filters });
  pushUnique(side.refs, { field, filters }, (r) => r.field === field);
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
  let pos = 0;
  for (;;) {
    const open = template.indexOf('{{', pos);
    if (open === -1) break;
    const close = template.indexOf('}}', open + 2);
    if (close === -1) break;
    addTag(side, template.slice(open + 2, close).trim());
    pos = close + 2;
  }
  return side;
}
