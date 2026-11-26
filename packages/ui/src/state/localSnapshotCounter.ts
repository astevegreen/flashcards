/**
 * When to save the local snapshot (R10). Local edits (AppProvider) and syncs (syncRunner) share one
 * counter, the event total at the last snapshot either of them saved, so neither saves a snapshot
 * the other just saved, and 200 events from both together still bring the next one.
 */
export const LOCAL_SNAPSHOT_EVERY_EVENTS = 200;

export function localSnapshotDue(counter: { current: number }, totalNow: number): boolean {
  return totalNow - counter.current >= LOCAL_SNAPSHOT_EVERY_EVENTS;
}
