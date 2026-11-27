import { useState } from 'react';
import { takeOver } from './writer-handoff.ts';
import { holdWriterLock, type ReleaseLock, type WriterSetup } from './writer-lock.ts';

export { takeOver, yieldWriter } from './writer-handoff.ts';

/** Shown instead of the app while another tab of this browser profile is the writer (lazy). */
export function OtherTab({ onUse }: Readonly<{ onUse: () => void }>) {
  const [busy, setBusy] = useState(false);
  return (
    <main
      data-testid="other-tab"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[var(--bg)] px-4 text-center text-[var(--fg)]"
    >
      <p className="max-w-full break-words text-lg">Flashcards is open in another tab.</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onUse();
        }}
        className="rounded-md bg-[var(--accent)] px-4 py-2 font-semibold text-white disabled:opacity-60"
      >
        Use here instead
      </button>
    </main>
  );
}

/**
 * The waiting tab: shows the screen and resolves with the lock once it holds it. A normal request
 * stays queued, so the tab takes over by itself when the writer closes; "Use here instead" asks
 * the writer to hand over (`takeOver`). The screen is never rendered once the lock is held, so it
 * can't cover the app.
 */
export function waitForWriter(
  s: WriterSetup,
  self: string,
  onLost: () => void,
): Promise<ReleaseLock> {
  const won = new AbortController();
  const queued = new AbortController();
  return new Promise((resolve) => {
    const take = (release: ReleaseLock | null) => {
      if (!release || won.signal.aborted) return;
      won.abort();
      resolve(release);
    };
    void holdWriterLock(s.locks, s.name, { signal: queued.signal }, onLost).then(take);
    const onUse = () => {
      void takeOver(s.locks, s.name, { self, onLost, won, queued }).then(take, onLost);
    };
    if (!won.signal.aborted) s.render(<OtherTab onUse={onUse} />);
  });
}
