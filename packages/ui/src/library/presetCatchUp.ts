import {
  buildPresetCatchUp,
  type CollectionState,
  type EventFactory,
  type KnownEvent,
} from '@flash/core';

/**
 * The preset catch-up step (see `buildPresetCatchUp`): after a sync and when the Library opens,
 * copy each preset into any member deck that differs from it. Lazy-loaded; nothing here runs on
 * the study screen (§8).
 *
 * It writes only when a member really differs, and the copy makes it match, so a second run
 * writes nothing. As a guard against an unforeseen case where a copy does not take, the same
 * copy is never sent twice in a row from this page.
 */
let lastSent = '';

function presetCatchUpEvents(
  state: CollectionState,
  factory: EventFactory,
  nowMs: number,
): KnownEvent[] {
  const { settings, params } = buildPresetCatchUp(state, nowMs, factory.deviceId);
  if (settings.length === 0 && params.length === 0) {
    lastSent = '';
    return [];
  }
  const signature = JSON.stringify([
    settings,
    params.map((p) => [p.deck_id, p.params.request_retention, p.params.w]),
  ]);
  if (signature === lastSent) return [];
  lastSent = signature;
  return [
    ...settings.map((payload) => factory.create('DeckSettingsChanged', payload, nowMs)),
    ...params.map((payload) => factory.create('DeckFSRSParamsChanged', payload, nowMs)),
  ];
}

/** Runs the catch-up and emits its events, if any. */
export function runPresetCatchUp(
  state: CollectionState,
  factory: EventFactory,
  emitEvents: (events: KnownEvent[]) => void,
): void {
  const events = presetCatchUpEvents(state, factory, Date.now());
  if (events.length > 0) emitEvents(events);
}
