import {
  deriveActiveLanguages,
  isLanguageActive,
  isLanguageFeatureActive,
  type LanguageFeature,
} from '@flash/core';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from './AppContext.tsx';

export interface ActiveLanguages {
  /** Normalized, sorted codes; empty while nothing is known (then every option is offered). */
  languages: readonly string[];
  /** Whether a language-specific option group should be shown. */
  hasFeature: (feature: LanguageFeature) => boolean;
  /** Whether options for one language should be shown. */
  hasLanguage: (language: string) => boolean;
}

/**
 * The collection's decks plus this device's onboarding choice (UX #2). The onboarding record is
 * read lazily so it never joins the initial bundle; the decks alone already cover every collection
 * that has one. Nothing stored is changed: a hidden option keeps its saved value.
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
    const languages = deriveActiveLanguages(
      state.decks.values(),
      onboardingLanguage,
      state.noteTypes,
    );
    return {
      languages,
      hasFeature: (feature) => isLanguageFeatureActive(languages, feature),
      hasLanguage: (language) => isLanguageActive(languages, language),
    };
    // `state` is mutated in place; `stateVersion` marks each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stateVersion, onboardingLanguage]);
}
