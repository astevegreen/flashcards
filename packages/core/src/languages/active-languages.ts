import { compareCodeUnits } from '../study/queue.ts';

/**
 * "Active languages" (UX #2): the languages a collection is actually used for. Options that only
 * make sense for one language (furigana, Hanja, pinyin, ...) are shown only while that language is
 * active. Pure and deterministic; the UI feeds it the collection's decks and the language chosen
 * at onboarding. Nothing here deletes or rewrites any stored setting.
 */

/** A language-specific UI option group. */
export type LanguageFeature = 'ruby' | 'pinyin' | 'tones' | 'handwriting';

/**
 * Which active languages switch each feature on (normalized language codes). Ruby covers
 * furigana, Hangul over Hanja and pinyin (blueprint 6.2), so it is not Japanese-only.
 */
export const LANGUAGE_FEATURE_LANGUAGES: Readonly<Record<LanguageFeature, readonly string[]>> = {
  ruby: ['ja', 'ko', 'zh-Hans'],
  pinyin: ['zh-Hans'],
  tones: ['zh-Hans'],
  handwriting: ['ja', 'zh-Hans', 'ko'],
};

/** Maps a language tag to the code the app uses: `ja-JP` -> `ja`, `zh`/`zh-CN` -> `zh-Hans`. */
export function normalizeLanguage(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return primary === 'zh' ? 'zh-Hans' : primary;
}

interface DeckLike {
  readonly language: string;
  readonly note_type_id?: string;
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
 * The languages in use: every deck's language, the languages of its note type's fields (so a
 * Japanese deck imported with a missing or wrong language tag still counts), and the onboarding
 * choice. Normalized, de-duplicated and sorted. Archived decks still count (their cards are still
 * in the collection).
 */
export function deriveActiveLanguages(
  decks: Iterable<DeckLike>,
  onboardingLanguage?: string,
  noteTypes?: ReadonlyMap<string, NoteTypeLike>,
): string[] {
  const out = new Set<string>();
  const add = (tag: string | undefined) => {
    const code = normalizeLanguage(tag ?? '');
    if (code) out.add(code);
  };
  for (const deck of decks) {
    add(deck.language);
    const noteType = deck.note_type_id ? noteTypes?.get(deck.note_type_id) : undefined;
    if (noteType) for (const code of noteTypeLanguages(noteType)) out.add(code);
  }
  add(onboardingLanguage);
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
