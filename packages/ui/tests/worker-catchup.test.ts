import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  computeStatePatch,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveCardId,
  deriveNoteId,
  deserializeCollectionState,
  serializeCollectionState,
  type CollectionState,
  type FlashEvent,
  type SerializedCollectionState,
} from '@flash/core';
import type { ReplayWorkerClient } from '@flash/platform';
import { describe, expect, it } from 'vitest';
import { applyEventsViaWorkerWithConcurrentCatchup } from '../src/state/syncRunner.ts';

describe('applyEventsViaWorkerWithConcurrentCatchup (concurrent main-thread mutations)', () => {
  it('preserves local reviews and note edits emitted during both worker.hydrate() and worker.apply() on the exact same card and note', async () => {
    const t0 = Date.UTC(2026, 4, 1, 10, 0, 0);
    const deckId = 'deck-concurrent';
    const noteId = deriveNoteId(deckId, 'n1');
    const cardId = deriveCardId(noteId, 'layout:vocab-ko:recognition', 0);

    const fLocal = createEventFactory('dev-local', 0, createHlcState('dev-local', t0));
    const fRemote = createEventFactory('dev-remote', 0, createHlcState('dev-remote', t0 + 50));

    const seedEvents: FlashEvent[] = [
      fLocal.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: 'Concurrent Deck',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: t0,
        },
        t0,
      ),
      fLocal.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: 'n1',
          fields: { word: '학교', meaning: 'school', notes: 'initial' },
        },
        t0 + 10,
      ),
    ];

    const mainState = applyEvents(createEmptyState(), seedEvents);
    const expectedState = applyEvents(createEmptyState(), seedEvents);

    // Remote events touching the SAME note & card
    const remoteEvents: FlashEvent[] = [
      fRemote.create(
        'NoteUpserted',
        {
          note_id: noteId,
          deck_id: deckId,
          source_key: 'n1',
          fields: { meaning: 'school (remote)' },
        },
        t0 + 1000,
      ),
      fRemote.create(
        'ReviewRecorded',
        {
          review_id: 'rev-remote-1',
          card_id: cardId,
          rating: 3,
          reviewed_at: t0 + 1100,
          tz_offset: 0,
          duration_ms: 800,
          answer_mode: 'flip',
          fsrs_params_version: 0,
          resulting_due_at: t0 + 86_400_000,
        },
        t0 + 1100,
      ),
    ];

    // Local mutation #1 emitted DURING worker.hydrate(...)
    const localDuringHydrate = fLocal.create(
      'NoteUpserted',
      {
        note_id: noteId,
        deck_id: deckId,
        source_key: 'n1',
        fields: { notes: 'edited-during-hydrate' },
      },
      t0 + 2000,
    );

    // Local mutation #2 emitted DURING worker.apply(remoteEvents) on the SAME card!
    const localDuringApply = fLocal.create(
      'ReviewRecorded',
      {
        review_id: 'rev-local-during-apply',
        card_id: cardId,
        rating: 4,
        reviewed_at: t0 + 3000,
        tz_offset: 0,
        duration_ms: 600,
        answer_mode: 'flip',
        fsrs_params_version: 0,
        resulting_due_at: t0 + 4 * 86_400_000,
      },
      t0 + 3000,
    );

    // Reference ground-truth state applying all events directly
    applyEvents(expectedState, [...remoteEvents, localDuringHydrate, localDuringApply]);

    // Simulated async Worker that injects concurrent local mutations right during hydrate & apply
    let workerState: CollectionState = createEmptyState();
    const pendingLocalQueue: FlashEvent[] = [];
    let trackingLocal = false;
    let applyCallCount = 0;

    const emitLocalOnMainThread = (ev: FlashEvent) => {
      applyEvents(mainState, [ev]);
      if (trackingLocal) {
        pendingLocalQueue.push(ev);
      }
    };

    const mockWorker: ReplayWorkerClient = {
      async hydrate(snapshot: SerializedCollectionState) {
        workerState = deserializeCollectionState(snapshot);
        // Simulate main-thread user edit arriving while hydrate is in flight!
        emitLocalOnMainThread(localDuringHydrate);
      },
      async apply(events: readonly FlashEvent[]) {
        applyCallCount += 1;
        const patch = computeStatePatch(workerState, events);
        const cloned = JSON.parse(JSON.stringify(patch));
        // On the first apply (remoteEvents), simulate user rating the same card while worker runs!
        if (applyCallCount === 1) {
          emitLocalOnMainThread(localDuringApply);
        }
        return cloned;
      },
      terminate() {},
    };

    const diff = await applyEventsViaWorkerWithConcurrentCatchup({
      worker: mockWorker,
      state: mainState,
      remoteEvents,
      hydrateSnapshot: () => {
        const snap = serializeCollectionState(mainState, { 'dev-local': 2 });
        pendingLocalQueue.length = 0;
        trackingLocal = true;
        return snap;
      },
      drainPendingLocalEvents: () => {
        const out = [...pendingLocalQueue];
        pendingLocalQueue.length = 0;
        return out;
      },
    });

    // Worker ran initial apply (localDuringHydrate + remoteEvents) + catchup apply (localDuringApply)
    expect(applyCallCount).toBe(2);
    expect(diff.changedCardIds).toContain(cardId);

    // Both remote AND concurrent local edits/reviews must be preserved bit-for-bit identically!
    const actualNote = mainState.notes.get(noteId);
    expect(actualNote?.fields['meaning']).toBe('school (remote)');
    expect(actualNote?.fields['notes']).toBe('edited-during-hydrate');

    const actualReviews = mainState.reviewsByCard.get(cardId) ?? [];
    expect(actualReviews.map((r) => r.review_id).sort()).toEqual([
      'rev-local-during-apply',
      'rev-remote-1',
    ]);

    expect(serializeCollectionState(mainState)).toEqual(serializeCollectionState(expectedState));
    expect(serializeCollectionState(workerState)).toEqual(
      serializeCollectionState(expectedState, { 'dev-local': 2 }),
    );
  });
});
