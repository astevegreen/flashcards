import { describe, expect, it } from 'vitest';
import {
  LOCAL_SNAPSHOT_EVERY_EVENTS,
  localSnapshotDue,
} from '../src/state/localSnapshotCounter.ts';

/**
 * R10: AppProvider (local edits) and syncRunner (pulled events) read and set one counter. Each
 * writer below does what its call site does: check `localSnapshotDue`, and on a snapshot set the
 * counter to the total it saved.
 */
function writers() {
  const counter = { current: 0 };
  let total = 0;
  const saved: Array<{ by: 'edit' | 'sync'; at: number }> = [];
  const step = (by: 'edit' | 'sync', events: number) => {
    total += events;
    if (localSnapshotDue(counter, total)) {
      saved.push({ by, at: total });
      counter.current = total;
    }
  };
  return {
    counter,
    saved,
    edit: (n: number) => step('edit', n),
    sync: (n: number) => step('sync', n),
  };
}

describe('one local snapshot counter for edits and syncs (R10)', () => {
  it('saves after a local edit and after a sync, never twice for the same events', () => {
    const w = writers();
    w.edit(LOCAL_SNAPSHOT_EVERY_EVENTS); // a big import: the edit saves one
    w.sync(50); // a sync right after has nothing new enough: no second snapshot
    w.edit(1);
    expect(w.saved).toEqual([{ by: 'edit', at: 200 }]);
    w.sync(LOCAL_SNAPSHOT_EVERY_EVENTS - 51); // 200 since the edit's snapshot, counted together
    expect(w.saved).toEqual([
      { by: 'edit', at: 200 },
      { by: 'sync', at: 400 },
    ]);
    w.edit(199); // the sync's snapshot counts for the edits too
    expect(w.saved).toHaveLength(2);
    w.edit(1);
    expect(w.saved.at(-1)).toEqual({ by: 'edit', at: 600 });
  });

  it('starts over after a reset or a hydrate sets the counter', () => {
    const w = writers();
    w.edit(150);
    w.counter.current = 150; // a hydrate set it to the hydrated state's total
    w.sync(199);
    expect(w.saved).toEqual([]);
    w.edit(1);
    expect(w.saved).toEqual([{ by: 'edit', at: 350 }]);
  });
});
