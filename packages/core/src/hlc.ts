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

export interface ParsedHlc {
  wallMs: number;
  counter: number;
  deviceId: string;
}

const MAX_COUNTER = 0xffff;

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
  const counterHex = (state.counter & MAX_COUNTER).toString(16).padStart(4, '0');
  return `${wallHex}-${counterHex}-${state.deviceId}`;
}

export function parseHlc(hlc: string): ParsedHlc {
  const firstDash = hlc.indexOf('-');
  const secondDash = firstDash === -1 ? -1 : hlc.indexOf('-', firstDash + 1);
  if (firstDash !== 12 || secondDash !== 17 || secondDash + 1 >= hlc.length) {
    throw new Error(`Invalid HLC format: ${hlc}`);
  }
  const wallMs = parseInt(hlc.slice(0, 12), 16);
  const counter = parseInt(hlc.slice(13, 17), 16);
  const deviceId = hlc.slice(18);
  if (Number.isNaN(wallMs) || Number.isNaN(counter)) {
    throw new Error(`Invalid HLC numeric components: ${hlc}`);
  }
  return { wallMs, counter, deviceId };
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
    if (counter > MAX_COUNTER) {
      wallMs += 1;
      counter = 0;
    }
  }

  const next: HlcState = { wallMs, counter, deviceId: state.deviceId };
  return { next, hlc: formatHlc(next) };
}

/** Merge a remote HLC string into local HLC state. */
export function receiveHlc(
  state: HlcState,
  remoteHlc: string,
  nowMs: number = Date.now(),
): HlcState {
  const remote = parseHlc(remoteHlc);
  const physical = Math.max(0, Math.floor(nowMs));
  const maxWall = Math.max(state.wallMs, remote.wallMs, physical);

  let counter: number;
  if (maxWall === state.wallMs && maxWall === remote.wallMs) {
    counter = Math.max(state.counter, remote.counter) + 1;
  } else if (maxWall === state.wallMs) {
    counter = state.counter + 1;
  } else if (maxWall === remote.wallMs) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }

  let wallMs = maxWall;
  if (counter > MAX_COUNTER) {
    wallMs += 1;
    counter = 0;
  }

  return { wallMs, counter, deviceId: state.deviceId };
}

/**
 * Total deterministic ordering over two HLC strings.
 * Fixed-width hex prefixes ensure standard UTF-16 code unit comparison matches (wallMs, counter, deviceId).
 */
export function compareHlc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
