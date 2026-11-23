import type { FieldKind, Layout, NoteType, NoteTypeField, RubyDisplay } from '../../model/types.ts';
import { isHanCodePoint } from '../../parsers/ruby.ts';
import type { AnkiFuriganaOutput } from './furigana.ts';
import { ankiHtmlToText, type AnkiFieldText } from './html.ts';
import {
  FURIGANA_FILTERS,
  parseAnkiTemplate,
  type AnkiFieldRef,
  type AnkiTemplateSide,
} from './template.ts';
import type { AnkiModel, AnkiModelTemplate, AnkiNote } from './types.ts';

/**
 * Maps one Anki note type (model) onto this app's Note Type + Layouts (§2.1):
 * - every Anki field becomes a field (key from its name, label = the name);
 * - a field whose notes embed `<img>` / `[sound:]` gets companion `image` / `audio` fields, one
 *   per reference (`front_image`, `front_image_2`, …), since a field here holds one media file;
 * - furigana (`furigana:` / `kana:` / `kanji:`) is stored as full ruby; the Layout's
 *   `ruby_display` flag shows the readings alone when every furigana field on it goes through
 *   `{{kana:F}}`, the bases alone when all go through `{{kanji:F}}`, and both otherwise. Only on a
 *   layout mixing `kana:` and `kanji:` fields, a field shown just one way keeps that reduction
 *   (one flag cannot serve both);
 * - every card template becomes a Layout: fields on the question side are the front, the other
 *   fields on the answer side are revealed; `{{type:F}}` -> typed mode, cloze models -> cloze,
 *   `{{tts …:F}}` -> `speak_field`, `{{kanji:F}}` on the front -> furigana hidden on the front.
 */

/** Most companion media fields made for one Anki field (per kind); more references are dropped. */
export const MAX_MEDIA_PER_FIELD = 20;

export interface FieldPlan {
  ord: number;
  name: string;
  key: string;
  /** How Anki furigana in this field is stored; absent when no template filter asks for it. */
  furigana?: AnkiFuriganaOutput;
  /** Companion image fields, in reference order. */
  imageKeys: string[];
  /** Companion audio fields, in reference order. */
  audioKeys: string[];
  lang: string;
  kind: FieldKind;
  tts: boolean;
}

export interface ConvertedNote {
  note: AnkiNote;
  /** Converted text per field ord. */
  texts: AnkiFieldText[];
}

export interface ModelPlan {
  model: AnkiModel;
  noteTypeId: string;
  fields: FieldPlan[];
  noteType: NoteType;
  layouts: Array<{ layout: Layout; templateOrd: number }>;
  /** Layout that scheduled cards of template `ord` belong to (cloze: one for all). */
  layoutIdForOrd(ord: number): string | undefined;
  notes: ConvertedNote[];
  /** Media references dropped because a field had more than {@link MAX_MEDIA_PER_FIELD}. */
  extraMediaRefs: number;
  droppedActiveContent: number;
}

export function ankiNoteTypeId(modelId: string): string {
  return `anki:nt:${modelId}`;
}

export function ankiLayoutId(modelId: string, templateOrd: number): string {
  return `anki:layout:${modelId}:${templateOrd}`;
}

/** Lowercase ASCII slug of a field name; empty when the name has no ASCII letters/digits. */
function slug(name: string): string {
  let out = '';
  let gap = false;
  for (const ch of name.toLowerCase()) {
    const code = ch.charCodeAt(0);
    const keep = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (keep) {
      if (gap && out) out += '_';
      out += ch;
      gap = false;
    } else {
      gap = true;
    }
  }
  return out;
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  let n = 2;
  while (used.has(key)) {
    key = `${base}_${n}`;
    n += 1;
  }
  used.add(key);
  return key;
}

interface ScriptCounts {
  kana: number;
  hangul: number;
  han: number;
  latin: number;
}

function countScripts(text: string, into: ScriptCounts): void {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) into.kana += 1;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) into.hangul += 1;
    else if (isHanCodePoint(cp)) into.han += 1;
    else if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) into.latin += 1;
  }
}

/** Best-effort language of a field from the scripts its notes use (Anki stores no language). */
function detectLang(c: ScriptCounts, collectionUsesKana: boolean): string {
  if (c.kana > 0) return 'ja';
  if (c.hangul > 0) return 'ko';
  if (c.han > 0) return collectionUsesKana ? 'ja' : 'zh-Hans';
  return 'en';
}

/** `ja_JP` / `zh-CN` style Anki TTS code -> BCP 47 language used by this app. */
function ttsLang(code: string): string | undefined {
  const lower = code.toLowerCase().replaceAll('_', '-');
  if (!lower) return undefined;
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk')) return 'zh-Hant';
  if (lower.startsWith('zh')) return 'zh-Hans';
  return lower.split('-')[0];
}

interface TemplateSides {
  tmpl: AnkiModelTemplate;
  q: AnkiTemplateSide;
  a: AnkiTemplateSide;
}

/** How one template reference shows a field: its furigana filter, or `plain`. */
function useKind(filters: readonly string[]): string {
  return filters.find((f) => FURIGANA_FILTERS.has(f)) ?? 'plain';
}

/** Distinct ways the given uses show furigana fields (`kana`, `kanji`, `furigana`, `plain`, …). */
function useKinds(uses: readonly AnkiFieldRef[], include: (field: string) => boolean): Set<string> {
  const kinds = new Set<string>();
  for (const use of uses) {
    if (include(use.field)) kinds.add(useKind(use.filters));
  }
  return kinds;
}

/**
 * How each furigana field is stored. Full ruby by default (the layout's `ruby_display` flag then
 * picks readings or bases). One flag per layout cannot serve a layout that shows one field
 * through `kana:` and another through `kanji:`, so there a field that is only ever shown one way
 * (anywhere) keeps what Anki displays (`kana` = reading, `kanji` = base), as before the flag.
 */
function furiganaFields(sides: readonly TemplateSides[]): Map<string, AnkiFuriganaOutput> {
  const global = new Map<string, Set<string>>();
  for (const { q, a } of sides) {
    for (const use of [...q.uses, ...a.uses]) {
      const set = global.get(use.field) ?? new Set<string>();
      set.add(useKind(use.filters));
      global.set(use.field, set);
    }
  }
  const hasFurigana = (field: string): boolean => {
    const kinds = global.get(field);
    return kinds !== undefined && [...kinds].some((k) => k !== 'plain');
  };
  const out = new Map<string, AnkiFuriganaOutput>();
  for (const field of global.keys()) if (hasFurigana(field)) out.set(field, 'ruby');
  for (const { q, a } of sides) {
    const uses = [...q.uses, ...a.uses];
    if (useKinds(uses, hasFurigana).size < 2) continue;
    for (const use of uses) reduceIfSingleKind(out, use.field, global.get(use.field));
  }
  return out;
}

/** In a `kana:`/`kanji:`-mixing layout, a field shown only one way keeps that reduction. */
function reduceIfSingleKind(
  out: Map<string, AnkiFuriganaOutput>,
  field: string,
  kinds: ReadonlySet<string> | undefined,
): void {
  if (!out.has(field) || kinds?.size !== 1) return;
  if (kinds.has('kana')) out.set(field, 'kana');
  else if (kinds.has('kanji')) out.set(field, 'kanji');
}

/**
 * What one template shows of the fields stored as ruby: only readings when every use goes
 * through `kana:`, only bases when all go through `kanji:`; any mix (or a plain use) shows both.
 */
function rubyDisplayOf(
  sides: TemplateSides,
  furigana: ReadonlyMap<string, AnkiFuriganaOutput>,
): RubyDisplay {
  const kinds = useKinds(
    [...sides.q.uses, ...sides.a.uses],
    (field) => furigana.get(field) === 'ruby',
  );
  if (kinds.size === 1 && kinds.has('kana')) return 'readings';
  if (kinds.size === 1 && kinds.has('kanji')) return 'bases';
  return 'both';
}

function ttsFields(sides: readonly TemplateSides[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { q, a } of sides) {
    for (const t of [...q.tts, ...a.tts]) {
      const lang = ttsLang(t.lang);
      if (lang && !out.has(t.field)) out.set(t.field, lang);
    }
  }
  return out;
}

interface FieldStats {
  scripts: ScriptCounts;
  multiline: boolean;
  /** Most distinct images / sounds one note references in this field (capped). */
  images: number;
  sounds: number;
}

/** Distinct names in reference order (the same picture twice is one media field). */
function distinct(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * Keeps the distinct references to files the package really has (at most
 * {@link MAX_MEDIA_PER_FIELD} of each kind); returns how many usable ones were cut.
 */
function capMedia(text: AnkiFieldText, isUsable: (name: string) => boolean): number {
  const images = distinct(text.images).filter(isUsable);
  const sounds = distinct(text.sounds).filter(isUsable);
  const cut =
    Math.max(0, images.length - MAX_MEDIA_PER_FIELD) +
    Math.max(0, sounds.length - MAX_MEDIA_PER_FIELD);
  text.images = images.slice(0, MAX_MEDIA_PER_FIELD);
  text.sounds = sounds.slice(0, MAX_MEDIA_PER_FIELD);
  return cut;
}

function recordStats(s: FieldStats | undefined, text: AnkiFieldText): void {
  if (!s) return;
  countScripts(text.text, s.scripts);
  s.multiline ||= text.text.includes('\n');
  s.images = Math.max(s.images, text.images.length);
  s.sounds = Math.max(s.sounds, text.sounds.length);
}

function convertNotes(
  model: AnkiModel,
  notes: readonly AnkiNote[],
  furigana: ReadonlyMap<string, AnkiFuriganaOutput>,
  isUsable: (name: string) => boolean,
): { converted: ConvertedNote[]; stats: FieldStats[]; extra: number; dropped: number } {
  const stats: FieldStats[] = model.fields.map(() => ({
    scripts: { kana: 0, hangul: 0, han: 0, latin: 0 },
    multiline: false,
    images: 0,
    sounds: 0,
  }));
  let extra = 0;
  let dropped = 0;
  const converted = notes.map((note) => {
    const texts = model.fields.map((field, i) => {
      const output = furigana.get(field.name);
      const text = ankiHtmlToText(note.fields[i] ?? '', {
        furigana: output !== undefined,
        ...(output ? { furiganaOutput: output } : {}),
      });
      extra += capMedia(text, isUsable);
      recordStats(stats[i], text);
      if (text.droppedActiveContent) dropped += 1;
      return text;
    });
    return { note, texts };
  });
  return { converted, stats, extra, dropped };
}

/** `base`, `base_2`, `base_3`, … (the first keeps the pre-Phase-14 key for re-imports). */
function mediaKeys(base: string, count: number, used: Set<string>): string[] {
  return Array.from({ length: count }, (_, i) =>
    uniqueKey(i === 0 ? base : `${base}_${i + 1}`, used),
  );
}

function planFields(
  model: AnkiModel,
  stats: readonly FieldStats[],
  sides: readonly TemplateSides[],
  collectionUsesKana: boolean,
): FieldPlan[] {
  const furigana = furiganaFields(sides);
  const tts = ttsFields(sides);
  const used = new Set<string>();
  const plans = model.fields.map((field, i) => ({
    field,
    key: uniqueKey(slug(field.name) || `field_${i + 1}`, used),
    stat: stats[i],
  }));
  return plans.map(({ field, key, stat }) => {
    const output = furigana.get(field.name);
    return {
      ord: field.ord,
      name: field.name,
      key,
      ...(output ? { furigana: output } : {}),
      imageKeys: mediaKeys(`${key}_image`, stat?.images ?? 0, used),
      audioKeys: mediaKeys(`${key}_audio`, stat?.sounds ?? 0, used),
      lang: tts.get(field.name) ?? (stat ? detectLang(stat.scripts, collectionUsesKana) : 'en'),
      kind: stat?.multiline ? 'rich' : 'text',
      tts: tts.has(field.name),
    };
  });
}

/** `Front (image)`, `Front (image 2)`, … */
function mediaLabel(name: string, what: 'image' | 'audio', index: number): string {
  return index === 0 ? `${name} (${what})` : `${name} (${what} ${index + 1})`;
}

function noteTypeFields(fields: readonly FieldPlan[]): NoteTypeField[] {
  const out: NoteTypeField[] = [];
  fields.forEach((f, i) => {
    out.push({
      key: f.key,
      label: f.name || f.key,
      kind: f.kind,
      lang: f.lang,
      ...(f.tts ? { tts: true } : {}),
      ...(i === 0 ? { sortKey: true } : {}),
    });
    f.imageKeys.forEach((key, n) => {
      out.push({ key, label: mediaLabel(f.name, 'image', n), kind: 'image', lang: f.lang });
    });
    f.audioKeys.forEach((key, n) => {
      out.push({ key, label: mediaLabel(f.name, 'audio', n), kind: 'audio', lang: f.lang });
    });
  });
  return out;
}

/** Keys a side shows for the given Anki field names (text, then its media fields). */
function keysFor(names: readonly string[], byName: ReadonlyMap<string, FieldPlan>): string[] {
  const out: string[] = [];
  for (const name of names) {
    const plan = byName.get(name);
    if (!plan) continue;
    for (const key of [plan.key, ...plan.imageKeys, ...plan.audioKeys]) {
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

function speakOf(
  sides: TemplateSides,
  byName: ReadonlyMap<string, FieldPlan>,
): Pick<Layout, 'speak_field' | 'speak_on'> {
  const front = sides.q.tts[0];
  const back = sides.a.tts[0];
  const ref = front ?? back;
  const key = ref ? byName.get(ref.field)?.key : undefined;
  if (!key) return {};
  return { speak_field: key, speak_on: front ? 'front' : 'reveal' };
}

function buildLayout(
  model: AnkiModel,
  sides: TemplateSides,
  byName: ReadonlyMap<string, FieldPlan>,
  firstKey: string,
  enabled: boolean,
  furigana: ReadonlyMap<string, AnkiFuriganaOutput>,
): Layout {
  const { tmpl, q, a } = sides;
  const typedName = q.typed[0];
  const typedKey = typedName ? byName.get(typedName)?.key : undefined;
  let front = keysFor(
    q.refs.map((r) => r.field),
    byName,
  );
  if (front.length === 0) front = [firstKey];
  const backNames = [...a.refs.map((r) => r.field), ...(typedName ? [typedName] : [])];
  let back = keysFor(backNames, byName).filter((k) => !front.includes(k));
  if (back.length === 0) {
    const spare = [...byName.values()].map((p) => p.key).find((k) => !front.includes(k));
    back = [spare ?? front[0] ?? firstKey];
  }
  const cloze = model.kind === 'cloze';
  const layout: Layout = {
    id: ankiLayoutId(model.id, cloze ? 0 : tmpl.ord),
    note_type_id: ankiNoteTypeId(model.id),
    name: tmpl.name || `Card ${tmpl.ord + 1}`,
    front_fields: front,
    reveal_steps: [back],
    answer_mode: 'flip',
    hide_furigana_on_front: q.refs.some((r) => r.filters.includes('kanji')),
    enabled,
    ...speakOf(sides, byName),
  };
  const rubyDisplay = rubyDisplayOf(sides, furigana);
  if (rubyDisplay !== 'both') layout.ruby_display = rubyDisplay;
  if (cloze) {
    layout.answer_mode = 'cloze';
    if (q.typedCloze.length > 0) layout.cloze_typed = true;
  } else if (typedKey) {
    layout.answer_mode = 'typed';
    layout.answer_field = typedKey;
  }
  return layout;
}

export interface ModelPlanContext {
  /** Template ords that have at least one card in Anki (other layouts start disabled). */
  templateOrdsWithCards: ReadonlySet<number>;
  /** Any note in the collection uses kana (Han-only fields are then Japanese). */
  collectionUsesKana: boolean;
  /** The package has this media file with a supported type (companion fields are sized by it). */
  isUsableMedia: (name: string) => boolean;
}

/** Builds the full plan for one model and converts its notes' fields. */
export function planAnkiModel(
  model: AnkiModel,
  notes: readonly AnkiNote[],
  ctx: ModelPlanContext,
): ModelPlan {
  const { templateOrdsWithCards, collectionUsesKana } = ctx;
  const templates = model.kind === 'cloze' ? model.templates.slice(0, 1) : model.templates;
  const sides: TemplateSides[] = templates.map((tmpl) => ({
    tmpl,
    q: parseAnkiTemplate(tmpl.qfmt),
    a: parseAnkiTemplate(tmpl.afmt),
  }));
  const furigana = furiganaFields(sides);
  const converted = convertNotes(model, notes, furigana, ctx.isUsableMedia);
  const fields = planFields(model, converted.stats, sides, collectionUsesKana);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const firstKey = fields[0]?.key ?? 'field_1';
  const layouts = sides.map((s) => ({
    layout: buildLayout(
      model,
      s,
      byName,
      firstKey,
      model.kind === 'cloze' || templateOrdsWithCards.has(s.tmpl.ord),
      furigana,
    ),
    templateOrd: s.tmpl.ord,
  }));
  const noteTypeId = ankiNoteTypeId(model.id);
  return {
    model,
    noteTypeId,
    fields,
    noteType: { id: noteTypeId, name: model.name, fields: noteTypeFields(fields) },
    layouts,
    layoutIdForOrd: (ord) => {
      if (model.kind === 'cloze') return layouts[0]?.layout.id;
      return layouts.find((l) => l.templateOrd === ord)?.layout.id;
    },
    notes: converted.converted,
    extraMediaRefs: converted.extra,
    droppedActiveContent: converted.dropped,
  };
}

/** True when any field of any note uses kana (decides Han-only fields: ja vs zh). */
export function collectionUsesKana(notes: readonly AnkiNote[]): boolean {
  for (const note of notes) {
    for (const field of note.fields) {
      for (const ch of field) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp >= 0x3040 && cp <= 0x30ff) return true;
      }
    }
  }
  return false;
}
