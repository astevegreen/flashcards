import {
  applyEvents,
  createEmptyState,
  getTotalAppliedEventCount,
  type CollectionState,
} from '../events/replay.ts';
import { serializeCollectionState, type SerializedCollectionState } from '../events/snapshot.ts';
import type { FlashEvent } from '../events/types.ts';
import { compareHlc } from '../hlc.ts';
import { compareCodeUnits } from '../study/queue.ts';

/**
 * Check database: rebuild the collection from the event log (the truth) and compare it with the
 * collection the app is running on, which was built incrementally from a saved snapshot plus
 * later events. Any difference means derived data drifted. Pure; the caller reads storage.
 */

export type CollectionArea =
  | 'noteTypes'
  | 'layouts'
  | 'decks'
  | 'notes'
  | 'cards'
  | 'reviews'
  | 'undoneReviews'
  | 'fsrsParams'
  | 'pages'
  | 'courses'
  | 'media'
  | 'spokenAudio'
  | 'preferences'
  | 'otherEvents'
  | 'registers'
  | 'pending';

export type CollectionDifferenceKind =
  /** In the rebuilt collection, not in the running one. */
  | 'missing'
  /** In the running collection, not in the rebuilt one. */
  | 'extra'
  | 'changed';

export interface CollectionDifference {
  area: CollectionArea;
  id: string;
  kind: CollectionDifferenceKind;
}

export interface CollectionComparison {
  /** Differences up to the limit, ordered by area then id. */
  differences: CollectionDifference[];
  byArea: Partial<Record<CollectionArea, number>>;
  total: number;
  /** Event counts (`getTotalAppliedEventCount`) of the rebuilt and the running collection. */
  rebuiltEvents: number;
  currentEvents: number;
}

/** JSON with object keys sorted, so the same data built two ways compares equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort(compareCodeUnits)) {
      sorted[k] = (v as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

type Keyed = Map<string, string>;

function byId<T>(items: readonly T[], key: (item: T) => string): Keyed {
  const out: Keyed = new Map();
  for (const item of items) out.set(key(item), canonical(item));
  return out;
}

function byRecord(record: Record<string, unknown> | undefined, prefix = '', into?: Keyed): Keyed {
  const out: Keyed = into ?? new Map();
  for (const [k, v] of Object.entries(record ?? {})) out.set(prefix + k, canonical(v));
  return out;
}

function areaMaps(s: SerializedCollectionState): Record<CollectionArea, Keyed> {
  const spoken = byRecord(s.ttsMediaByKey, 'key:');
  byRecord(s.ttsMediaByLangKey, 'lang:', spoken);
  const pending = byRecord(s.pendingDeckPatches, 'deck:');
  byRecord(s.pendingPagePatches, 'page:', pending);
  byRecord(s.noteArchivedState, 'archived:', pending);
  return {
    noteTypes: byId(s.noteTypes, (x) => x.id),
    layouts: byId(s.layouts, (x) => x.id),
    decks: byId(s.decks, (x) => x.id),
    notes: byId(s.notes, (x) => x.id),
    cards: byId(s.cards, (x) => x.id),
    reviews: byRecord(s.reviewsByCard),
    undoneReviews: new Map(s.undoneReviewIds.map((id) => [id, '1'])),
    fsrsParams: byRecord(s.deckFsrsParams),
    pages: byId(s.pages, (x) => x.id),
    courses: byId(s.courses, (x) => x.id),
    media: byId(s.media, (x) => x.hash.toLowerCase()),
    spokenAudio: spoken,
    preferences: new Map([['preferences', canonical(s.preferences)]]),
    otherEvents: byId(s.unknownEvents, (x) => x.id),
    registers: byRecord(s.fieldHlcs),
    pending,
  };
}

const AREA_ORDER: readonly CollectionArea[] = [
  'decks',
  'notes',
  'cards',
  'reviews',
  'undoneReviews',
  'fsrsParams',
  'noteTypes',
  'layouts',
  'pages',
  'courses',
  'media',
  'spokenAudio',
  'preferences',
  'otherEvents',
  'pending',
  'registers',
];

interface DifferenceTally {
  differences: CollectionDifference[];
  byArea: Partial<Record<CollectionArea, number>>;
  total: number;
  limit: number;
}

function compareArea(tally: DifferenceTally, area: CollectionArea, w: Keyed, h: Keyed): void {
  const ids = [...new Set([...w.keys(), ...h.keys()])].sort(compareCodeUnits);
  for (const id of ids) {
    const a = w.get(id);
    const b = h.get(id);
    let kind: CollectionDifferenceKind | null = null;
    if (a === undefined) kind = 'extra';
    else if (b === undefined) kind = 'missing';
    else if (a !== b) kind = 'changed';
    if (kind === null) continue;
    tally.total += 1;
    tally.byArea[area] = (tally.byArea[area] ?? 0) + 1;
    if (tally.differences.length < tally.limit) tally.differences.push({ area, id, kind });
  }
}

function finishComparison(
  tally: DifferenceTally,
  expected: CollectionState,
  actual: CollectionState,
): CollectionComparison {
  return {
    differences: tally.differences,
    byArea: tally.byArea,
    total: tally.total,
    rebuiltEvents: getTotalAppliedEventCount(expected),
    currentEvents: getTotalAppliedEventCount(actual),
  };
}

/** Compares the rebuilt collection (`expected`) with the running one (`actual`). */
export function compareCollectionStates(
  expected: CollectionState,
  actual: CollectionState,
  opts: { limit?: number } = {},
): CollectionComparison {
  const tally: DifferenceTally = {
    differences: [],
    byArea: {},
    total: 0,
    limit: opts.limit ?? 200,
  };
  const want = areaMaps(serializeCollectionState(expected));
  const have = areaMaps(serializeCollectionState(actual));
  for (const area of AREA_ORDER) compareArea(tally, area, want[area], have[area]);
  return finishComparison(tally, expected, actual);
}

/** Lets the host run (paint, input) between steps of a long check. */
export type Pause = () => Promise<void>;

/**
 * {@link compareCollectionStates} in steps, pausing between the heavy ones, so a large collection
 * doesn't freeze the screen (§8). Same result.
 */
export async function compareCollectionStatesAsync(
  expected: CollectionState,
  actual: CollectionState,
  pause: Pause,
  opts: { limit?: number } = {},
): Promise<CollectionComparison> {
  const tally: DifferenceTally = {
    differences: [],
    byArea: {},
    total: 0,
    limit: opts.limit ?? 200,
  };
  const want = areaMaps(serializeCollectionState(expected));
  await pause();
  const have = areaMaps(serializeCollectionState(actual));
  for (const area of AREA_ORDER) {
    await pause();
    compareArea(tally, area, want[area], have[area]);
  }
  return finishComparison(tally, expected, actual);
}

export interface LogCoverage {
  /** Every device's events are in the log from seq 1, so a full rebuild sees the whole history. */
  complete: boolean;
  /** Devices whose early events are only in a snapshot (hydrated from another device). */
  devicesWithGaps: string[];
  /** Highest seq per device in the log. */
  maxSeqByDevice: Record<string, number>;
}

/**
 * Whether `events` hold every device's history from its first event. `watermarks` are the
 * running collection's snapshot watermarks: a device listed there must also be in the log.
 */
export function checkLogCoverage(
  events: readonly FlashEvent[],
  watermarks: ReadonlyMap<string, number> = new Map(),
): LogCoverage {
  const seqs = new Map<string, Set<number>>();
  for (const ev of events) {
    if (!Number.isFinite(ev.seq) || ev.seq <= 0) continue;
    let set = seqs.get(ev.device);
    if (!set) {
      set = new Set();
      seqs.set(ev.device, set);
    }
    set.add(ev.seq);
  }
  const maxSeqByDevice: Record<string, number> = {};
  const devicesWithGaps: string[] = [];
  const devices = new Set<string>([...seqs.keys(), ...watermarks.keys()]);
  for (const device of [...devices].sort(compareCodeUnits)) {
    const set = seqs.get(device) ?? new Set<number>();
    let max = 0;
    for (const s of set) if (s > max) max = s;
    if (max > 0) maxSeqByDevice[device] = max;
    const needed = Math.max(max, watermarks.get(device) ?? 0);
    if (set.size < needed) devicesWithGaps.push(device);
  }
  return { complete: devicesWithGaps.length === 0, devicesWithGaps, maxSeqByDevice };
}

/** The collection rebuilt from nothing but the event log. */
export function rebuildFromEvents(events: readonly FlashEvent[]): CollectionState {
  return applyEvents(createEmptyState(), events);
}

const REBUILD_CHUNK = 2000;

function byHlcThenId(a: FlashEvent, b: FlashEvent): number {
  return compareHlc(a.hlc, b.hlc) || compareCodeUnits(a.id, b.id);
}

/**
 * {@link rebuildFromEvents} in chunks of the log in (hlc, id) order, pausing between them. Replay
 * converges whatever the delivery order (that is what lets sync deliver in batches), so the
 * result equals the one-batch rebuild.
 */
export async function rebuildFromEventsAsync(
  events: readonly FlashEvent[],
  pause: Pause,
  chunk = REBUILD_CHUNK,
): Promise<CollectionState> {
  const sorted = [...events].sort(byHlcThenId);
  const state = createEmptyState();
  for (let i = 0; i < sorted.length; i += chunk) {
    applyEvents(state, sorted.slice(i, i + chunk));
    if (i + chunk < sorted.length) await pause();
  }
  return state;
}
