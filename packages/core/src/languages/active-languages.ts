import { BUILTIN_NOTE_TYPE_IDS } from '../model/presets.ts';
import { parseRuby } from '../parsers/ruby.ts';
import { compareCodeUnits } from '../study/queue.ts';
import { normalizeLanguage } from './normalize.ts';

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

export { normalizeLanguage };

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
 * True when the user has made any Settings > Languages choice. With every box unticked and no
 * deck, the active list is empty but that is a choice (show no language-specific options), not
 * "nothing known yet".
 */
export function hasLanguageChoices(chosen: Readonly<Record<string, boolean>> | undefined): boolean {
  return Object.values(chosen ?? {}).some((on) => typeof on === 'boolean');
}

/**
 * True when `feature` should be offered. Only with no information at all (`known` false: no
 * language and no Settings choice, e.g. an empty collection that skipped onboarding) is every
 * feature shown. `known` defaults to "some language is active".
 */
export function isLanguageFeatureActive(
  active: readonly string[],
  feature: LanguageFeature,
  known: boolean = active.length > 0,
): boolean {
  if (!known) return true;
  return LANGUAGE_FEATURE_LANGUAGES[feature].some((lang) => active.includes(lang));
}

/** True when `language` is active (or nothing is known yet, so everything is offered). */
export function isLanguageActive(
  active: readonly string[],
  language: string,
  known: boolean = active.length > 0,
): boolean {
  return !known || active.includes(normalizeLanguage(language));
}

/** True when the text carries ruby markup (`漢字[かんじ]`, `{base|reading}`). */
export function hasRubyMarkup(text: string): boolean {
  if (!text.includes('[') && !text.includes('{')) return false;
  return parseRuby(text).some((segment) => segment.type === 'ruby');
}
