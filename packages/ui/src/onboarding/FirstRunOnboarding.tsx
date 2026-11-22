import { SAMPLE_DECKS, type SampleDeckInfo } from '@flash/core/samples';
import { useState } from 'react';

/**
 * First-run onboarding (Phase 13, held to the Phase 14 bar): pick a language, then a starter
 * deck, and the first card is on screen (two taps, no sign-in, works offline). Skippable at any
 * step. Sync is offered after the first finished session, not here (see `SyncPrompt`).
 *
 * Part of the lazily loaded empty-collection chunk, never the initial study bundle (§8). The card
 * reserves the height of its taller step (step 1, four languages) so nothing below it moves when
 * the step changes or a load error appears; the footer is pinned to the bottom of that space.
 */

const LANGUAGE_LABELS: Readonly<Record<string, { name: string; native: string }>> = {
  ko: { name: 'Korean', native: '한국어' },
  ja: { name: 'Japanese', native: '日本語' },
  'zh-Hans': { name: 'Mandarin', native: '中文' },
  en: { name: 'English', native: 'English' },
};

function languageLabel(language: string): { name: string; native: string } {
  return LANGUAGE_LABELS[language] ?? { name: language, native: language };
}

/** Languages that have at least one starter deck, in sample-deck order. */
export function onboardingLanguages(decks: readonly SampleDeckInfo[] = SAMPLE_DECKS): string[] {
  return [...new Set(decks.map((d) => d.language))];
}

export function starterDecksFor(
  language: string,
  decks: readonly SampleDeckInfo[] = SAMPLE_DECKS,
): SampleDeckInfo[] {
  return decks.filter((d) => d.language === language);
}

const CHOICE_CLASS =
  'flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-left text-sm font-semibold hover:border-[var(--accent)] hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]';
const LINK_CLASS =
  'min-h-11 rounded-lg px-3 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]';

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

export function FirstRunOnboarding({
  onPickDeck,
  onSkip,
  busy = false,
  error,
}: Readonly<{
  onPickDeck: (deck: SampleDeckInfo) => void;
  onSkip: () => void;
  /** A starter deck is loading: deck choices are disabled. */
  busy?: boolean;
  /** Why the last pick failed; shown inside the reserved card height. */
  error?: string;
}>) {
  const [language, setLanguage] = useState<string | undefined>(undefined);
  const languages = onboardingLanguages();
  const decks = language === undefined ? [] : starterDecksFor(language);

  return (
    <section
      aria-labelledby="onboarding-title"
      data-testid="onboarding"
      className="flex min-h-[22rem] w-full max-w-md flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-left"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="onboarding-title" className="text-base font-bold">
          {language === undefined ? 'What are you learning?' : 'Pick a starter deck'}
        </h2>
        <span className="text-xs tabular-nums text-[var(--muted)]">
          Step {language === undefined ? 1 : 2} of 2
        </span>
      </div>
      {language === undefined ? (
        <ul className="flex flex-col gap-2" aria-label="Languages">
          {languages.map((lang) => {
            const label = languageLabel(lang);
            return (
              <li key={lang}>
                <button
                  type="button"
                  data-testid={`onboarding-language-${lang}`}
                  onClick={() => setLanguage(lang)}
                  className={CHOICE_CLASS}
                >
                  <span>{label.name}</span>
                  {label.native !== label.name && (
                    <span lang={lang} className="font-normal text-[var(--muted)]">
                      {label.native}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Starter decks">
          {decks.map((deck) => (
            <li key={deck.slug}>
              <button
                type="button"
                data-testid={`onboarding-deck-${deck.slug}`}
                disabled={busy}
                onClick={() => onPickDeck(deck)}
                className={CHOICE_CLASS}
              >
                <span>{deck.name}</span>
                <span className="font-normal text-[var(--muted)]">
                  {plural(deck.noteCount, 'note')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && language !== undefined && (
        <p
          role="alert"
          data-testid="onboarding-error"
          className="text-sm text-[var(--danger,#dc2626)]"
        >
          {error}
        </p>
      )}
      <div className="mt-auto flex items-center justify-between gap-2">
        {language === undefined ? (
          <span />
        ) : (
          <button type="button" onClick={() => setLanguage(undefined)} className={LINK_CLASS}>
            Back
          </button>
        )}
        <button type="button" data-testid="onboarding-skip" onClick={onSkip} className={LINK_CLASS}>
          Skip for now
        </button>
      </div>
    </section>
  );
}

export default FirstRunOnboarding;
