import {
  deriveActiveLanguages,
  hasLanguageChoices,
  isLanguageActive,
  isLanguageFeatureActive,
  type LanguageFeature,
} from '@flash/core';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from './AppContext.tsx';

export interface ActiveLanguages {
  /** Normalized, sorted codes of the active languages. */
  languages: readonly string[];
  /**
   * False only with no information at all (no language and no Settings choice): then every option
   * is offered. With every box unticked it is true, so no language-specific option shows.
   */
  known: boolean;
  /** Whether a language-specific option group should be shown. */
  hasFeature: (feature: LanguageFeature) => boolean;
  /** Whether options for one language should be shown. */
  hasLanguage: (language: string) => boolean;
}

/**
 * The collection's unarchived decks, the Settings > Languages tick boxes (synced preferences) and
 * this device's onboarding choice (UX #2). The onboarding record is read lazily so it never joins
 * the initial bundle; the decks alone already cover every collection that has one. Nothing stored
 * is changed: a hidden option keeps its saved value.
 */
export function useActiveLanguages(): ActiveLanguages {
  const { state, stateVersion, platform } = useApp();
  const [onboardingLanguage, setOnboardingLanguage] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void import('../onboarding/onboardingState.ts')
      .then((m) => m.loadOnboardingRecord(platform.storage))
      .then((record) => {
        if (!cancelled) setOnboardingLanguage(record?.language);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [platform]);

  return useMemo(() => {
    const chosen = state.preferences.languages;
    const languages = deriveActiveLanguages(state.decks.values(), {
      onboardingLanguage,
      noteTypes: state.noteTypes,
      chosen,
    });
    const known = languages.length > 0 || hasLanguageChoices(chosen);
    return {
      languages,
      known,
      hasFeature: (feature) => isLanguageFeatureActive(languages, feature, known),
      hasLanguage: (language) => isLanguageActive(languages, language, known),
    };
    // `state` is mutated in place; `stateVersion` marks each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, onboardingLanguage]);
}
