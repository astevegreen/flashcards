/**
 * Hybrid Logical Clock (HLC) for causal, lexicographically sortable timestamps.
 * Format: "<12-hex wallMs>-<4-hex counter>-<deviceId>"
 * Example: "01936a4e2f10-0001-device-a"
 */

export interface HlcState {
  wallMs: number;
  counter: number;
  deviceId: string;
}

/**
 * Largest counter value before the HLC carries into wallMs.
 *
 * @internal `hlc-merge.ts` only; otherwise used only inside this module.
 */
export const HLC_MAX_COUNTER = 0xffff;

export function createHlcState(deviceId: string, initialWallMs = 0): HlcState {
  if (!deviceId) {
    throw new Error('HLC deviceId must be non-empty');
  }
  return {
    wallMs: Math.max(0, Math.floor(initialWallMs)),
    counter: 0,
    deviceId,
  };
}

export function formatHlc(state: HlcState): string {
  const wallHex = Math.max(0, Math.floor(state.wallMs)).toString(16).padStart(12, '0');
  const counterHex = (state.counter & HLC_MAX_COUNTER).toString(16).padStart(4, '0');
  return `${wallHex}-${counterHex}-${state.deviceId}`;
}

/** Advance local HLC for an outgoing event. */
export function tickHlc(
  state: HlcState,
  nowMs: number = Date.now(),
): { next: HlcState; hlc: string } {
  const physical = Math.max(0, Math.floor(nowMs));
  let wallMs = state.wallMs;
  let counter = state.counter;

  if (physical > wallMs) {
    wallMs = physical;
    counter = 0;
  } else {
    counter += 1;
    if (counter > HLC_MAX_COUNTER) {
      wallMs += 1;
      counter = 0;
    }
  }

  const next: HlcState = { wallMs, counter, deviceId: state.deviceId };
  return { next, hlc: formatHlc(next) };
}

/**
 * Total deterministic ordering over two HLC strings.
 * Fixed-width hex prefixes ensure standard UTF-16 code unit comparison matches (wallMs, counter, deviceId).
 */
export function compareHlc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
