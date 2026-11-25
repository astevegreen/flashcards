import { describe, expect, it } from 'vitest';
import { createEventFactory } from '../src/events/replay.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { compareHlc, createHlcState } from '../src/hlc.ts';
import { advanceClockPastOwnEvents } from '../src/sync/device-clock.ts';

const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);

describe('advanceClockPastOwnEvents (D11)', () => {
  it('moves a stale device clock past events stored before a kill', () => {
    const stale = { seq: 1, hlc: createHlcState('dev-a', t0) };
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const stored: FlashEvent[] = [1, 2, 3].map(() =>
      f.create('PreferencesChanged', { preferences: {} }, t0 + 1000),
    );
    const clock = advanceClockPastOwnEvents(stale, stored.slice(1));
    expect(clock.seq).toBe(3);

    // The next session numbers and stamps its first event after everything stored.
    const next = createEventFactory('dev-a', clock.seq, clock.hlc).create(
      'PreferencesChanged',
      { preferences: {} },
      t0, // the wall clock went backwards since
    );
    expect(next.seq).toBe(4);
    for (const ev of stored) expect(compareHlc(ev.hlc, next.hlc)).toBeLessThan(0);
  });

  it('never moves the clock backwards and skips unreadable HLCs', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const old = f.create('PreferencesChanged', { preferences: {} }, t0);
    const clock = { seq: 10, hlc: { wallMs: t0 + 5000, counter: 2, deviceId: 'dev-a' } };
    const broken = { ...old, seq: 12, hlc: 'not-an-hlc' } as FlashEvent;
    expect(advanceClockPastOwnEvents(clock, [old, broken])).toEqual({ ...clock, seq: 12 });
  });
});
