import type { FlashEvent } from '../events/types.ts';
import type { HlcState } from '../hlc.ts';
import { parseHlc } from '../hlc-merge.ts';

/** The part of the stored device meta that numbers and timestamps this device's next event. */
export interface DeviceClock {
  seq: number;
  hlc: HlcState;
}

/**
 * Moves `clock` past this device's own events that are already stored (D11). Events and the
 * device meta are separate writes, so a tab or app killed between them leaves the stored meta
 * behind; the next session would then reuse those `seq` numbers and older HLCs, and other devices
 * skip an event whose `(device, seq)` they have already pulled.
 */
export function advanceClockPastOwnEvents(
  clock: DeviceClock,
  ownEvents: readonly FlashEvent[],
): DeviceClock {
  let { seq } = clock;
  let hlc = clock.hlc;
  for (const ev of ownEvents) {
    if (ev.seq > seq) seq = ev.seq;
    let parsed;
    try {
      parsed = parseHlc(ev.hlc);
    } catch {
      continue;
    }
    if (
      parsed.wallMs > hlc.wallMs ||
      (parsed.wallMs === hlc.wallMs && parsed.counter > hlc.counter)
    ) {
      hlc = { ...hlc, wallMs: parsed.wallMs, counter: parsed.counter };
    }
  }
  return { seq, hlc };
}
