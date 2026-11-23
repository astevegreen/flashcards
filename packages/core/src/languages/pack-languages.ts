import { normalizeLanguage } from './normalize.ts';

// Pack filtering by active language: only the pack manager and dictionary use it, so it lives
// apart from `active-languages.ts` and stays out of the initial study-screen chunk (§8).

export interface PackLike {
  readonly kind: string;
  readonly language: string;
  readonly script?: string | undefined;
}

/**
 * Languages an offline pack serves. A dictionary serves its own language. Both stroke packs
 * (Make Me a Hanzi and KanjiVG) also serve Korean: Hanja handwriting lookup reads both indexes.
 */
export function packLanguages(pack: PackLike): string[] {
  const code = normalizeLanguage(pack.script ?? pack.language);
  if (pack.kind === 'strokes' && (code === 'zh-Hans' || code === 'ja')) return [code, 'ko'];
  return code ? [code] : [];
}

/** True when an offline pack serves an active language (or nothing is known yet). */
export function isPackForActiveLanguages(
  active: readonly string[],
  pack: PackLike,
  known: boolean = active.length > 0,
): boolean {
  if (!known) return true;
  const langs = packLanguages(pack);
  return langs.length === 0 || langs.some((lang) => active.includes(lang));
}
