import { describe, expect, it } from 'vitest';
import {
  checkLogCoverage,
  checkMedia,
  collectMediaReferences,
  compareCollectionStates,
  compareCollectionStatesAsync,
  mediaFilesToDelete,
  planMediaRemoval,
  rebuildFromEvents,
  rebuildFromEventsAsync,
} from '../src/check/index.ts';
import { newlyReferencedMedia } from '../src/events/media-refs.ts';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import {
  deserializeCollectionState,
  serializeCollectionState,
  snapshotLacksMediaRecords,
  type SerializedCollectionState,
} from '../src/events/snapshot.ts';
import type { FlashEvent, KnownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';

const T0 = SAMPLE_SEED_EPOCH_MS + 1000;
const hash = (c: string) => c.repeat(64);
const A = hash('a');
const B = hash('b');
const C = hash('c');
const D = hash('d');
const E = hash('e');
const F = hash('f');
const G = hash('1');

function factoryFor(device: string): EventFactory {
  return createEventFactory(device, 0, createHlcState(device, 0));
}

function mediaAdded(f: EventFactory, h: string, at: number, extra: object = {}): KnownEvent {
  return f.create(
    'MediaAdded',
    { media: { hash: h, ext: 'png', mime: 'image/png', size: 10, ...extra } },
    at,
  );
}

function sample(): { state: CollectionState; events: KnownEvent[]; f: EventFactory } {
  const f = factoryFor('dev-a');
  const events = buildSampleDeckEvents(f, SAMPLE_SEED_EPOCH_MS);
  return { state: applyEvents(createEmptyState(), events), events, f };
}

describe('MediaRemoved', () => {
  it('converges in any delivery order: the newest add or removal wins', () => {
    const f = factoryFor('dev-a');
    const add1 = mediaAdded(f, A, T0);
    const remove = f.create('MediaRemoved', { hash: A }, T0 + 1);
    const add2 = mediaAdded(f, A, T0 + 2);
    const orders: FlashEvent[][] = [
      [add1, remove, add2],
      [remove, add1, add2],
      [add2, remove, add1],
      [remove, add2, add1],
    ];
    for (const order of orders) {
      const state = createEmptyState();
      for (const ev of order) applyEvents(state, [ev]); // one batch each: no sorting help
      expect(state.media.has(A)).toBe(true);
    }
    for (const order of [
      [add1, remove],
      [remove, add1],
    ]) {
      const state = createEmptyState();
      for (const ev of order) applyEvents(state, [ev]);
      expect(state.media.has(A)).toBe(false);
    }
  });

  it('flows through worker patches and snapshots, and folds when an older build kept it', () => {
    const f = factoryFor('dev-a');
    const base = applyEvents(createEmptyState(), [mediaAdded(f, A, T0), mediaAdded(f, B, T0)]);
    const remove = f.create('MediaRemoved', { hash: A }, T0 + 1);

    const worker = deserializeCollectionState(serializeCollectionState(base));
    const main = deserializeCollectionState(serializeCollectionState(base));
    const patch = computeStatePatch(worker, [remove]);
    expect(patch.removedMedia).toEqual([A]);
    mergeStatePatch(main, patch);
    expect([...main.media.keys()]).toEqual([B]);

    const restored = deserializeCollectionState(serializeCollectionState(main));
    expect([...restored.media.keys()]).toEqual([B]);

    // An older build stored the event as unknown and never applied it.
    const old = serializeCollectionState(base);
    old.unknownEvents.push(remove);
    const folded = deserializeCollectionState(old);
    expect([...folded.media.keys()]).toEqual([B]);
    expect(folded.unknownEvents).toHaveLength(0);
  });
});

function noteUsing(f: EventFactory, deckId: string, noteId: string, h: string, at: number) {
  return f.create(
    'NoteUpserted',
    {
      note_id: noteId,
      deck_id: deckId,
      source_key: noteId,
      fields: { front: `<img src="media:${h}">` },
    },
    at,
  );
}

/** What a build before media removal saved: version 1, without the media add registers. */
function asPreRemovalSnapshot(s: SerializedCollectionState): SerializedCollectionState {
  s.formatVersion = 1;
  s.fieldHlcs = Object.fromEntries(
    Object.entries(s.fieldHlcs).filter(([k]) => !(k.startsWith('media:') && k.endsWith(':added'))),
  );
  return s;
}

describe('media re-adds and old snapshots', () => {
  it('lists the hashes an edit starts to use, not ones it already used or adds itself', () => {
    const { state, f } = sample();
    const deckId = [...state.decks.keys()][0] ?? '';
    applyEvents(state, [noteUsing(f, deckId, 'n1', A, T0)]);
    const edits = [
      noteUsing(f, deckId, 'n1', A, T0 + 1), // already used by n1
      noteUsing(f, deckId, 'n2', B, T0 + 1), // a new use
      mediaAdded(f, C, T0 + 1),
      noteUsing(f, deckId, 'n3', C, T0 + 1), // added by the same batch
      f.create(
        'PageUpserted',
        { page_id: 'p1', slug: 'p1', title: 'P', markdown: `![x](media:${D})` },
        T0 + 1,
      ),
    ];
    expect(newlyReferencedMedia(state, edits)).toEqual([B, D]);
  });

  it('an edit that re-adds a file beats an older removal from another device, in any order', () => {
    const { state: base, events, f } = sample();
    const deckId = [...base.decks.keys()][0] ?? '';
    const orphanAdd = mediaAdded(f, A, T0); // listed, used by nothing
    const b = factoryFor('dev-b');
    const removal = b.create('MediaRemoved', { hash: A }, T0 + 5); // Check media on dev-b
    // dev-a, offline: a note starts using A, and the edit re-adds it (what emitEvents does).
    const edit = noteUsing(f, deckId, 'n-offline', A, T0 + 10);
    const reAdd = mediaAdded(f, A, T0 + 10);
    for (const order of [
      [removal, edit, reAdd],
      [edit, reAdd, removal],
      [edit, removal, reAdd],
    ]) {
      const s = applyEvents(createEmptyState(), [...events, orphanAdd]);
      for (const ev of order) applyEvents(s, [ev]);
      expect(s.media.has(A)).toBe(true);
    }
    // Without the re-add the removal wins and a live note loses its image.
    const without = applyEvents(createEmptyState(), [...events, orphanAdd, edit]);
    applyEvents(without, [removal]);
    expect(without.media.has(A)).toBe(false);
  });

  it('hydrates a snapshot from before media removal the way a full replay does', () => {
    const { events, f } = sample();
    const deckId = [...applyEvents(createEmptyState(), events).decks.keys()][0] ?? '';
    const b = factoryFor('dev-b');
    // dev-b decided a removal before dev-a's add reached it; dev-a's add is newer.
    const removal = b.create('MediaRemoved', { hash: A }, T0 + 5);
    const log = [...events, mediaAdded(f, A, T0 + 10), noteUsing(f, deckId, 'n-a', A, T0 + 11)];
    const oldSnapshot = () =>
      asPreRemovalSnapshot(
        serializeCollectionState(applyEvents(createEmptyState(), log), { 'dev-a': log.length }),
      );

    const full = applyEvents(createEmptyState(), [...log, removal]);
    expect(full.media.has(A)).toBe(true);

    const old = oldSnapshot();
    expect(snapshotLacksMediaRecords(old)).toBe(true);
    const hydrated = deserializeCollectionState(old);
    applyEvents(hydrated, [removal]);
    expect(hydrated.media.has(A)).toBe(true);
    expect(compareCollectionStates(full, hydrated).byArea.media ?? 0).toBe(0);
    // Saved again, it is a current snapshot.
    expect(snapshotLacksMediaRecords(serializeCollectionState(hydrated))).toBe(false);

    // A removal newer than everything still wins on both.
    const later = b.create('MediaRemoved', { hash: A }, T0 + 60_000);
    applyEvents(full, [later]);
    const hydrated2 = deserializeCollectionState(oldSnapshot());
    applyEvents(hydrated2, [later]);
    expect(full.media.has(A)).toBe(false);
    expect(hydrated2.media.has(A)).toBe(false);
  });
});

describe('checkMedia', () => {
  it('finds unused and missing files, keeping spoken audio and files backups hold', () => {
    const { state, f } = sample();
    const deck = [...state.decks.values()][0];
    if (!deck) throw new Error('no sample deck');
    applyEvents(state, [
      mediaAdded(f, A, T0),
      mediaAdded(f, B, T0),
      mediaAdded(f, C, T0),
      mediaAdded(f, F, T0, { tts_key: 'k1' }),
      f.create(
        'NoteUpserted',
        {
          note_id: 'note-media',
          deck_id: deck.id,
          source_key: 'note-media',
          fields: { front: `<img src="media:${A.toUpperCase()}">`, back: `[audio](media:${G})` },
        },
        T0,
      ),
      f.create(
        'PageUpserted',
        { page_id: 'page-1', slug: 'p', title: 'P', markdown: `![x](media:${B})`, tags: [] },
        T0,
      ),
    ]);

    const refs = collectMediaReferences(state);
    expect(refs.get(A)?.noteIds).toEqual(['note-media']);
    expect(refs.get(B)?.pageIds).toEqual(['page-1']);

    // Stored: A, B, C (unused, in the collection), D (orphan), E (orphan a backup lists), F (TTS).
    const report = checkMedia(state, { storedHashes: [A, B, C, D, E, F], backupHashes: [C, E] });
    expect(report.usedCount).toBe(2);
    expect(report.spokenAudio).toBe(1);
    expect(report.keptForBackups).toBe(1);
    expect(report.unused.map((u) => [u.hash, u.inCollection, u.keepFileForBackups])).toEqual([
      [C, true, true],
      [D, false, false],
    ]);
    expect(report.missing.map((m) => [m.hash, m.noteIds, m.inCollection])).toEqual([
      [G, ['note-media'], false],
    ]);

    expect(planMediaRemoval(report)).toEqual([{ type: 'MediaRemoved', payload: { hash: C } }]);
    expect(mediaFilesToDelete(report)).toEqual([D]);

    const removal = planMediaRemoval(report).map((s) => f.create(s.type, s.payload, T0 + 5));
    applyEvents(state, removal);
    const after = checkMedia(state, { storedHashes: [A, B, C, E, F], backupHashes: [C, E] });
    expect(after.unused).toEqual([]);
    expect(after.keptForBackups).toBe(2);
  });
});

describe('check database', () => {
  it('reports no differences for a rebuild of the same log, however it was built', () => {
    const { events, f } = sample();
    const more = [mediaAdded(f, A, T0), f.create('MediaRemoved', { hash: A }, T0 + 1)];
    const rebuilt = rebuildFromEvents([...events, ...more]);

    // Running collection: snapshot of the first part, the rest applied through a worker patch.
    const running = deserializeCollectionState(
      serializeCollectionState(applyEvents(createEmptyState(), events), { 'dev-a': events.length }),
    );
    const worker = deserializeCollectionState(serializeCollectionState(running));
    mergeStatePatch(running, computeStatePatch(worker, more));

    const cmp = compareCollectionStates(rebuilt, running);
    expect(cmp.total).toBe(0);
    expect(cmp.rebuiltEvents).toBe(cmp.currentEvents);
  });

  it('lists drifted entries by area', () => {
    const { events } = sample();
    const rebuilt = rebuildFromEvents(events);
    const running = rebuildFromEvents(events);
    const card = [...running.cards.values()][0];
    const note = [...running.notes.values()][0];
    const deck = [...running.decks.values()][0];
    if (!card || !note || !deck) throw new Error('no sample cards');
    running.cards.set(card.id, {
      ...card,
      schedule: { ...card.schedule, due: card.schedule.due + 1 },
    });
    running.notes.delete(note.id);
    running.decks.set('ghost', { ...deck, id: 'ghost' });

    const cmp = compareCollectionStates(rebuilt, running);
    expect(cmp.byArea.cards).toBeGreaterThanOrEqual(1);
    expect(cmp.differences).toContainEqual({ area: 'cards', id: card.id, kind: 'changed' });
    expect(cmp.differences).toContainEqual({ area: 'notes', id: note.id, kind: 'missing' });
    expect(cmp.differences).toContainEqual({ area: 'decks', id: 'ghost', kind: 'extra' });
  });

  it('rebuilds and compares in steps with the same result as in one go', async () => {
    const { events, f } = sample();
    const b = factoryFor('dev-b');
    const log = [
      ...events,
      mediaAdded(f, A, T0),
      b.create('MediaRemoved', { hash: A }, T0 + 1),
      mediaAdded(b, B, T0 + 2),
    ].reverse(); // the stored order does not matter
    let pauses = 0;
    const pause = async () => {
      pauses += 1;
    };
    const stepped = await rebuildFromEventsAsync(log, pause, 7);
    expect(pauses).toBeGreaterThan(1);
    const whole = rebuildFromEvents(log);
    expect(compareCollectionStates(whole, stepped).total).toBe(0);
    expect(await compareCollectionStatesAsync(whole, stepped, pause)).toEqual(
      compareCollectionStates(whole, stepped),
    );
    const card = [...stepped.cards.values()][0];
    if (!card) throw new Error('no cards');
    stepped.cards.delete(card.id);
    expect(await compareCollectionStatesAsync(whole, stepped, pause)).toEqual(
      compareCollectionStates(whole, stepped),
    );
  });

  it('knows when the log lacks history another device folded into a snapshot', () => {
    const a = factoryFor('dev-a');
    const b = factoryFor('dev-b');
    const evA = [mediaAdded(a, A, T0), mediaAdded(a, B, T0 + 1)];
    const evB = [mediaAdded(b, C, T0), mediaAdded(b, D, T0 + 1), mediaAdded(b, E, T0 + 2)];
    expect(checkLogCoverage([...evA, ...evB]).complete).toBe(true);

    const gap = checkLogCoverage([...evA, ...evB.slice(2)]);
    expect(gap.complete).toBe(false);
    expect(gap.devicesWithGaps).toEqual(['dev-b']);

    const hydrated = checkLogCoverage(evA, new Map([['dev-c', 4]]));
    expect(hydrated.devicesWithGaps).toEqual(['dev-c']);
    expect(hydrated.maxSeqByDevice).toEqual({ 'dev-a': 2 });
  });
});
