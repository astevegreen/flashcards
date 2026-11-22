import type { FieldKind, Layout, NoteType, NoteTypeField } from '../../model/types.ts';
import { isHanCodePoint } from '../../parsers/ruby.ts';
import { ankiHtmlToText, type AnkiFieldText } from './html.ts';
import { FURIGANA_FILTERS, parseAnkiTemplate, type AnkiTemplateSide } from './template.ts';
import type { AnkiModel, AnkiModelTemplate, AnkiNote } from './types.ts';

/**
 * Maps one Anki note type (model) onto this app's Note Type + Layouts (§2.1):
 * - every Anki field becomes a field (key from its name, label = the name);
 * - a field whose notes embed `<img>` / `[sound:]` gets a companion `image` / `audio` field
 *   holding the first `media:<sha256>` reference (this app keeps one media file per field);
 * - every card template becomes a Layout: fields on the question side are the front, the other
 *   fields on the answer side are revealed; `{{type:F}}` -> typed mode, cloze models -> cloze,
 *   `{{tts …:F}}` -> `speak_field`, `{{kanji:F}}` on the front -> furigana hidden on the front.
 */

export interface FieldPlan {
  ord: number;
  name: string;
  key: string;
  /** Converts Anki furigana in this field (used with furigana / kana / kanji filters). */
  furigana: boolean;
  imageKey?: string;
  audioKey?: string;
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
  /** Fields with more than one image / sound in a note (only the first is kept). */
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

function furiganaFields(sides: readonly TemplateSides[]): Set<string> {
  const out = new Set<string>();
  for (const { q, a } of sides) {
    for (const ref of [...q.refs, ...a.refs]) {
      if (ref.filters.some((f) => FURIGANA_FILTERS.has(f))) out.add(ref.field);
    }
  }
  return out;
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
  images: boolean;
  sounds: boolean;
}

function convertNotes(
  model: AnkiModel,
  notes: readonly AnkiNote[],
  furigana: ReadonlySet<string>,
): { converted: ConvertedNote[]; stats: FieldStats[]; extra: number; dropped: number } {
  const stats: FieldStats[] = model.fields.map(() => ({
    scripts: { kana: 0, hangul: 0, han: 0, latin: 0 },
    multiline: false,
    images: false,
    sounds: false,
  }));
  let extra = 0;
  let dropped = 0;
  const converted = notes.map((note) => {
    const texts = model.fields.map((field, i) => {
      const text = ankiHtmlToText(note.fields[i] ?? '', { furigana: furigana.has(field.name) });
      const s = stats[i];
      if (s) {
        countScripts(text.text, s.scripts);
        s.multiline ||= text.text.includes('\n');
        s.images ||= text.images.length > 0;
        s.sounds ||= text.sounds.length > 0;
      }
      if (text.images.length > 1 || text.sounds.length > 1) extra += 1;
      if (text.droppedActiveContent) dropped += 1;
      return text;
    });
    return { note, texts };
  });
  return { converted, stats, extra, dropped };
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
    const plan: FieldPlan = {
      ord: field.ord,
      name: field.name,
      key,
      furigana: furigana.has(field.name),
      lang: tts.get(field.name) ?? (stat ? detectLang(stat.scripts, collectionUsesKana) : 'en'),
      kind: stat?.multiline ? 'rich' : 'text',
      tts: tts.has(field.name),
    };
    if (stat?.images) plan.imageKey = uniqueKey(`${key}_image`, used);
    if (stat?.sounds) plan.audioKey = uniqueKey(`${key}_audio`, used);
    return plan;
  });
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
    if (f.imageKey)
      out.push({ key: f.imageKey, label: `${f.name} (image)`, kind: 'image', lang: f.lang });
    if (f.audioKey)
      out.push({ key: f.audioKey, label: `${f.name} (audio)`, kind: 'audio', lang: f.lang });
  });
  return out;
}

/** Keys a side shows for the given Anki field names (text, then its media fields). */
function keysFor(names: readonly string[], byName: ReadonlyMap<string, FieldPlan>): string[] {
  const out: string[] = [];
  for (const name of names) {
    const plan = byName.get(name);
    if (!plan) continue;
    for (const key of [plan.key, plan.imageKey, plan.audioKey]) {
      if (key && !out.includes(key)) out.push(key);
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
  if (cloze) {
    layout.answer_mode = 'cloze';
    if (q.typedCloze.length > 0) layout.cloze_typed = true;
  } else if (typedKey) {
    layout.answer_mode = 'typed';
    layout.answer_field = typedKey;
  }
  return layout;
}

/** Builds the full plan for one model and converts its notes' fields. */
export function planAnkiModel(
  model: AnkiModel,
  notes: readonly AnkiNote[],
  templateOrdsWithCards: ReadonlySet<number>,
  collectionUsesKana: boolean,
): ModelPlan {
  const templates = model.kind === 'cloze' ? model.templates.slice(0, 1) : model.templates;
  const sides: TemplateSides[] = templates.map((tmpl) => ({
    tmpl,
    q: parseAnkiTemplate(tmpl.qfmt),
    a: parseAnkiTemplate(tmpl.afmt),
  }));
  const converted = convertNotes(model, notes, furiganaFields(sides));
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
