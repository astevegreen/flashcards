import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyEvents, createEmptyState, createEventFactory, createHlcState } from '../src/index.ts';
import { BUILTIN_NOTE_TYPES } from '../src/model/presets.ts';
import {
  buildStarterDeckEvents,
  findStarterDeck,
  loadStarterDeck,
  STARTER_DECKS,
  STARTER_SEED_EPOCH_MS,
  starterDeckId,
} from '../src/starters/index.ts';
import { sampleDeckId, SAMPLE_DECKS } from '../src/samples/decks.ts';

const factory = (device: string) =>
  createEventFactory(device, 0, createHlcState(device, STARTER_SEED_EPOCH_MS));

describe('curated starter decks (generated data)', () => {
  it('lists small, attributed decks with unique slugs that never collide with sample decks', () => {
    expect(STARTER_DECKS.length).toBeGreaterThan(0);
    const slugs = STARTER_DECKS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const sampleIds = new Set(SAMPLE_DECKS.map((d) => sampleDeckId(d.slug)));
    for (const deck of STARTER_DECKS) {
      expect(deck.noteCount).toBeGreaterThanOrEqual(100);
      expect(deck.noteCount).toBeLessThanOrEqual(200);
      expect(sampleIds.has(starterDeckId(deck.slug))).toBe(false);
      expect(BUILTIN_NOTE_TYPES.some((nt) => nt.id === deck.noteTypeId)).toBe(true);
      expect(deck.sources.length).toBeGreaterThan(0);
      for (const source of deck.sources) {
        expect(source.licence).not.toBe('');
        expect(source.attribution).not.toBe('');
        expect(source.licenceUrl).toMatch(/^https:\/\//);
        expect(source.sourceUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it.each(STARTER_DECKS.map((d) => [d.slug]))(
    '%s: content matches its catalog entry and validates',
    async (slug) => {
      const info = findStarterDeck(slug);
      if (!info) throw new Error(`missing ${slug}`);
      const content = await loadStarterDeck(slug);
      expect(content.notes.length).toBe(info.noteCount);
      const hash = createHash('sha256').update(JSON.stringify(content.notes)).digest('hex');
      expect(hash).toBe(info.contentHash);

      const noteType = BUILTIN_NOTE_TYPES.find((nt) => nt.id === info.noteTypeId);
      const fieldKeys = new Set(noteType?.fields.map((f) => f.key));
      const keys = new Set<string>();
      for (const note of content.notes) {
        expect(keys.has(note.key)).toBe(false);
        keys.add(note.key);
        expect(note.fields['word']).toBeTruthy();
        expect(note.fields['meaning']).toBeTruthy();
        // Plain text only (§13): nothing that could be read as markup.
        for (const [key, value] of Object.entries(note.fields)) {
          expect(fieldKeys.has(key)).toBe(true);
          expect(value).not.toMatch(/[<>]/);
        }
      }
    },
  );

  it('rejects an unknown starter deck', async () => {
    await expect(loadStarterDeck('starter-xx-none')).rejects.toThrow('Unknown starter deck');
  });
});

describe('seeding a starter deck', () => {
  it('creates exactly that deck, with deterministic ids, and re-seeding never duplicates it', async () => {
    const info = STARTER_DECKS[0];
    if (!info) throw new Error('no starter decks');
    const content = await loadStarterDeck(info.slug);

    const first = buildStarterDeckEvents(factory('dev-a'), info, content);
    const second = buildStarterDeckEvents(factory('dev-b'), info, content);
    const state = applyEvents(applyEvents(createEmptyState(), first), second);

    expect([...state.decks.keys()]).toEqual([starterDeckId(info.slug)]);
    expect(state.notes.size).toBe(info.noteCount);
    const deck = state.decks.get(starterDeckId(info.slug));
    expect(deck?.name).toBe(info.name);
    expect(deck?.language).toBe(info.language);
    expect(deck?.source).toMatchObject({
      kind: 'package',
      package_id: `flash-starter:${info.slug}`,
      package_version: info.version,
      content_hash: info.contentHash,
      uri: info.sources[0]?.sourceUrl,
    });
    const noteIds = (events: typeof first) =>
      events.flatMap((e) => (e.type === 'NoteUpserted' ? [e.payload.note_id] : []));
    expect(noteIds(second)).toEqual(noteIds(first));
    for (const note of state.notes.values()) {
      expect(note.provenance).toEqual({ source: 'import', reviewed: true });
    }
  });
});
