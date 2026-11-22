const SECONDARY_BUTTON_CLASS =
  'rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-2.5 text-sm font-semibold hover:bg-[var(--surface-2)]';
const PRIMARY_BUTTON_CLASS =
  'rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90';

/** Empty collection onboarding (production zero-deck state). */
export function EmptyCollection({
  starterCatalogUrl,
  onOpenLibrary,
  onOpenSettings,
  onLoadSamples,
}: {
  starterCatalogUrl: string | undefined;
  onOpenLibrary: () => void;
  onOpenSettings: (() => void) | undefined;
  onLoadSamples: () => void;
}) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-5 py-12 text-center">
      <div className="max-w-md space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Ready to Study Offline</h1>
        <p className="text-sm text-[var(--muted)]">
          No decks are loaded on this device yet. Load the built-in Japanese, Mandarin, Korean +
          Hanja, and English sample decks, or import your own CSV / .flashpkg files.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        {starterCatalogUrl && (
          <button
            type="button"
            data-testid="empty-browse-starter-decks-btn"
            onClick={onOpenLibrary}
            className={PRIMARY_BUTTON_CLASS}
          >
            Browse Starter Decks
          </button>
        )}
        <button
          type="button"
          onClick={onLoadSamples}
          className={starterCatalogUrl ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS}
        >
          Load Sample Decks
        </button>
        <button type="button" onClick={onOpenLibrary} className={SECONDARY_BUTTON_CLASS}>
          Import CSV / .flashpkg
        </button>
        {onOpenSettings && (
          <button type="button" onClick={onOpenSettings} className={SECONDARY_BUTTON_CLASS}>
            Connect Cloud Sync
          </button>
        )}
      </div>
    </section>
  );
}
