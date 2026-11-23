import { parseMediaHashUri } from '../../audio/tts.ts';
import type { CollectionState } from '../../events/replay.ts';
import type { Note, NoteType, NoteTypeField } from '../../model/types.ts';
import { parseRuby } from '../../parsers/ruby.ts';
import { normalizeTagList } from '../../tags/index.ts';

/**
 * Turns this app's plain-text fields into Anki field HTML, for both "Export for Anki" CSV and
 * `.apkg` export. The output is a string written to a file for Anki to read; this app never
 * renders it (§13).
 *
 * - Text is HTML-escaped and line breaks become `<br>`.
 * - Ruby (`漢字[かんじ]`, `{base|reading}`, `{日本|に|ほん}`) becomes Anki furigana
 *   (` 漢字[かんじ]`): a space marks where each base starts, and Anki's `furigana:` filter
 *   consumes it. A space of the text itself right before a base is written `&#32;`. Literal
 *   brackets in plain text are written as `&#91;` / `&#93;`, so Anki's furigana filter cannot
 *   mistake `test[abc]` for ruby.
 * - A field that holds only `media:<sha256>` becomes `<img src="…">` or `[sound:…]`, with the
 *   file named `<sha256>.<ext>` (see {@link AnkiMediaNamer}).
 */

/**
 * Hook for markup this app adds to text fields later (for example the field editor's limited
 * rich text: bold, italic, colour). It receives the raw field text and `plain`, which converts
 * a run of ordinary text (ruby included) to Anki HTML. It returns the field's Anki HTML: for
 * example `<b>` + `plain(boldPart)` + `</b>`. Without a hook the whole text goes through `plain`.
 */
export type AnkiRichTextConverter = (
  text: string,
  plain: (run: string) => string,
  field: NoteTypeField,
) => string;

export interface AnkiMediaFile {
  /** File name in Anki's media folder (`<sha256>.<ext>`). */
  name: string;
  hash: string;
  mime: string;
}

/**
 * The media types the exports write: the same allow-list as `SAFE_MEDIA_MIME_BY_EXT` in
 * `import/media-types.ts` (a test keeps them equal). It's a copy because importing that module
 * here splits a shared chunk and grows the study-screen bundle (§8). A `Map`, so inherited keys
 * such as `constructor` never match.
 */
export const ANKI_MEDIA_MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
]);

/**
 * Names media files for Anki and remembers which ones the exported notes use. `<sha256>.<ext>`
 * is unique, stable across exports (Anki keeps one copy per name) and needs no original name.
 */
export class AnkiMediaNamer {
  readonly used = new Map<string, AnkiMediaFile>();
  /** Hashes referenced by notes but not in the collection's media list. */
  readonly unknown = new Set<string>();

  private readonly state: CollectionState;

  constructor(state: CollectionState) {
    this.state = state;
  }

  /** The media file for `hash`, or `undefined` when the collection has no such media entry. */
  file(hash: string): AnkiMediaFile | undefined {
    const key = hash.toLowerCase();
    const existing = this.used.get(key);
    if (existing) return existing;
    const entry = this.state.media.get(key) ?? this.state.media.get(hash);
    const ext = entry?.ext.toLowerCase().replace(/^\./, '') ?? '';
    // The extension comes from synced `MediaAdded` events (only type-checked), and it ends up in
    // zip paths and `[sound:…]`: only the importers' allow-list passes, and the hash must be hex.
    const mime = ANKI_MEDIA_MIME_BY_EXT.get(ext);
    if (!entry || !mime || !/^[0-9a-f]+$/.test(key)) {
      this.unknown.add(key);
      return undefined;
    }
    const file = { name: `${key}.${ext === 'jpeg' ? 'jpg' : ext}`, hash: key, mime };
    this.used.set(key, file);
    return file;
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '[': '&#91;',
  ']': '&#93;',
};

/** Escapes text for an Anki HTML field (brackets too, see the module docs). */
export function escapeAnkiText(text: string): string {
  return text.replace(/[&<>"[\]]/g, (ch) => HTML_ESCAPES[ch] ?? ch).replace(/\r?\n/g, '<br>');
}

/**
 * Escapes a ruby base: a literal space inside it would cut the base there, so spaces become
 * `&#160;` (a numeric entity, which both Anki and this app's importer keep inside the base).
 */
function escapeRubyBase(base: string): string {
  return escapeAnkiText(base).replace(/ /g, '&#160;');
}

/**
 * Plain text with ruby to Anki HTML + furigana. Each base gets a leading space unless it starts
 * the field or follows a tag (`>`), where Anki's furigana rule already starts a base.
 */
export function rubyTextToAnkiHtml(text: string): string {
  let out = '';
  for (const seg of parseRuby(text)) {
    if (seg.type === 'text') {
      out += escapeAnkiText(seg.value);
      continue;
    }
    // The text's own space before a base is written as `&#32;`: Anki consumes one literal space
    // as the base marker, and importers collapse runs of spaces.
    if (out.endsWith(' ')) out = `${out.slice(0, -1)}&#32;`;
    if (out.length > 0 && !out.endsWith('>')) out += ' ';
    out += `${escapeRubyBase(seg.base)}[${escapeAnkiText(seg.reading)}]`;
  }
  return out;
}

/** True when the text holds ruby this app would render (decides `{{furigana:…}}` use). */
export function hasRuby(text: string): boolean {
  return parseRuby(text).some((seg) => seg.type === 'ruby');
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export interface AnkiFieldHtmlContext {
  media: AnkiMediaNamer;
  richText?: AnkiRichTextConverter;
}

/** One field value as Anki HTML. */
export function ankiFieldHtml(
  value: string | undefined,
  field: NoteTypeField,
  ctx: AnkiFieldHtmlContext,
): string {
  if (!value) return '';
  const hash = parseMediaHashUri(value);
  if (hash) {
    const file = ctx.media.file(hash);
    if (!file) return '';
    const sound =
      file.mime.startsWith('audio/') || (field.kind === 'audio' && !file.mime.startsWith('image/'));
    return sound ? `[sound:${file.name}]` : `<img src="${escapeAttr(file.name)}">`;
  }
  const trimmed = value.trim();
  if (field.kind === 'image' && /^https:\/\/\S+$/i.test(trimmed)) {
    return `<img src="${escapeAttr(trimmed)}">`;
  }
  if (ctx.richText) return ctx.richText(value, rubyTextToAnkiHtml, field);
  return rubyTextToAnkiHtml(value);
}

/**
 * Anki tags: no spaces inside a tag (Anki separates tags with spaces), so whitespace becomes
 * `_`. `parent::child` is Anki's own hierarchy syntax and is kept.
 */
export function ankiTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of normalizeTagList(tags)) {
    const t = tag.replace(/\s+/g, '_');
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * The Anki note GUID for a note. Notes that came from Anki (`source_key` `anki:<guid>`) get their
 * original GUID back, so importing the export into the same Anki profile updates those notes
 * instead of duplicating them. Every other note uses its own stable id.
 */
export function ankiGuid(note: Note): string {
  if (note.source_key.startsWith('anki:') && note.source_key.length > 5) {
    return note.source_key.slice(5);
  }
  return note.id;
}

/** Characters Anki does not allow in a field name. */
const BAD_FIELD_NAME = /[:{}"]/g;

/**
 * Anki field names for a note type, in field order: the label (else the key), without the
 * characters Anki forbids, never starting with `#`, `/` or `^`, unique (case-insensitive).
 */
export function ankiFieldNames(noteType: NoteType): string[] {
  const used = new Set<string>();
  return noteType.fields.map((field, i) => {
    let base = (field.label.trim() || field.key.trim())
      .replace(BAD_FIELD_NAME, '')
      .replace(/^[#/^\s]+/, '')
      .trim();
    if (!base) base = `Field ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}
