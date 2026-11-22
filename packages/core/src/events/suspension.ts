import { compareHlc } from '../hlc.ts';
import type { UnknownEvent } from './types.ts';

/**
 * Card suspension (Phase 9) is stored as two grow-only HLC registers per card inside the
 * existing per-field HLC registry (`CollectionState.fieldHlcs`):
 *
 * - `card:<id>:suspend`   = max HLC of every `CardSuspended { card_id }`
 * - `card:<id>:unsuspend` = max HLC of every `CardUnsuspended { card_id }`
 *
 * A card is suspended when its suspend register is newer than its unsuspend register.
 * Max-merge is commutative, associative and idempotent, so any delivery order, duplicate or
 * chunking converges to the same answer, and the registers survive card rebuilds (note edits,
 * layout toggles) because they are keyed by the stable derived card id.
 *
 * Reusing `fieldHlcs` keeps the snapshot and sync formats unchanged: older builds already
 * serialize every `fieldHlcs` entry verbatim, and they keep the raw events in `unknownEvents`.
 */
export type SuspensionEventType = 'CardSuspended' | 'CardUnsuspended';

export function suspendRegisterKey(cardId: string): string {
  return `card:${cardId}:suspend`;
}

export function unsuspendRegisterKey(cardId: string): string {
  return `card:${cardId}:unsuspend`;
}

export function isSuspensionEventType(type: string): type is SuspensionEventType {
  return type === 'CardSuspended' || type === 'CardUnsuspended';
}

/** Reads `payload.card_id` defensively (events may come from any build or a hand-edited file). */
export function readSuspensionCardId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const cardId = (payload as { card_id?: unknown }).card_id;
  return typeof cardId === 'string' && cardId.length > 0 ? cardId : undefined;
}

/**
 * Max-merges one suspension event into the registers. Returns the touched register key when
 * the register advanced, otherwise `undefined`. Malformed payloads are ignored (no throw).
 */
export function applySuspensionRegister(
  fieldHlcs: Map<string, string>,
  type: SuspensionEventType,
  payload: unknown,
  hlc: string,
): string | undefined {
  const cardId = readSuspensionCardId(payload);
  if (cardId === undefined || typeof hlc !== 'string' || hlc.length === 0) return undefined;
  const key = type === 'CardSuspended' ? suspendRegisterKey(cardId) : unsuspendRegisterKey(cardId);
  const prev = fieldHlcs.get(key);
  if (prev !== undefined && compareHlc(hlc, prev) <= 0) return undefined;
  fieldHlcs.set(key, hlc);
  return key;
}

/** True when the card's newest `CardSuspended` is newer than its newest `CardUnsuspended`. */
export function isCardSuspendedIn(fieldHlcs: ReadonlyMap<string, string>, cardId: string): boolean {
  const suspendedAt = fieldHlcs.get(suspendRegisterKey(cardId));
  if (suspendedAt === undefined) return false;
  const unsuspendedAt = fieldHlcs.get(unsuspendRegisterKey(cardId));
  return unsuspendedAt === undefined || compareHlc(suspendedAt, unsuspendedAt) > 0;
}

/**
 * Upgrade path for snapshots written by builds that predate suspension: such builds kept
 * `CardSuspended` / `CardUnsuspended` in `unknownEvents` (their segments are below the snapshot
 * watermark, so they will never be replayed again). Folds them into the registers and returns
 * the events that remain unknown to this build.
 */
export function foldSuspensionEventsFromUnknown(
  fieldHlcs: Map<string, string>,
  unknownEvents: readonly UnknownEvent[],
): UnknownEvent[] {
  const remaining: UnknownEvent[] = [];
  for (const ev of unknownEvents) {
    if (isSuspensionEventType(ev.type)) {
      applySuspensionRegister(fieldHlcs, ev.type, ev.payload, ev.hlc);
    } else {
      remaining.push(ev);
    }
  }
  return remaining;
}
