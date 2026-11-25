import type { PlatformServices } from '@flash/platform';
import { unconfiguredSourceHints } from './sourceProviders.ts';

/**
 * Dev builds only: a disabled button per linked-source provider this build can't offer because an
 * env var is missing, with the variable to set. Production builds render nothing.
 */
export function UnconfiguredSourceHints({ platform }: Readonly<{ platform: PlatformServices }>) {
  const hints = unconfiguredSourceHints(platform);
  if (hints.length === 0) return null;
  return (
    <ul data-testid="unconfigured-source-hints" className="flex flex-col gap-1">
      {hints.map((hint) => (
        <li key={hint.id} className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled
            data-testid={`unconfigured-source-${hint.id}`}
            title={hint.message}
            className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-semibold opacity-50"
          >
            {hint.name}
          </button>
          <span className="text-[11px] text-[var(--muted)]">{hint.message}</span>
        </li>
      ))}
    </ul>
  );
}
