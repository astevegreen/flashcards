/**
 * "Active languages" (UX #2): the languages a collection is actually used for. Options that only
 * make sense for one language (furigana, Hanja, pinyin, ...) are shown only while that language is
 * active. Pure and deterministic; the UI feeds it the collection's decks and the language chosen
 * at onboarding. Nothing here deletes or rewrites any stored setting.
 */

/** A language-specific UI option group. */
export type LanguageFeature =
  'furigana' | 'kanaImport' | 'hanja' | 'pinyin' | 'tones' | 'strokeOrder' | 'handwriting';

/** Which active languages switch each feature on (normalized language codes). */
export const LANGUAGE_FEATURE_LANGUAGES: Readonly<Record<LanguageFeature, readonly string[]>> = {
  furigana: ['ja'],
  kanaImport: ['ja'],
  hanja: ['ko'],
  pinyin: ['zh-Hans'],
  tones: ['zh-Hans'],
  strokeOrder: ['ja', 'zh-Hans', 'ko'],
  handwriting: ['ja', 'zh-Hans', 'ko'],
};

/** Maps a language tag to the code the app uses: `ja-JP` -> `ja`, `zh`/`zh-CN` -> `zh-Hans`. */
export function normalizeLanguage(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return primary === 'zh' ? 'zh-Hans' : primary;
}

/**
 * The languages in use: every deck's language plus the onboarding choice, normalized, de-duplicated
 * and sorted. Archived decks still count (their cards are still in the collection).
 */
export function deriveActiveLanguages(
  decks: Iterable<{ readonly language: string }>,
  onboardingLanguage?: string,
): string[] {
  const out = new Set<string>();
  const add = (tag: string | undefined) => {
    const code = normalizeLanguage(tag ?? '');
    if (code) out.add(code);
  };
  for (const deck of decks) add(deck.language);
  add(onboardingLanguage);
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
