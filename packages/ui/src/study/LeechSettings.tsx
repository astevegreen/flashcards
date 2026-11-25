import { LEECH_LAPSE_THRESHOLD } from '@flash/core';
import { useApp } from '../state/AppContext.tsx';

/**
 * Phase 9 leech auto-suspend toggle (synced preference, default off). Cards with
 * {@link LEECH_LAPSE_THRESHOLD}+ lapses always match the virtual `leech` category; with this on,
 * the review that makes a card a leech also suspends it (one `CardSuspended` event).
 */
export function LeechAutoSuspendSetting() {
  const { state, updatePreferences } = useApp();
  return (
    <label className="flex items-center justify-between gap-4 text-sm">
      <div>
        <div className="font-medium">Auto-suspend leeches</div>
        <div className="text-xs text-[var(--muted)]">
          Suspend a card when it reaches {LEECH_LAPSE_THRESHOLD} lapses. Leeches are always tagged
          “leech”; unsuspend them in Words.
        </div>
      </div>
      <input
        type="checkbox"
        aria-label="Auto-suspend leeches"
        data-testid="leech-auto-suspend-toggle"
        checked={state.preferences.leech_auto_suspend ?? false}
        onChange={(e) => updatePreferences({ leech_auto_suspend: e.target.checked })}
        className="h-4 w-4"
      />
    </label>
  );
}
