/**
 * Order of the "What are you learning?" choices (approved 2026-11-22). Nothing is preselected
 * from the device locale, because the locale says what people speak, not what they are learning.
 * Korean comes first; on a Korean-locale device English comes first, then Korean (a Korean
 * speaker is most likely learning English). Every other language keeps its existing order.
 */
export function isKoreanLocale(locale: string | undefined): boolean {
  if (!locale) return false;
  const primary = locale.trim().toLowerCase().split(/[-_]/, 1)[0];
  return primary === 'ko';
}

export function orderOnboardingLanguages(
  languages: readonly string[],
  deviceLocale: string | undefined,
): string[] {
  const unique = [...new Set(languages)];
  const lead = isKoreanLocale(deviceLocale) ? ['en', 'ko'] : ['ko'];
  const first = lead.filter((language) => unique.includes(language));
  return [...first, ...unique.filter((language) => !first.includes(language))];
}

/** The device's UI locale, if the runtime exposes one. */
export function deviceLocale(): string | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.language;
}
