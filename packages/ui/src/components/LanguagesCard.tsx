import { deriveDeckLanguages, SUPPORTED_LANGUAGES } from '@flash/core';
import { useMemo } from 'react';
import { useApp } from '../state/AppContext.tsx';
import type { ActiveLanguages } from '../state/useActiveLanguages.ts';

const LANGUAGE_NAMES: Readonly<Record<string, { name: string; native: string }>> = {
  ko: { name: 'Korean', native: '한국어' },
  ja: { name: 'Japanese', native: '日本語' },
  'zh-Hans': { name: 'Mandarin', native: '中文' },
  en: { name: 'English', native: 'English' },
};

/**
 * Settings > Languages (UX #2): a tick box per supported language. A ticked language's options
 * show even with no deck in it. The choice is a synced preference (`preferences.languages`, one
 * appended `PreferencesChanged` event per change, last writer wins per language). A language with
 * unarchived decks always counts, so its box is ticked and locked.
 */
export function LanguagesCard({ active }: Readonly<{ active: ActiveLanguages }>) {
  const { state, stateVersion, updatePreferences } = useApp();
  const deckLanguages = useMemo(
    () => deriveDeckLanguages(state.decks.values(), state.noteTypes),
    // `state` is mutated in place; `stateVersion` marks each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, stateVersion],
  );

  return (
    <div
      data-testid="languages-card"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div>
        <h2 className="text-sm font-semibold">Languages</h2>
        <p className="text-xs text-[var(--muted)]">
          Ticked languages show their options. A language with decks stays ticked.
        </p>
      </div>
      <ul className="flex flex-col gap-2" aria-label="Languages">
        {SUPPORTED_LANGUAGES.map((code) => {
          const label = LANGUAGE_NAMES[code] ?? { name: code, native: code };
          const hasDecks = deckLanguages.includes(code);
          const checked = hasDecks || active.languages.includes(code);
          return (
            <li key={code}>
              <label className="flex min-h-9 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  data-testid={`language-toggle-${code}`}
                  aria-label={label.name}
                  checked={checked}
                  disabled={hasDecks}
                  onChange={(e) => updatePreferences({ languages: { [code]: e.target.checked } })}
                  className="h-4 w-4"
                />
                <span className="min-w-0 font-medium">{label.name}</span>
                {label.native !== label.name && (
                  <span lang={code} className="text-xs text-[var(--muted)]">
                    {label.native}
                  </span>
                )}
                {hasDecks && <span className="ml-auto text-xs text-[var(--muted)]">Has decks</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
