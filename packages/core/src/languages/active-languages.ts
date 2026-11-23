import { BUILTIN_NOTE_TYPE_IDS } from '../model/presets.ts';
import { parseRuby } from '../parsers/ruby.ts';
import { compareCodeUnits } from '../study/queue.ts';

/**
 * "Active languages" (UX #2): the languages a collection is actually used for. Options that only
 * make sense for one language (furigana, Hanja, pinyin, ...) are shown only while that language is
 * active. Pure and deterministic; the UI feeds it the collection's decks, the language chosen at
 * onboarding and the Settings > Languages choices. Nothing here deletes or rewrites any stored
 * setting.
 */

/** A language-specific UI option group. */
export type LanguageFeature = 'ruby' | 'pinyin' | 'tones' | 'handwriting';

/**
 * Which active languages switch each feature on (normalized language codes). Ruby is furigana
 * (Japanese) and pinyin (Chinese). Korean is not listed: Hanja is shown as plain text, not as
 * Hangul-over-Hanja ruby (owner decision). Ruby already stored in a Korean note still renders.
 */
export const LANGUAGE_FEATURE_LANGUAGES: Readonly<Record<LanguageFeature, readonly string[]>> = {
  ruby: ['ja', 'zh-Hans'],
  pinyin: ['zh-Hans'],
  tones: ['zh-Hans'],
  handwriting: ['ja', 'zh-Hans', 'ko'],
};

/** Languages the app supports, in the order Settings > Languages lists them. */
export const SUPPORTED_LANGUAGES: readonly string[] = ['ko', 'ja', 'zh-Hans', 'en'];

/**
 * Built-in note types that are not tied to one language (their field tags are only defaults), so
 * a Korean cloze deck does not make Japanese active. The deck's own language still counts.
 */
const LANGUAGE_NEUTRAL_NOTE_TYPE_IDS: ReadonlySet<string> = new Set([
  BUILTIN_NOTE_TYPE_IDS.CLOZE,
  BUILTIN_NOTE_TYPE_IDS.SENTENCE,
  BUILTIN_NOTE_TYPE_IDS.GRAMMAR,
]);

/** Maps a language tag to the code the app uses: `ja-JP` -> `ja`, `zh`/`zh-CN` -> `zh-Hans`. */
export function normalizeLanguage(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return primary === 'zh' ? 'zh-Hans' : primary;
}

interface DeckLike {
  readonly language: string;
  readonly note_type_id?: string;
  readonly archived?: boolean;
}

interface NoteTypeLike {
  readonly fields: ReadonlyArray<{ readonly lang: string; readonly tts?: boolean }>;
}

/**
 * Languages a note type's fields are written in. Romanisation tags (`zh-Latn-pinyin`) are dropped,
 * and English only counts for a field that is spoken (`tts`), since every vocab type carries an
 * English meaning field.
 */
export function noteTypeLanguages(noteType: NoteTypeLike): string[] {
  const out: string[] = [];
  for (const field of noteType.fields) {
    if (/-latn/i.test(field.lang)) continue;
    const code = normalizeLanguage(field.lang);
    if (code && (code !== 'en' || field.tts)) out.push(code);
  }
  return out;
}

/**
 * Languages that decks keep active: every unarchived deck's language, plus the languages of its
 * note type's fields (so a Japanese deck imported with a missing or wrong language tag still
 * counts; skipped for the language-neutral built-in Cloze, Sentence and Grammar types). Archived
 * decks do not count: archiving the only Japanese deck hides furigana, un-archiving brings it
 * back. Normalized, de-duplicated and sorted.
 */
export function deriveDeckLanguages(
  decks: Iterable<DeckLike>,
  noteTypes?: ReadonlyMap<string, NoteTypeLike>,
): string[] {
  const out = new Set<string>();
  for (const deck of decks) {
    if (deck.archived) continue;
    const code = normalizeLanguage(deck.language);
    if (code) out.add(code);
    const typeId = deck.note_type_id;
    if (!typeId || LANGUAGE_NEUTRAL_NOTE_TYPE_IDS.has(typeId)) continue;
    const noteType = noteTypes?.get(typeId);
    if (noteType) for (const lang of noteTypeLanguages(noteType)) out.add(lang);
  }
  return [...out].sort(compareCodeUnits);
}

export interface ActiveLanguageSources {
  /** The language picked at first-run onboarding (per device). */
  readonly onboardingLanguage?: string | undefined;
  readonly noteTypes?: ReadonlyMap<string, NoteTypeLike> | undefined;
  /**
   * Settings > Languages tick boxes (`CollectionPreferences.languages`): `true` makes a language
   * active with no deck in it; `false` drops the onboarding choice. Decks always count.
   */
  readonly chosen?: Readonly<Record<string, boolean>> | undefined;
}

/**
 * The languages in use: the decks' languages (see `deriveDeckLanguages`), the onboarding choice
 * unless it was unticked in Settings, and every language ticked in Settings. Normalized,
 * de-duplicated and sorted.
 */
export function deriveActiveLanguages(
  decks: Iterable<DeckLike>,
  sources: ActiveLanguageSources = {},
): string[] {
  const out = new Set(deriveDeckLanguages(decks, sources.noteTypes));
  const chosen = new Map<string, boolean>();
  for (const [tag, on] of Object.entries(sources.chosen ?? {})) {
    const code = normalizeLanguage(tag);
    if (code && typeof on === 'boolean') chosen.set(code, on);
  }
  const onboarding = normalizeLanguage(sources.onboardingLanguage ?? '');
  if (onboarding && chosen.get(onboarding) !== false) out.add(onboarding);
  for (const [code, on] of chosen) if (on) out.add(code);
  return [...out].sort(compareCodeUnits);
}

/**
 * True when `feature` should be offered. With no known language at all (an empty collection that
 * skipped onboarding) nothing can be inferred, so every feature stays visible.
 */
export function isLanguageFeatureActive(
  active: readonly string[],
  feature: LanguageFeature,
): boolean {
  if (active.length === 0) return true;
  return LANGUAGE_FEATURE_LANGUAGES[feature].some((lang) => active.includes(lang));
}

/** True when `language` is active (or nothing is known yet, so everything is offered). */
export function isLanguageActive(active: readonly string[], language: string): boolean {
  return active.length === 0 || active.includes(normalizeLanguage(language));
}

interface PackLike {
  readonly kind: string;
  readonly language: string;
  readonly script?: string | undefined;
}

/**
 * Languages an offline pack serves. A dictionary serves its own language. The Chinese stroke pack
 * (Make Me a Hanzi) also serves Korean, since Hanja drawing uses it.
 */
export function packLanguages(pack: PackLike): string[] {
  const code = normalizeLanguage(pack.script ?? pack.language);
  if (pack.kind === 'strokes' && code === 'zh-Hans') return ['zh-Hans', 'ko'];
  return code ? [code] : [];
}

/** True when an offline pack serves an active language (or nothing is known yet). */
export function isPackForActiveLanguages(active: readonly string[], pack: PackLike): boolean {
  if (active.length === 0) return true;
  const langs = packLanguages(pack);
  return langs.length === 0 || langs.some((lang) => active.includes(lang));
}

/** True when the text carries ruby markup (`漢字[かんじ]`, `{base|reading}`). */
export function hasRubyMarkup(text: string): boolean {
  if (!text.includes('[') && !text.includes('{')) return false;
  return parseRuby(text).some((segment) => segment.type === 'ruby');
}
