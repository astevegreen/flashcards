import { OPEN_DATA_ATTRIBUTIONS } from '@flash/core/dictionary';
import type { InstalledPackInfo } from '@flash/platform';

export interface AboutLicensesCardProps {
  installedPacks?: readonly InstalledPackInfo[];
}

/**
 * About & Open Data Licenses card (§6.3, §6.4, ADR 0001 Spike 0.6).
 * Uses non-exclusive adjacent `<details>` elements with plain text inside `<summary>`
 * (no headings inside `<summary>`, following modern-web-guidance `accordion` accessibility rules).
 */
export function AboutLicensesCard({ installedPacks = [] }: AboutLicensesCardProps) {
  const installedIds = new Set(installedPacks.map((p) => p.id));

  return (
    <section
      aria-labelledby="about-licenses-heading"
      data-testid="about-licenses-card"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div>
        <h2 id="about-licenses-heading" className="text-sm font-semibold">
          About &amp; Open Data Licenses
        </h2>
        <p className="text-xs text-[var(--muted)]">
          Offline dictionaries and stroke-order datasets are distributed as separate downloadable
          data packs. Share-alike and font licenses apply to their respective data packs, not to the
          Flashcards application code.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {OPEN_DATA_ATTRIBUTIONS.map((item) => {
          const isInstalled = item.packId ? installedIds.has(item.packId) : false;
          return (
            <details
              key={item.id}
              data-testid={`license-item-${item.id}`}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs"
            >
              <summary className="cursor-pointer select-none font-medium text-[var(--fg)]">
                <span>{item.name}</span>{' '}
                <span className="ml-1 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
                  {item.licenseName}
                </span>
                {isInstalled && (
                  <span className="ml-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                    Installed
                  </span>
                )}
              </summary>

              <div className="mt-2 flex flex-col gap-1.5 border-t border-[var(--border)] pt-2 text-[11px] text-[var(--muted)]">
                <div>
                  <strong className="text-[var(--fg)]">Scope:</strong> {item.scope}
                </div>
                <div>
                  <strong className="text-[var(--fg)]">Attribution:</strong> {item.attribution}
                </div>
                <p>{item.noticeText}</p>
                <div className="flex flex-wrap gap-3 pt-0.5">
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-[var(--accent)] hover:underline"
                  >
                    Upstream Source ↗
                  </a>
                  <a
                    href={item.licenseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-[var(--accent)] hover:underline"
                  >
                    License Text ↗
                  </a>
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
