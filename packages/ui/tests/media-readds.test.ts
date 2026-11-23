import 'fake-indexeddb/auto';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type KnownEvent,
} from '@flash/core';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '@flash/core/samples';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieStorage } from '../../platform-web/src/storage/dexie-storage.ts';
import { priorOfMediaEdits } from '../src/state/mediaEditPrior.ts';
import { planMediaReAdds } from '../src/state/mediaReAdds.ts';
import { storedMediaEntries } from '../src/state/storedMedia.ts';

const LISTED = 'a'.repeat(64);
const REMOVED = 'b'.repeat(64);
const GONE = 'c'.repeat(64);
const T0 = SAMPLE_SEED_EPOCH_MS + 1000;

const opened: DexieStorage[] = [];
afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
});

function setup() {
  const storage = new DexieStorage(`media-readds-${Date.now()}-${Math.random()}`);
  opened.push(storage);
  const factory = createEventFactory('dev-a', 0, createHlcState('dev-a', 0));
  const events: KnownEvent[] = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS);
  const state = applyEvents(createEmptyState(), events);
  for (const hash of [LISTED, REMOVED]) {
    applyEvents(state, [
      factory.create('MediaAdded', { media: { hash, ext: 'png', mime: 'image/png', size: 3 } }, T0),
    ]);
  }
  applyEvents(state, [factory.create('MediaRemoved', { hash: REMOVED }, T0 + 1)]);
  const deckId = [...state.decks.keys()][0] ?? '';
  const edit = (noteId: string, hashes: string[]) =>
    factory.create(
      'NoteUpserted',
      {
        note_id: noteId,
        deck_id: deckId,
        source_key: noteId,
        fields: { front: hashes.map((h) => `<img src="media:${h}">`).join('') },
      },
      T0 + 10,
    );
  return { storage, state, edit };
}

describe('media re-adds on edit', () => {
  it('re-adds every file an edit starts to use: listed, or read back from this device', async () => {
    const { storage, state, edit } = setup();
    await storage.putMedia({ hash: REMOVED, mime: 'image/png', bytes: new Uint8Array([1, 2]) });
    const note = edit('n1', [LISTED, REMOVED, GONE]);
    // Taken before the edit applies: note fields change in place.
    const prior = priorOfMediaEdits(state, [note]);
    if (!prior) throw new Error('expected a media edit');
    applyEvents(state, [note]);
    expect(await planMediaReAdds(prior, [note], state, storage)).toEqual([
      { hash: LISTED, ext: 'png', mime: 'image/png', size: 3 },
      { hash: REMOVED, ext: 'png', mime: 'image/png', size: 2 },
    ]);

    // Saving the same note again re-adds nothing; an edit without media skips the check.
    const same = edit('n1', [LISTED]);
    const again = priorOfMediaEdits(state, [same]);
    if (!again) throw new Error('expected a media edit');
    expect(await planMediaReAdds(again, [same], state, storage)).toEqual([]);
    expect(priorOfMediaEdits(state, [edit('n2', [])])).toBeNull();
  });

  it('reads entries for files this device stores, skipping unsafe types', async () => {
    const { storage } = setup();
    await storage.putMedia({ hash: REMOVED, mime: 'image/png', bytes: new Uint8Array([1, 2]) });
    await storage.putMedia({ hash: GONE, mime: 'image/svg+xml', bytes: new Uint8Array([1]) });
    expect(await storedMediaEntries(storage, [REMOVED, GONE, LISTED])).toEqual([
      { hash: REMOVED, ext: 'png', mime: 'image/png', size: 2 },
    ]);
  });
});
