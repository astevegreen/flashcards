import { useState } from 'react';
import { useActiveLanguages } from '../state/useActiveLanguages.ts';

export type DrawScriptLang = 'ko' | 'ja' | 'zh-Hans';

const DRAW_SCRIPTS: ReadonlyArray<{ lang: DrawScriptLang; label: string }> = [
  { lang: 'ko', label: 'Hanja (Korean)' },
  { lang: 'ja', label: 'Kanji (Japanese)' },
  { lang: 'zh-Hans', label: 'Hanzi (Chinese)' },
];

/** The draw-lookup scripts offered for the languages in use (UX #2), and the one selected. */
export function useDrawScripts() {
  const active = useActiveLanguages();
  const [choice, setChoice] = useState<DrawScriptLang>('ko');
  const scripts = DRAW_SCRIPTS.filter((s) => active.hasLanguage(s.lang));
  const lang = scripts.some((s) => s.lang === choice) ? choice : (scripts[0]?.lang ?? choice);
  return {
    scripts,
    lang,
    setLang: setChoice,
    show: active.hasFeature('handwriting') && scripts.length > 0,
  };
}

/** The script a single-script draw panel (Browse) should use. */
export function primaryDrawLang(hasLanguage: (language: string) => boolean): DrawScriptLang {
  const found = DRAW_SCRIPTS.find((s) => hasLanguage(s.lang));
  return found?.lang ?? 'ko';
}
