/**
 * When to save the local snapshot (R10). Local edits (AppProvider) and syncs (syncRunner) share one
 * counter, the event total at the last snapshot either of them saved, so neither saves a snapshot
 * the other just saved, and 200 events from both together still bring the next one.
 */
export const LOCAL_SNAPSHOT_EVERY_EVENTS = 200;

/** A sync that pulls this many events snapshots even when the counter isn't due (syncRunner). */
export const SYNC_PULL_SNAPSHOT_EVENTS = 100;

export function localSnapshotDue(counter: { current: number }, totalNow: number): boolean {
  return totalNow - counter.current >= LOCAL_SNAPSHOT_EVERY_EVENTS;
}

/**
 * Moves the counter to `totalNow` when a snapshot is decided, before its queued write runs, so an
 * edit queued meanwhile doesn't take a second snapshot of the same events. The returned function
 * gives the claim back when that write then fails: unless another snapshot has moved the counter
 * since, the next edit is due again instead of up to 200 events late.
 */
export function claimLocalSnapshot(counter: { current: number }, totalNow: number): () => void {
  const previous = counter.current;
  counter.current = totalNow;
  return () => {
    if (counter.current === totalNow) counter.current = previous;
  };
}
