import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEventFactory,
  replayAllEvents,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { encodeUtf8, FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import { BUILTIN_NOTE_TYPE_IDS } from '../src/model/presets.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import { decodeUtf8 } from '../src/utf8-decode.ts';

const KO = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');
const KO_TYPE = BUILTIN_NOTE_TYPE_IDS.VOCAB_KO;
const T0 = SAMPLE_SEED_EPOCH_MS + 60_000;

function factoryFor(device: string): EventFactory {
  return createEventFactory(device, 0, createHlcState(device, SAMPLE_SEED_EPOCH_MS));
}

function sampleCollection(device: string): { state: CollectionState; factory: EventFactory } {
  const factory = factoryFor(device);
  return { state: replayAllEvents(buildSampleDeckEvents(factory)), factory };
}

/** A friend's export of the Korean sample deck, optionally with its JSON files edited. */
function friendPackage(
  packageId: string,
  edit?: (files: Record<string, unknown>) => void,
  options: { courseId?: string; state?: CollectionState } = {},
): Uint8Array {
  const friend = options.state ?? sampleCollection('dev-friend').state;
  const bytes = exportFlashpkg(
    friend,
    options.courseId ? { courseId: options.courseId, packageId } : { deckId: KO, packageId },
  );
  if (!edit) return bytes;
  const zip = unzipSync(bytes);
  const json: Record<string, unknown> = {};
  for (const name of ['manifest.json', 'note_types.json', 'layouts.json', 'courses.json']) {
    const file = zip[name];
    if (file) json[name] = JSON.parse(decodeUtf8(file));
  }
  edit(json);
  for (const [name, value] of Object.entries(json))
    zip[name] = new Uint8Array(encodeUtf8(JSON.stringify(value)));
  return zipSync(zip);
}

function importInto(state: CollectionState, factory: EventFactory, bytes: Uint8Array) {
  const result = importFlashpkg(bytes, state, factory, { nowMs: T0 + 10_000 });
  applyEvents(state, result.events);
  return result;
}

describe('.flashpkg import never overwrites what the user has (D5)', () => {
  it('keeps a layout the user disabled and the note type the user edited', () => {
    const { state, factory } = sampleCollection('dev-me');
    const layout = [...state.layouts.values()].find((l) => l.note_type_id === KO_TYPE);
    const noteType = state.noteTypes.get(KO_TYPE);
    if (!layout || !noteType) throw new Error('sample Korean layout missing');
    const renamed = noteType.fields.map((f, i) => (i === 0 ? { ...f, label: 'My word' } : f));
    applyEvents(state, [
      factory.create('LayoutChanged', { layout: { ...layout, enabled: false } }, T0),
      factory.create('NoteTypeChanged', { note_type: { ...noteType, fields: renamed } }, T0),
    ]);

    const result = importInto(state, factory, friendPackage('pkg:friend'));

    expect(state.layouts.get(layout.id)?.enabled).toBe(false);
    expect(state.noteTypes.get(KO_TYPE)?.fields).toEqual(renamed);
    expect(result.events.filter((e) => e.type === 'LayoutChanged')).toEqual([]);
    expect(result.events.filter((e) => e.type === 'NoteTypeChanged')).toEqual([]);
  });

  it('ignores a hostile package that disables every layout', () => {
    const { state, factory } = sampleCollection('dev-me');
    const enabledBefore = [...state.layouts.values()].filter((l) => l.enabled).map((l) => l.id);
    importInto(
      state,
      factory,
      friendPackage('pkg:hostile', (files) => {
        files['layouts.json'] = (files['layouts.json'] as Array<Record<string, unknown>>).map(
          (l) => ({ ...l, enabled: false }),
        );
      }),
    );
    expect([...state.layouts.values()].filter((l) => l.enabled).map((l) => l.id)).toEqual(
      expect.arrayContaining(enabledBefore),
    );
  });

  it('adds only the fields an existing note type lacks, after the user’s own', () => {
    const { state, factory } = sampleCollection('dev-me');
    const before = state.noteTypes.get(KO_TYPE)?.fields ?? [];
    importInto(
      state,
      factory,
      friendPackage('pkg:friend', (files) => {
        const types = files['note_types.json'] as Array<{ id: string; fields: unknown[] }>;
        const ko = types.find((t) => t.id === KO_TYPE);
        ko?.fields.unshift({ key: 'mnemonic', label: 'Mnemonic', kind: 'text', lang: 'en' });
      }),
    );
    const after = state.noteTypes.get(KO_TYPE)?.fields ?? [];
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((f) => f.key)).toEqual(['mnemonic']);
  });

  it('keeps an existing course', () => {
    const friend = sampleCollection('dev-friend');
    const course = {
      id: 'course-travel',
      name: 'Travel Korean',
      items: [{ kind: 'deck' as const, ref_id: KO }],
    };
    applyEvents(friend.state, [friend.factory.create('CourseChanged', { course }, T0)]);
    const pkg = friendPackage('pkg:friend', undefined, {
      courseId: 'course-travel',
      state: friend.state,
    });

    const { state, factory } = sampleCollection('dev-me');
    const mine = { id: 'course-travel', name: 'My trip', items: [] };
    applyEvents(state, [factory.create('CourseChanged', { course: mine }, T0)]);
    const result = importInto(state, factory, pkg);

    expect(state.courses.get('course-travel')?.name).toBe('My trip');
    expect(result.events.filter((e) => e.type === 'CourseChanged')).toEqual([]);
  });
});

describe('.flashpkg deck matching respects package_id (D6)', () => {
  it('never reuses a deck from no package or another package', () => {
    const { state, factory } = sampleCollection('dev-me');
    const nameBefore = state.decks.get(KO)?.name;
    const sourceBefore = state.decks.get(KO)?.source;
    const notesBefore = [...state.notes.values()].filter((n) => n.deck_id === KO).length;

    const result = importInto(state, factory, friendPackage('pkg:friend'));

    for (const ev of result.events) {
      expect((ev.payload as { deck_id?: string }).deck_id).not.toBe(KO);
    }
    expect(state.decks.get(KO)?.name).toBe(nameBefore);
    expect(state.decks.get(KO)?.source).toEqual(sourceBefore);
    expect([...state.notes.values()].filter((n) => n.deck_id === KO)).toHaveLength(notesBefore);
    expect(result.upgradedDecks).toBe(0);
    expect(state.decks.get(uuidv5('pkg:friend', KO))?.source?.package_id).toBe('pkg:friend');
  });

  it('cannot reach a public deck id through a UUID-shaped package_id', () => {
    // uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab') is KO itself.
    const { state, factory } = sampleCollection('dev-me');
    const sourceBefore = state.decks.get(KO)?.source;
    const result = importInto(
      state,
      factory,
      friendPackage(FLASH_NAMESPACE_UUID, (files) => {
        const manifest = files['manifest.json'] as { decks: Array<{ id: string }> };
        for (const d of manifest.decks) d.id = 'sample-ko-vocab';
      }),
    );
    for (const ev of result.events) {
      expect((ev.payload as { deck_id?: string }).deck_id).not.toBe(KO);
    }
    expect(state.decks.get(KO)?.source).toEqual(sourceBefore);
  });

  it('upgrades the deck on a second import of the same package', () => {
    const { state, factory } = sampleCollection('dev-me');
    const first = importInto(state, factory, friendPackage('pkg:friend'));
    const decksAfterFirst = state.decks.size;
    const second = importInto(state, factory, friendPackage('pkg:friend'));
    expect(first.upgradedDecks).toBe(0);
    expect(second.upgradedDecks).toBe(1);
    expect(state.decks.size).toBe(decksAfterFirst);
  });
});
