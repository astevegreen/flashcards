import { FREE_TIER_MAX_DECKS } from '@flash/core/license';
import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../state/AppContext.tsx';

/**
 * Lazy-loaded License, Unlock & Sunset Promise card for Settings (§12.1, §12.2, §15 Phase 8).
 * - Personal/family builds default to `personalBuild: true` (all features unlocked, zero gate).
 * - Store / direct-sale builds verify StoreKit 2 / Play Billing IAP or offline Ed25519 keys.
 */
export function UnlockAndSunsetCard() {
  const { platform, entitlement, refreshEntitlement } = useApp();
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshEntitlement();
  }, [refreshEntitlement]);

  const handleActivateKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!platform.getPurchase || !keyInput.trim()) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const purchase = await platform.getPurchase();
      const res = await purchase.activateLicenseKey(keyInput.trim());
      await refreshEntitlement();
      if (res.valid) {
        setFeedback(
          `License key activated offline (${res.payload?.keyId ?? 'verified'}). Thank you!`,
        );
        setKeyInput('');
      } else {
        setError(res.reason ?? 'Invalid license key.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!platform.getPurchase) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const purchase = await platform.getPurchase();
      await purchase.restorePurchases();
      const ent = await refreshEntitlement();
      setFeedback(
        ent.unlocked
          ? 'Purchase entitlement restored.'
          : 'No prior store purchase found on this account.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClearKey = async () => {
    if (!platform.getPurchase) return;
    setBusy(true);
    setError(null);
    try {
      const purchase = await platform.getPurchase();
      await purchase.clearLicenseKey();
      await refreshEntitlement();
      setFeedback('Cleared stored license key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="unlock-sunset-card"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">License &amp; Sunset Promise</h2>
          <p className="text-xs text-[var(--muted)]">
            One-time unlock model: zero subscriptions, offline verification, and user-owned data.
          </p>
        </div>
        <span
          data-testid="license-status-badge"
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            !entitlement || entitlement.unlocked
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          }`}
        >
          {!entitlement
            ? 'Loading…'
            : entitlement.personalBuild
              ? 'Personal / Family Build (Unlocked)'
              : entitlement.unlocked
                ? `Unlocked (${entitlement.source === 'store_iap' ? 'Store IAP' : 'Ed25519 Key'})`
                : `Free Starter Tier (${FREE_TIER_MAX_DECKS} local decks)`}
        </span>
      </div>

      {entitlement && !entitlement.personalBuild && (
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
          {entitlement.unlocked ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>
                Active key/entitlement: <strong>{entitlement.keyId ?? 'Lifetime Unlock'}</strong>
                {entitlement.holder ? ` · ${entitlement.holder}` : ''}
              </span>
              {entitlement.source === 'license_key' && (
                <button
                  type="button"
                  data-testid="license-clear-btn"
                  disabled={busy}
                  onClick={() => void handleClearKey()}
                  className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]"
                >
                  Deactivate Key
                </button>
              )}
            </div>
          ) : (
            <>
              <form onSubmit={(e) => void handleActivateKey(e)} className="flex flex-wrap gap-2">
                <input
                  type="text"
                  data-testid="license-key-input"
                  aria-label="Ed25519 license key"
                  placeholder="FLASH1.<payload>.<signature>"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  className="min-w-[12rem] flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 font-mono text-xs text-[var(--fg)]"
                />
                <button
                  type="submit"
                  data-testid="license-activate-btn"
                  disabled={busy || !keyInput.trim()}
                  className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Activate Offline Key
                </button>
                <button
                  type="button"
                  data-testid="license-restore-btn"
                  disabled={busy}
                  onClick={() => void handleRestore()}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)]"
                >
                  Restore Purchase
                </button>
              </form>
            </>
          )}
        </div>
      )}

      {feedback && (
        <div
          role="status"
          data-testid="license-feedback"
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
        >
          {feedback}
        </div>
      )}
      {error && (
        <div
          role="alert"
          data-testid="license-error"
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
        >
          {error}
        </div>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
        <div className="font-semibold text-[var(--fg)]">Sunset Promise (§12.2)</div>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>
            Your collection, FSRS schedules, and media stay 100% local and keep working offline
            forever with zero developer servers.
          </li>
          <li>
            Sync uses your own Google Drive, Dropbox App Folder, iCloud Drive, or local desktop
            folders.
          </li>
          <li>
            All formats (<code>.flashpkg</code>, <code>sync/v1</code>, event log schema) are open
            and documented; if development ever ends, a final unlocked build and full source are
            published.
          </li>
        </ul>
      </div>
    </div>
  );
}
