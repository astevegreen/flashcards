import { HLC_MAX_COUNTER, type HlcState } from './hlc.ts';

// Parsing and merging remote HLCs is only needed by sync and imports, so it lives apart from
// `hlc.ts` (which the study screen needs to stamp events) and stays out of the initial chunk (§8).

export interface ParsedHlc {
  wallMs: number;
  counter: number;
  deviceId: string;
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
  if (counter > HLC_MAX_COUNTER) {
    wallMs += 1;
    counter = 0;
  }

  return { wallMs, counter, deviceId: state.deviceId };
}
