import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  getDeckDescription,
  type CollectionState,
  type EventFactory,
  type KnownEvent,
} from '../src/index.ts';
import { deriveNoteId } from '../src/ids.ts';
import {
  buildStarterDeckEvents,
  findStarterDeck,
  loadStarterDeck,
  STARTER_DECKS,
  STARTER_SEED_EPOCH_MS,
  starterDeckId,
  type StarterDeckContent,
  type StarterDeckInfo,
} from '../src/starters/index.ts';
import {
  buildStarterDeckUpgradeEvents,
  legacyStarterFields,
  loadStarterLegacyGlosses,
  planStarterDeckUpgrade,
  STARTER_UPGRADE_TARGET,
  starterDeckVersion,
  starterDecksDueForUpgrade,
  type LegacyStarterVersion,
} from '../src/starters/upgrade.ts';

/**
 * `contentHash` of each older release, from the catalog committed with it (1.0.0: 40a6a79,
 * Phase 14; 1.1.0: 03ec0fe, PR #28): sha256 of the JSON of its `{ key, fields, tags }` notes.
 * Matching them proves the upgrade rebuilds every older value exactly, not just a sample.
 */
const RELEASE_HASHES: Record<string, Record<LegacyStarterVersion, string>> = {
  'starter-ko-core': {
    '1.0.0': '58bd853d525abe03c1bec52fe82ffd50ebca33d13b840c94486ac5c4001419a0',
    '1.1.0': 'ad426ef9a1bb5410ada98073604bdbb8ce735920e8d5444e8ff5ccdb10bb3daa',
  },
  'starter-zh-common': {
    '1.0.0': '26a08bc5ecbd38a13d3f5cd439d3fa8ff43f9daffb56963ffc05fe637cd6e6bc',
    '1.1.0': 'bd074cc957f5558757a6ea74a6de2a89a185e07f912f2d3ac3364c786273495a',
  },
};

/** The deck descriptions before 1.2.0 (no Credits line). */
const OLD_DESCRIPTIONS: Record<string, string> = {
  'starter-ko-core':
    'Beginner (level A) Korean words from the NIKL learning vocabulary list, most frequent first, with Hanja for Sino-Korean words and English meanings from Wikidata.',
  'starter-zh-common':
    'The most frequent characters of modern Mandarin, with pinyin and English definitions from the Unicode Unihan database.',
};

/** The value, or a test failure naming what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

let wall = STARTER_SEED_EPOCH_MS;
/** A device's event factory; every device shares one advancing clock, so HLCs order like time. */
const device = (id: string) => createEventFactory(id, 0, createHlcState(id, STARTER_SEED_EPOCH_MS));
const tick = () => (wall += 60_000);

async function deck(slug: string) {
  const info = findStarterDeck(slug);
  if (!info) throw new Error(`missing ${slug}`);
  return { info, content: await loadStarterDeck(slug), legacy: await loadStarterLegacyGlosses() };
}

/** What a device seeded at onboarding when the app shipped `version` of the starter decks. */
async function legacySeed(
  factory: EventFactory,
  slug: string,
  version: LegacyStarterVersion,
): Promise<KnownEvent[]> {
  const { info, content, legacy } = await deck(slug);
  const old: StarterDeckContent = {
    slug,
    notes: content.notes.map((n) => {
      const fields = legacyStarterFields(slug, n, legacy, version);
      if (!fields) throw new Error(`no ${version} fields for ${n.key}`);
      return { key: n.key, fields, tags: n.tags, meaningSource: n.meaningSource };
    }),
  };
  const oldInfo: StarterDeckInfo = {
    ...info,
    version,
    contentHash: must(RELEASE_HASHES[slug], slug)[version],
    description: must(OLD_DESCRIPTIONS[slug], slug),
  };
  return buildStarterDeckEvents(factory, oldInfo, old);
}

function replay(...logs: KnownEvent[][]): CollectionState {
  return applyEvents(createEmptyState(), logs.flat());
}

function edit(
  factory: EventFactory,
  state: CollectionState,
  slug: string,
  key: string,
  fields: Record<string, string>,
): KnownEvent {
  const note = state.notes.get(deriveNoteId(starterDeckId(slug), key));
  if (!note) throw new Error(`missing note ${key}`);
  return factory.create(
    'NoteUpserted',
    { note_id: note.id, deck_id: note.deck_id, source_key: note.source_key, fields },
    tick(),
  );
}

/** Runs the upgrade for every due deck, as the app does at launch. */
async function upgrade(factory: EventFactory, state: CollectionState): Promise<KnownEvent[]> {
  const events: KnownEvent[] = [];
  for (const info of starterDecksDueForUpgrade(state)) {
    const { content, legacy } = await deck(info.slug);
    const plan = planStarterDeckUpgrade(state, info, content, legacy);
    if (plan) events.push(...buildStarterDeckUpgradeEvents(factory, plan, tick()));
  }
  return events;
}

function noteFields(state: CollectionState, slug: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const note of state.notes.values()) {
    if (note.deck_id === starterDeckId(slug)) out[note.source_key] = { ...note.fields };
  }
  return out;
}

const SLUGS = STARTER_DECKS.map((d) => d.slug);

describe('older starter releases are rebuilt exactly', () => {
  it.each(SLUGS.flatMap((slug) => (['1.0.0', '1.1.0'] as const).map((v) => [slug, v] as const)))(
    '%s %s: the rebuilt notes hash to that release’s catalog contentHash',
    async (slug, version) => {
      const { content, legacy } = await deck(slug);
      const notes = content.notes.map((n) => ({
        key: n.key,
        fields: legacyStarterFields(slug, n, legacy, version),
        tags: n.tags,
      }));
      const hash = createHash('sha256').update(JSON.stringify(notes)).digest('hex');
      expect(hash).toBe(must(RELEASE_HASHES[slug], slug)[version]);
    },
  );

  it('matches the documented credit formats', async () => {
    const ko = await deck('starter-ko-core');
    const zh = await deck('starter-zh-common');
    const find = (c: StarterDeckContent, key: string) =>
      must(
        c.notes.find((n) => n.key === key),
        key,
      );
    const geot = find(ko.content, 'nikl:것01:dependent-noun');
    expect(legacyStarterFields(ko.info.slug, geot, ko.legacy, '1.0.0')?.['notes']).toBe(
      'Word list: NIKL 한국어 학습용 어휘 목록 (2003), KOGL Type 1. English: Wikidata L196 (CC0).',
    );
    const de = find(zh.content, 'unihan:U+7684');
    expect(legacyStarterFields(zh.info.slug, de, zh.legacy, '1.1.0')?.['notes']).toBe(
      'Also read: dì, dí. Source: Unicode Unihan 17.0.0 (kHanyuPinlu, kMandarin, kDefinition), Unicode License v3; meaning edited by this app.',
    );
    const na = find(ko.content, 'nikl:나03:pronoun');
    expect(legacyStarterFields(ko.info.slug, na, ko.legacy, '1.0.0')?.['meaning']).toBe(
      'informal first person singular, I',
    );
  });
});

describe('starter-deck upgrade', () => {
  it.each(SLUGS)('%s: an untouched 1.0.0 deck becomes the current release', async (slug) => {
    const { info, content } = await deck(slug);
    const seed = await legacySeed(device('dev-a'), slug, '1.0.0');
    const state = replay(seed);
    expect(starterDecksDueForUpgrade(state).map((d) => d.slug)).toEqual([slug]);

    const events = await upgrade(device('dev-a'), state);
    applyEvents(state, events);

    const expected = Object.fromEntries(content.notes.map((n) => [n.key, n.fields]));
    expect(noteFields(state, slug)).toEqual(expected);
    // The release is recorded beside the deck; its source register is left as seeded.
    expect(starterDeckVersion(state, info)).toBe(info.version);
    expect(state.decks.get(starterDeckId(slug))?.source).toMatchObject({
      kind: 'native',
      package_id: `flash-starter:${slug}`,
      package_version: '1.0.0',
    });
    expect(events.some((e) => e.type === 'SourceLinked')).toBe(false);
    expect(getDeckDescription(state, starterDeckId(slug))).toBe(info.description);
    // Only changed fields travel (never the front, reading or tags), and never the note's deck.
    for (const ev of events) {
      if (ev.type !== 'NoteUpserted') continue;
      expect(Object.keys(ev.payload.fields).every((f) => f === 'meaning' || f === 'notes')).toBe(
        true,
      );
      expect(ev.payload.tags).toBeUndefined();
      expect(ev.payload.fields_only).toBe(true);
    }
  });

  it('a 1.1.0 deck only loses its credits: its meanings are already current', async () => {
    const seed = await legacySeed(device('dev-a'), 'starter-ko-core', '1.1.0');
    const state = replay(seed);
    const events = await upgrade(device('dev-a'), state);
    const notes = events.filter((e) => e.type === 'NoteUpserted');
    expect(notes).toHaveLength(145);
    for (const ev of notes) expect(ev.payload).toMatchObject({ fields: { notes: '' } });
    expect(notes.every((e) => !('meaning' in e.payload.fields))).toBe(true);
  });

  it('leaves every field the user edited as it is, and still upgrades the rest', async () => {
    const slug = 'starter-ko-core';
    const { content } = await deck(slug);
    const user = device('dev-a');
    const seed = await legacySeed(user, slug, '1.0.0');
    const before = replay(seed);
    const edits = [
      // 나: a reworded note; the user's own Notes and an untouched 1.0.0 meaning.
      edit(user, before, slug, 'nikl:나03:pronoun', { notes: 'My mnemonic' }),
      // 사람: the user changed the meaning but left the credit.
      edit(user, before, slug, 'nikl:사람:noun', { meaning: 'human being' }),
      // 것: a credit with a trailing space is no longer the generated text.
      edit(user, before, slug, 'nikl:것01:dependent-noun', {
        notes:
          'Word list: NIKL 한국어 학습용 어휘 목록 (2003), KOGL Type 1. English: Wikidata L196 (CC0). ',
      }),
    ];
    const state = replay(seed, edits);
    applyEvents(state, await upgrade(user, state));
    const fields = noteFields(state, slug);
    const current = (key: string) =>
      must(
        content.notes.find((n) => n.key === key),
        key,
      ).fields;

    expect(fields['nikl:나03:pronoun']).toMatchObject({
      notes: 'My mnemonic',
      meaning: current('nikl:나03:pronoun')['meaning'],
    });
    expect(fields['nikl:사람:noun']).toMatchObject({ meaning: 'human being', notes: '' });
    expect(fields['nikl:것01:dependent-noun']?.['notes']).toMatch(/\(CC0\)\. $/);
    expect(fields['nikl:하다01:verb']).toEqual(current('nikl:하다01:verb'));
  });

  it('keeps a moved note in the deck the user moved it to', async () => {
    const slug = 'starter-zh-common';
    const user = device('dev-a');
    const seed = await legacySeed(user, slug, '1.0.0');
    const before = replay(seed);
    const note = must(before.notes.get(deriveNoteId(starterDeckId(slug), 'unihan:U+4E00')), 'note');
    const move = user.create(
      'NoteUpserted',
      { note_id: note.id, deck_id: 'my-deck', source_key: note.source_key, fields: {} },
      tick(),
    );
    const state = replay(seed, [move]);
    applyEvents(state, await upgrade(user, state));
    expect(state.notes.get(note.id)).toMatchObject({ deck_id: 'my-deck', fields: { notes: '' } });
  });

  it('is idempotent: a second run, or a relaunch that replays the log, writes nothing', async () => {
    const factory = device('dev-a');
    const seed = [
      ...(await legacySeed(factory, 'starter-ko-core', '1.0.0')),
      ...(await legacySeed(factory, 'starter-zh-common', '1.1.0')),
    ];
    const state = replay(seed);
    const first = await upgrade(factory, state);
    applyEvents(state, first);
    expect(starterDecksDueForUpgrade(state)).toEqual([]);
    expect(await upgrade(factory, state)).toEqual([]);

    const relaunched = replay(seed, first);
    expect(await upgrade(device('dev-a'), relaunched)).toEqual([]);
    for (const slug of SLUGS) expect(noteFields(relaunched, slug)).toEqual(noteFields(state, slug));
  });

  it('does not run on a deck from a newer release, or on a deck that is not a starter', async () => {
    const { info, content, legacy } = await deck('starter-ko-core');
    const newer = buildStarterDeckEvents(
      device('dev-a'),
      { ...info, version: '9.0.0' },
      { slug: info.slug, notes: content.notes },
    );
    const state = replay(newer);
    expect(starterDecksDueForUpgrade(state)).toEqual([]);
    expect(planStarterDeckUpgrade(state, info, content, legacy)).toBeUndefined();
    expect(planStarterDeckUpgrade(createEmptyState(), info, content, legacy)).toBeUndefined();
  });

  it('two devices that both upgrade before syncing converge, with their other edits merged', async () => {
    const slug = 'starter-ko-core';
    const { content } = await deck(slug);
    const a = device('dev-a');
    const b = device('dev-b');
    const seed = await legacySeed(a, slug, '1.0.0');

    // Device A upgrades. Device B, offline, upgrades too and then edits a note's example.
    const stateA = replay(seed);
    const upA = await upgrade(a, stateA);
    applyEvents(stateA, upA);
    const stateB = replay(seed);
    const upB = await upgrade(b, stateB);
    applyEvents(stateB, upB);
    const exampleB = edit(b, stateB, slug, 'nikl:하다01:verb', { example: '숙제를 해요.' });
    // Device A, after its upgrade, edits another note's notes.
    const notesA = edit(a, stateA, slug, 'nikl:되다01:verb', { notes: 'irregular' });

    const merged1 = replay(seed, upA, [notesA], upB, [exampleB]);
    const merged2 = replay(seed, [exampleB], upB, [notesA], upA);
    expect(noteFields(merged1, slug)).toEqual(noteFields(merged2, slug));

    const fields = noteFields(merged1, slug);
    const expected = Object.fromEntries(content.notes.map((n) => [n.key, { ...n.fields }]));
    must(expected['nikl:하다01:verb'], '하다')['example'] = '숙제를 해요.';
    must(expected['nikl:되다01:verb'], '되다')['notes'] = 'irregular';
    expect(fields).toEqual(expected);
    expect(await upgrade(a, merged1)).toEqual([]);
    expect(await upgrade(b, merged2)).toEqual([]);
  });

  it('a note another device moved before the upgrade synced stays moved, in any order', async () => {
    const slug = 'starter-zh-common';
    const a = device('dev-a');
    const b = device('dev-b');
    const seed = await legacySeed(a, slug, '1.0.0');
    const id = deriveNoteId(starterDeckId(slug), 'unihan:U+4E00');
    const note = must(replay(seed).notes.get(id), 'note');
    // B moves the note (offline); A upgrades later, before B's move reaches it.
    const moveB = b.create(
      'NoteUpserted',
      { note_id: id, deck_id: 'deck-b', source_key: note.source_key, fields: {} },
      tick(),
    );
    const upA = await upgrade(a, replay(seed));
    for (const merged of [replay(seed, [moveB], upA), replay(seed, upA, [moveB])]) {
      expect(merged.notes.get(id)).toMatchObject({ deck_id: 'deck-b', fields: { notes: '' } });
      expect(merged.noteIdsByDeck.get('deck-b')?.has(id)).toBe(true);
    }
    // Even when the upgrade reaches a device before the note itself does.
    const early = replay(upA, seed, [moveB]);
    expect(early.notes.get(id)).toMatchObject({ deck_id: 'deck-b', fields: { notes: '' } });
  });

  it('a deck another device unlinked before the upgrade synced stays unlinked', async () => {
    const slug = 'starter-ko-core';
    const { info, content } = await deck(slug);
    const a = device('dev-a');
    const b = device('dev-b');
    const seed = await legacySeed(a, slug, '1.0.0');
    const unlinkB = b.create(
      'SourceUnlinked',
      { target_kind: 'deck', target_id: starterDeckId(slug) },
      tick(),
    );
    const upA = await upgrade(a, replay(seed));
    for (const merged of [replay(seed, [unlinkB], upA), replay(seed, upA, [unlinkB])]) {
      expect(merged.decks.get(starterDeckId(slug))?.source).toBeUndefined();
      expect(noteFields(merged, slug)).toEqual(
        Object.fromEntries(content.notes.map((n) => [n.key, n.fields])),
      );
      expect(starterDeckVersion(merged, info)).toBeUndefined();
      expect(await upgrade(b, merged)).toEqual([]);
    }
  });

  it('never writes a description over one the user wrote or cleared', async () => {
    const slug = 'starter-ko-core';
    const deckId = starterDeckId(slug);
    for (const text of ['My Korean deck', '']) {
      const user = device('dev-a');
      const seed = await legacySeed(user, slug, '1.0.0');
      const own = user.create(
        'DeckDescriptionChanged',
        { deck_id: deckId, description: text },
        tick(),
      );
      const state = replay(seed, [own]);
      const events = await upgrade(user, state);
      expect(events.some((e) => e.type === 'DeckDescriptionChanged')).toBe(false);
      expect(events.some((e) => e.type === 'NoteUpserted')).toBe(true);
      applyEvents(state, events);
      expect(getDeckDescription(state, deckId)).toBe(text);
    }
  });

  it('a later release it has no older values for gets no upgrade, not a stale stamp', async () => {
    const { info, content, legacy } = await deck('starter-ko-core');
    const state = replay(await legacySeed(device('dev-a'), info.slug, '1.0.0'));
    const later = { ...info, version: '1.3.0' };
    expect(planStarterDeckUpgrade(state, later, content, legacy)).toBeUndefined();
    expect(starterDeckVersion(state, info)).toBe('1.0.0');
  });

  it('knows the older values of the catalog release (bump STARTER_UPGRADE_TARGET with them)', () => {
    for (const info of STARTER_DECKS) expect(info.version).toBe(STARTER_UPGRADE_TARGET);
  });

  it('a device that syncs the first device’s upgrade first does not run it again', async () => {
    const a = device('dev-a');
    const seed = await legacySeed(a, 'starter-zh-common', '1.0.0');
    const upA = await upgrade(a, replay(seed));
    expect(upA.length).toBeGreaterThan(1);
    expect(await upgrade(device('dev-b'), replay(seed, upA))).toEqual([]);
  });
});
