import { useState } from 'react';

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
