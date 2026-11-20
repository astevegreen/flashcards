import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  getTotalAppliedEventCount,
  type CollectionState,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { FlashEvent, UnknownEvent } from '../src/events/types.ts';
import { createHlcState, receiveHlc, type HlcState } from '../src/hlc.ts';
import { deriveCardId, deriveNoteId } from '../src/ids.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import type { ReviewRating } from '../src/model/types.ts';
import { runSync } from '../src/sync/engine.ts';
import {
  createInitialSyncCursor,
  SyncTransportError,
  type SyncCursorState,
  type SyncFileInfo,
  type SyncStoreTransport,
} from '../src/sync/types.ts';

class TestMemorySyncStore implements SyncStoreTransport {
  private readonly files = new Map<string, { data: Uint8Array; updatedAt: number }>();
  private tick = 1;

  async list(prefix: string): Promise<SyncFileInfo[]> {
    const out: SyncFileInfo[] = [];
    for (const [path, entry] of this.files.entries()) {
      if (path.startsWith(prefix)) {
        out.push({ path, size: entry.data.byteLength, updatedAt: entry.updatedAt });
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const entry = this.files.get(path);
    if (!entry) {
      throw new SyncTransportError('NOT_FOUND', `Not found: ${path}`);
    }
    return new Uint8Array(entry.data);
  }

  async write(path: string, data: Uint8Array, opts?: { ifAbsent?: boolean }): Promise<void> {
    if (opts?.ifAbsent && this.files.has(path)) {
      throw new SyncTransportError('ALREADY_EXISTS', `Already exists: ${path}`);
    }
    this.files.set(path, { data: new Uint8Array(data), updatedAt: this.tick++ });
  }
}

interface SimulatedDevice {
  deviceId: string;
  state: CollectionState;
  events: FlashEvent[];
  seq: number;
  hlc: HlcState;
  cursor: SyncCursorState;
}

function createSimDevice(deviceId: string, startMs: number): SimulatedDevice {
  return {
    deviceId,
    state: createEmptyState(),
    events: [],
    seq: 0,
    hlc: createHlcState(deviceId, startMs),
    cursor: createInitialSyncCursor(),
  };
}

function appendLocalEvent(dev: SimulatedDevice, event: FlashEvent): void {
  dev.events.push(event);
  applyEvents(dev.state, [event]);
}

async function syncDevice(
  dev: SimulatedDevice,
  store: SyncStoreTransport,
  snapshotThreshold: number,
  nowMs: number,
): Promise<void> {
  const canBootstrap = dev.state.decks.size === 0 && dev.seq === 0;
  const result = await runSync({
    transport: store,
    deviceId: dev.deviceId,
    cursor: dev.cursor,
    localOwnSeq: dev.seq,
    currentTotalEvents: getTotalAppliedEventCount(dev.state),
    canBootstrapFromSnapshot: canBootstrap,
    snapshotThreshold,
    maxEventsPerSegment: 4,
    nowMs: () => nowMs,
    getLocalEventsAfterSeq: async (afterSeq) =>
      dev.events.filter((e) => e.device === dev.deviceId && e.seq > afterSeq),
    buildSnapshotState: async (pulledEvents, hydratedSnap) => {
      const base = hydratedSnap
        ? hydratedSnap.state
        : serializeCollectionState(dev.state, {
            ...dev.cursor.remoteWatermarks,
            [dev.deviceId]: dev.seq,
          });
      const clone = deserializeCollectionState(base);
      if (pulledEvents.length > 0) applyEvents(clone, pulledEvents);
      const wm = { ...dev.cursor.remoteWatermarks, [dev.deviceId]: dev.seq };
      return {
        state: serializeCollectionState(clone, wm),
        totalEvents: getTotalAppliedEventCount(clone),
        watermarks: wm,
      };
    },
  });

  dev.cursor = result.cursor;
  if (result.maxRemoteHlc) {
    dev.hlc = receiveHlc(dev.hlc, result.maxRemoteHlc, nowMs);
  }
  if (result.hydratedSnapshot) {
    dev.state = deserializeCollectionState(result.hydratedSnapshot.state);
    if (result.pulledEvents.length > 0) {
      applyEvents(dev.state, result.pulledEvents);
    }
  } else if (result.pulledEvents.length > 0) {
    applyEvents(dev.state, result.pulledEvents);
  }
}

function canonicalState(state: CollectionState) {
  const decks = [...state.decks.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      settings: d.settings,
      initial_retention: d.initial_retention,
      source: d.source,
      archived: d.archived,
    }));

  const notes = [...state.notes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      deck_id: n.deck_id,
      fields: Object.fromEntries(Object.entries(n.fields).sort(([a], [b]) => a.localeCompare(b))),
      tags: n.tags,
      archived: n.archived,
      created_order: n.created_order,
    }));

  const cards = [...state.cards.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      note_id: c.note_id,
      deck_id: c.deck_id,
      layout_id: c.layout_id,
      schedule: c.schedule,
      last_reviewed_at: c.last_reviewed_at,
    }));

  const unknownEvents = [...state.unknownEvents]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((u) => JSON.parse(JSON.stringify(u)));

  return {
    decks,
    notes,
    cards,
    preferences: state.preferences,
    unknownEvents,
  };
}

describe('Phase 2 Sync Engine & State Patch Property Tests (fast-check)', () => {
  it('converges identically across 3 active devices + late-joining snapshot Device D under arbitrary segment/snapshot/out-of-order syncs', async () => {
    const deckId = 'deck-sync-prop-1';
    const noteKeys = ['n1', 'n2', 'n3'];
    const layoutId = 'layout:vocab-ko:recognition';

    const stepArb = fc.oneof(
      fc.record({
        kind: fc.constant('editField' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        noteIdx: fc.integer({ min: 0, max: 2 }),
        field: fc.constantFrom('word', 'meaning', 'notes'),
        value: fc.string({ minLength: 1, maxLength: 10 }),
        dt: fc.integer({ min: 10, max: 20_000 }),
      }),
      fc.record({
        kind: fc.constant('archiveToggle' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        noteIdx: fc.integer({ min: 0, max: 2 }),
        archive: fc.boolean(),
        dt: fc.integer({ min: 10, max: 20_000 }),
      }),
      fc.record({
        kind: fc.constant('review' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        noteIdx: fc.integer({ min: 0, max: 2 }),
        rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4),
        dt: fc.integer({ min: 10, max: 400_000 }),
      }),
      fc.record({
        kind: fc.constant('undo' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        pick: fc.nat(20),
        dt: fc.integer({ min: 10, max: 20_000 }),
      }),
      fc.record({
        kind: fc.constant('deckSettings' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        name: fc.constantFrom('Korean Core', 'Korean Deck B', 'Hanja Mix'),
        newPerDay: fc.constantFrom(10, 20, 30),
        dt: fc.integer({ min: 10, max: 20_000 }),
      }),
      fc.record({
        kind: fc.constant('fsrsParams' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        version: fc.integer({ min: 1, max: 2 }),
        retention: fc.constantFrom(0.85, 0.9, 0.93),
        rescheduleExisting: fc.boolean(),
        dt: fc.integer({ min: 10, max: 20_000 }),
      }),
      fc.record({
        kind: fc.constant('unknownFuture' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        tag: fc.string({ minLength: 1, maxLength: 6 }),
        dt: fc.integer({ min: 10, max: 20_000 }),
      }),
      fc.record({
        kind: fc.constant('syncOne' as const),
        deviceIdx: fc.integer({ min: 0, max: 2 }),
        dt: fc.integer({ min: 10, max: 20_000 }),
      }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 10, maxLength: 35 }), async (steps) => {
        const baseTime = Date.UTC(2026, 2, 1, 10, 0, 0);
        const store = new TestMemorySyncStore();
        const devA = createSimDevice('dev-a', baseTime);
        const devB = createSimDevice('dev-b', baseTime + 250);
        const devC = createSimDevice('dev-c', baseTime - 150);
        const devices = [devA, devB, devC] as const;
        const reviewIds: string[] = [];

        const makeFactory = (d: SimulatedDevice) => createEventFactory(d.deviceId, d.seq, d.hlc);
        const commitFromFactory = (
          d: SimulatedDevice,
          factory: ReturnType<typeof createEventFactory>,
          ev: FlashEvent,
        ) => {
          d.seq = factory.getSeq();
          d.hlc = factory.getHlc();
          appendLocalEvent(d, ev);
        };

        // Seed initial deck + notes on Device A
        const seedFactory = makeFactory(devA);
        commitFromFactory(
          devA,
          seedFactory,
          seedFactory.create(
            'DeckCreated',
            {
              deck_id: deckId,
              name: 'Sync Prop Deck',
              note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
              language: 'ko',
              created_at: baseTime,
            },
            baseTime,
          ),
        );
        for (let i = 0; i < noteKeys.length; i++) {
          const key = noteKeys[i];
          if (!key) continue;
          commitFromFactory(
            devA,
            seedFactory,
            seedFactory.create(
              'NoteUpserted',
              {
                note_id: deriveNoteId(deckId, key),
                deck_id: deckId,
                source_key: key,
                fields: { word: `word-${i}`, meaning: `meaning-${i}` },
                created_order: i,
              },
              baseTime + i + 1,
            ),
          );
        }

        let clock = baseTime + 1000;
        let stepCounter = 0;
        for (const step of steps) {
          clock += step.dt;
          stepCounter += 1;
          const dev = devices[step.deviceIdx] ?? devA;

          if (step.kind === 'syncOne') {
            await syncDevice(dev, store, 6, clock);
            continue;
          }

          const factory = makeFactory(dev);
          if (step.kind === 'editField') {
            const key = noteKeys[step.noteIdx];
            if (!key) continue;
            commitFromFactory(
              dev,
              factory,
              factory.create(
                'NoteUpserted',
                {
                  note_id: deriveNoteId(deckId, key),
                  deck_id: deckId,
                  source_key: key,
                  fields: { [step.field]: step.value },
                },
                clock,
              ),
            );
          } else if (step.kind === 'archiveToggle') {
            const key = noteKeys[step.noteIdx];
            if (!key) continue;
            commitFromFactory(
              dev,
              factory,
              factory.create(
                step.archive ? 'NoteArchived' : 'NoteRestored',
                { note_id: deriveNoteId(deckId, key) },
                clock,
              ),
            );
          } else if (step.kind === 'review') {
            const key = noteKeys[step.noteIdx];
            if (!key) continue;
            const noteId = deriveNoteId(deckId, key);
            const cardId = deriveCardId(noteId, layoutId, 0);
            const reviewId = `rev-${dev.deviceId}-${stepCounter}`;
            reviewIds.push(reviewId);
            commitFromFactory(
              dev,
              factory,
              factory.create(
                'ReviewRecorded',
                {
                  review_id: reviewId,
                  card_id: cardId,
                  rating: step.rating,
                  reviewed_at: clock,
                  tz_offset: 0,
                  duration_ms: 850,
                  answer_mode: 'flip',
                  fsrs_params_version: 0,
                  resulting_due_at: clock + 60_000,
                },
                clock,
              ),
            );
          } else if (step.kind === 'undo' && reviewIds.length > 0) {
            const target = reviewIds[step.pick % reviewIds.length];
            if (!target) continue;
            commitFromFactory(
              dev,
              factory,
              factory.create('ReviewUndone', { review_id: target }, clock),
            );
          } else if (step.kind === 'deckSettings') {
            commitFromFactory(
              dev,
              factory,
              factory.create(
                'DeckSettingsChanged',
                {
                  deck_id: deckId,
                  name: step.name,
                  settings: { new_cards_per_day: step.newPerDay },
                },
                clock,
              ),
            );
          } else if (step.kind === 'fsrsParams') {
            commitFromFactory(
              dev,
              factory,
              factory.create(
                'DeckFSRSParamsChanged',
                {
                  deck_id: deckId,
                  params_version: step.version,
                  effective_from: clock,
                  params: { request_retention: step.retention, enable_fuzz: false },
                  reschedule_existing: step.rescheduleExisting,
                },
                clock,
              ),
            );
          } else if (step.kind === 'unknownFuture') {
            const dummy = factory.create('PreferencesChanged', { preferences: {} }, clock);
            const futureEv: UnknownEvent & { future_ext: string } = {
              id: dummy.id,
              device: dummy.device,
              seq: dummy.seq,
              hlc: dummy.hlc,
              type: 'FutureWidgetAdded',
              v: 9,
              payload: { tag: step.tag },
              future_ext: `ext-${step.tag}`,
            };
            commitFromFactory(dev, factory, futureEv);
          }
        }

        // Final convergence round across A, B, C (push all, then pull all)
        clock += 5000;
        for (const d of devices) await syncDevice(d, store, 6, ++clock);
        for (const d of devices) await syncDevice(d, store, 6, ++clock);

        // Late-joining Device D bootstraps from latest snapshot + any delta segments
        const devD = createSimDevice('dev-d', clock);
        await syncDevice(devD, store, 6, clock + 1);

        const snapA = canonicalState(devA.state);
        const snapB = canonicalState(devB.state);
        const snapC = canonicalState(devC.state);
        const snapD = canonicalState(devD.state);

        expect(snapB).toEqual(snapA);
        expect(snapC).toEqual(snapA);
        expect(snapD).toEqual(snapA);
      }),
      { numRuns: 25 },
    );
  });

  it('computeStatePatch + mergeStatePatch produces bit-for-bit identical CollectionState to direct applyEvents', () => {
    const deckId = 'deck-patch-1';
    const noteKeys = ['p1', 'p2', 'p3'];
    const layoutId = 'layout:vocab-ko:recognition';

    const opArb = fc.oneof(
      fc.record({
        kind: fc.constant('edit' as const),
        noteIdx: fc.integer({ min: 0, max: 2 }),
        field: fc.constantFrom('word', 'meaning', 'notes'),
        value: fc.string({ minLength: 1, maxLength: 10 }),
        dt: fc.integer({ min: 1, max: 10_000 }),
      }),
      fc.record({
        kind: fc.constant('archive' as const),
        noteIdx: fc.integer({ min: 0, max: 2 }),
        archived: fc.boolean(),
        dt: fc.integer({ min: 1, max: 10_000 }),
      }),
      fc.record({
        kind: fc.constant('review' as const),
        noteIdx: fc.integer({ min: 0, max: 2 }),
        rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4),
        dt: fc.integer({ min: 1, max: 200_000 }),
      }),
      fc.record({
        kind: fc.constant('undo' as const),
        pick: fc.nat(20),
        dt: fc.integer({ min: 1, max: 10_000 }),
      }),
      fc.record({
        kind: fc.constant('prefs' as const),
        mode: fc.constantFrom('2' as const, '3' as const, '4' as const),
        dt: fc.integer({ min: 1, max: 10_000 }),
      }),
      fc.record({
        kind: fc.constant('fsrs' as const),
        version: fc.integer({ min: 1, max: 2 }),
        retention: fc.constantFrom(0.85, 0.9, 0.94),
        reschedule: fc.boolean(),
        dt: fc.integer({ min: 1, max: 10_000 }),
      }),
    );

    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 5, maxLength: 30 }),
        fc.integer({ min: 1, max: 8 }),
        (ops, batchSize) => {
          const baseTime = Date.UTC(2026, 3, 1, 10, 0, 0);
          const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', baseTime));
          const events: FlashEvent[] = [
            factory.create(
              'DeckCreated',
              {
                deck_id: deckId,
                name: 'Patch Deck',
                note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
                language: 'ko',
                created_at: baseTime,
              },
              baseTime,
            ),
          ];

          for (let i = 0; i < noteKeys.length; i++) {
            const key = noteKeys[i];
            if (!key) continue;
            events.push(
              factory.create(
                'NoteUpserted',
                {
                  note_id: deriveNoteId(deckId, key),
                  deck_id: deckId,
                  source_key: key,
                  fields: { word: `w${i}`, meaning: `m${i}` },
                  created_order: i,
                },
                baseTime + i + 1,
              ),
            );
          }

          let clock = baseTime + 1000;
          const reviewIds: string[] = [];
          for (let idx = 0; idx < ops.length; idx++) {
            const op = ops[idx];
            if (!op) continue;
            clock += op.dt;
            if (op.kind === 'edit') {
              const key = noteKeys[op.noteIdx];
              if (!key) continue;
              events.push(
                factory.create(
                  'NoteUpserted',
                  {
                    note_id: deriveNoteId(deckId, key),
                    deck_id: deckId,
                    source_key: key,
                    fields: { [op.field]: op.value },
                  },
                  clock,
                ),
              );
            } else if (op.kind === 'archive') {
              const key = noteKeys[op.noteIdx];
              if (!key) continue;
              events.push(
                factory.create(
                  op.archived ? 'NoteArchived' : 'NoteRestored',
                  { note_id: deriveNoteId(deckId, key) },
                  clock,
                ),
              );
            } else if (op.kind === 'review') {
              const key = noteKeys[op.noteIdx];
              if (!key) continue;
              const noteId = deriveNoteId(deckId, key);
              const cardId = deriveCardId(noteId, layoutId, 0);
              const revId = `rev-patch-${idx}`;
              reviewIds.push(revId);
              events.push(
                factory.create(
                  'ReviewRecorded',
                  {
                    review_id: revId,
                    card_id: cardId,
                    rating: op.rating,
                    reviewed_at: clock,
                    tz_offset: 0,
                    duration_ms: 500,
                    answer_mode: 'flip',
                    fsrs_params_version: 0,
                    resulting_due_at: clock + 60_000,
                  },
                  clock,
                ),
              );
            } else if (op.kind === 'undo' && reviewIds.length > 0) {
              const revId = reviewIds[op.pick % reviewIds.length];
              if (!revId) continue;
              events.push(factory.create('ReviewUndone', { review_id: revId }, clock));
            } else if (op.kind === 'prefs') {
              events.push(
                factory.create(
                  'PreferencesChanged',
                  { preferences: { rating_button_mode: op.mode } },
                  clock,
                ),
              );
            } else if (op.kind === 'fsrs') {
              events.push(
                factory.create(
                  'DeckFSRSParamsChanged',
                  {
                    deck_id: deckId,
                    params_version: op.version,
                    effective_from: clock,
                    params: { request_retention: op.retention, enable_fuzz: false },
                    reschedule_existing: op.reschedule,
                  },
                  clock,
                ),
              );
            }
          }

          const directState = createEmptyState();
          const workerMirror = createEmptyState();
          const mainTarget = createEmptyState();

          for (let i = 0; i < events.length; i += batchSize) {
            const batch = events.slice(i, i + batchSize);
            applyEvents(directState, batch);
            const patch = computeStatePatch(workerMirror, batch);
            // Simulate structured clone across Web Worker postMessage boundary
            const clonedPatch = JSON.parse(JSON.stringify(patch));
            mergeStatePatch(mainTarget, clonedPatch);
          }

          expect(serializeCollectionState(mainTarget)).toEqual(
            serializeCollectionState(directState),
          );
          expect(mainTarget.cardIdsByDeck).toEqual(directState.cardIdsByDeck);
          expect(mainTarget.cardIdsByNote).toEqual(directState.cardIdsByNote);
          expect(mainTarget.noteIdsByDeck).toEqual(directState.noteIdsByDeck);
          expect(mainTarget.reviewIdToCardId).toEqual(directState.reviewIdToCardId);
        },
      ),
      { numRuns: 30 },
    );
  });
});
