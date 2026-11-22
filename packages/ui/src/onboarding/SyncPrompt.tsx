/**
 * The deferred sync step (Phase 14 "study first, set up later"): offered once per device, after a
 * finished session, to anyone with cards and no sync provider; never before the first card. Its
 * "Sync my devices" button opens the Sync my devices panel (a default provider plus the
 * alternatives). Lazily loaded; it sits below every study control, so nothing above it moves.
 */
export function SyncPrompt({
  onOpenSync,
  onDismiss,
}: Readonly<{
  onOpenSync: () => void;
  onDismiss: () => void;
}>) {
  return (
    <aside
      aria-label="Sync your devices"
      data-testid="onboarding-sync-prompt"
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left"
    >
      <p className="min-w-0 flex-1 basis-56 text-sm">
        <span className="font-semibold">Nice session.</span>{' '}
        <span className="text-[var(--muted)]">
          Want your cards and progress on your other devices too?
        </span>
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          data-testid="onboarding-sync-dismiss"
          onClick={onDismiss}
          className="min-h-11 rounded-xl px-3 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--fg)]"
        >
          Not now
        </button>
        <button
          type="button"
          data-testid="onboarding-sync-open"
          onClick={onOpenSync}
          className="min-h-11 rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Sync my devices
        </button>
      </div>
    </aside>
  );
}

export default SyncPrompt;
