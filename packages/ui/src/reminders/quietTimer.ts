/**
 * Runs `run` once things have been quiet for `quietMs`: each `trigger` restarts the wait, so a
 * burst of triggers (a study session's ratings) runs it once, after the last (P9).
 */
export interface QuietTimer {
  trigger(): void;
  cancel(): void;
}

export function createQuietTimer(run: () => void, quietMs: number): QuietTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    trigger() {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, quietMs);
    },
    cancel,
  };
}
