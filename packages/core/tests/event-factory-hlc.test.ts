import { describe, expect, it } from 'vitest';
import { createEventFactory } from '../src/events/replay.ts';
import { compareHlc, createHlcState } from '../src/hlc.ts';

describe('EventFactory.setHlc (D20)', () => {
  const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);

  it('never moves the clock backwards', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const first = f.create('NoteArchived', { note_id: 'n1' }, t0 + 5_000);
    // A sync that read the clock before `first` was made hands back an older value.
    f.setHlc({ wallMs: t0, counter: 0, deviceId: 'dev-a' });
    expect(f.getHlc().wallMs).toBe(t0 + 5_000);
    const second = f.create('NoteArchived', { note_id: 'n2' }, t0 + 1_000);
    expect(compareHlc(second.hlc, first.hlc)).toBeGreaterThan(0);
  });

  it('still moves forwards, by counter as well as wall time', () => {
    const f = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    f.setHlc({ wallMs: t0, counter: 7, deviceId: 'dev-a' });
    expect(f.getHlc()).toEqual({ wallMs: t0, counter: 7, deviceId: 'dev-a' });
    f.setHlc({ wallMs: t0, counter: 3, deviceId: 'dev-a' });
    expect(f.getHlc().counter).toBe(7);
    f.setHlc({ wallMs: t0 + 1, counter: 0, deviceId: 'dev-a' });
    expect(f.getHlc()).toEqual({ wallMs: t0 + 1, counter: 0, deviceId: 'dev-a' });
  });
});
