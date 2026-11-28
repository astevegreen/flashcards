import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  getDeckDescription,
  isKnownEventType,
  type CollectionState,
  type EventFactory,
  type KnownEvent,
} from '../src/index.ts';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import { createHlcState as hlcAt } from '../src/hlc.ts';
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

/**
 * Applies each log in its own `applyEvents` call, in the order given, as a device receives them.
 * (One call sorts its batch by HLC, so it can't show what a late or early delivery does.)
 */
function replayInTurn(...logs: KnownEvent[][]): CollectionState {
  const state = createEmptyState();
  for (const log of logs) applyEvents(state, log);
  return state;
}

/** Every order of `logs`, each applied in turn. */
function everyOrder(logs: KnownEvent[][]): KnownEvent[][][] {
  if (logs.length <= 1) return [logs];
  return logs.flatMap((log, i) =>
    everyOrder([...logs.slice(0, i), ...logs.slice(i + 1)]).map((rest) => [log, ...rest]),
  );
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

describe('legacySeed stays what older builds wrote', () => {
  /**
   * A frozen digest of what `legacySeed` produces for each older release: the deck events, the
   * first notes in full, and a sha256 over every note's payload. A later change to the seeding
   * code (or to `legacyStarterFields`) that alters an old deck's text shows up here instead of
   * silently moving the upgrade tests' baseline. Refresh deliberately with `vitest -u`.
   */
  it('matches the committed 1.0.0 and 1.1.0 seeds', async () => {
    const digest: Record<string, unknown> = {};
    for (const slug of SLUGS) {
      for (const version of ['1.0.0', '1.1.0'] as const) {
        const events = await legacySeed(device('dev-a'), slug, version);
        const notes = events.filter((e) => e.type === 'NoteUpserted').map((e) => e.payload);
        digest[`${slug}@${version}`] = {
          deck: events.find((e) => e.type === 'DeckCreated')?.payload,
          description: events.find((e) => e.type === 'DeckDescriptionChanged')?.payload,
          noteCount: notes.length,
          firstNotes: notes.slice(0, 3),
          notesSha256: createHash('sha256').update(JSON.stringify(notes)).digest('hex'),
        };
      }
    }
    await expect(`${JSON.stringify(digest, null, 2)}\n`).toMatchFileSnapshot(
      './__golden__/starter-legacy-seeds.json.snap',
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
    // Only changed fields travel (never the front, reading or tags), and never the note's deck:
    // the note fields go in `StarterNoteUpgraded`, never in a `NoteUpserted`.
    expect(events.some((e) => e.type === 'NoteUpserted')).toBe(false);
    for (const ev of events) {
      if (ev.type !== 'StarterNoteUpgraded') continue;
      expect(Object.keys(ev.payload.fields).every((f) => f === 'meaning' || f === 'notes')).toBe(
        true,
      );
      expect(Object.keys(ev.payload)).toEqual(['note_id', 'fields']);
    }
  });

  it('a 1.1.0 deck only loses its credits: its meanings are already current', async () => {
    const seed = await legacySeed(device('dev-a'), 'starter-ko-core', '1.1.0');
    const state = replay(seed);
    const events = await upgrade(device('dev-a'), state);
    const notes = events.flatMap((e) => (e.type === 'StarterNoteUpgraded' ? [e.payload] : []));
    expect(notes).toHaveLength(145);
    for (const p of notes) expect(p).toMatchObject({ fields: { notes: { value: '' } } });
    expect(notes.every((p) => !('meaning' in p.fields))).toBe(true);
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

    const merged1 = replayInTurn(seed, upA, [notesA], upB, [exampleB]);
    const merged2 = replayInTurn(seed, [exampleB], upB, [notesA], upA);
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
    // Every delivery order, each log applied on its own: the upgrade before or after the move,
    // and before the note itself exists (the fields-only create path).
    const orders = everyOrder([seed, [moveB], upA]);
    expect(orders).toHaveLength(6);
    for (const order of orders) {
      const merged = replayInTurn(...order);
      expect(merged.notes.get(id)).toMatchObject({ deck_id: 'deck-b', fields: { notes: '' } });
      expect(merged.noteIdsByDeck.get('deck-b')?.has(id)).toBe(true);
      expect(merged.noteIdsByDeck.get(starterDeckId(slug))?.has(id)).toBe(false);
    }
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
    for (const merged of [replayInTurn(seed, [unlinkB], upA), replayInTurn(seed, upA, [unlinkB])]) {
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
      expect(events.some((e) => e.type === 'StarterNoteUpgraded')).toBe(true);
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

  it('records the release in a log-retained event that older builds keep verbatim', async () => {
    const factory = device('dev-a');
    const state = replay(await legacySeed(factory, 'starter-ko-core', '1.0.0'));
    const events = await upgrade(factory, state);
    const marker = events.at(-1);
    expect(marker?.type).toBe('StarterDeckUpgraded');
    // Not a type replay applies: every build (older ones too) keeps it in `unknownEvents`.
    expect(isKnownEventType('StarterDeckUpgraded')).toBe(false);
    applyEvents(state, events);
    expect(state.unknownEvents.map((e) => e.id)).toContain(marker?.id);
  });

  it('a device that syncs the first device’s upgrade first does not run it again', async () => {
    const a = device('dev-a');
    const seed = await legacySeed(a, 'starter-zh-common', '1.0.0');
    const upA = await upgrade(a, replay(seed));
    expect(upA.length).toBeGreaterThan(1);
    expect(await upgrade(device('dev-b'), replay(seed, upA))).toEqual([]);
  });
});

/**
 * The starter-upgrade race (#83): a user edits a field that still holds the old starter text on a
 * device that has not synced the upgrade yet. The edit must win over the upgrade for that field,
 * whichever HLC is later and in whichever order the events arrive.
 */
describe('starter-deck upgrade vs an unsynced edit', () => {
  const slug = 'starter-ko-core';
  // 사람: its 1.0.0 meaning was reworded, and its Notes held the credit, so both fields upgrade.
  const KEY = 'nikl:사람:noun';
  const OTHER = 'nikl:나03:pronoun';
  const current = async (key: string) =>
    must((await deck(slug)).content.notes.find((n) => n.key === key)?.fields, key);

  /** A 1.0.0 deck seeded on A and synced to B, an edit B makes offline, and A's upgrade. */
  async function race(editFirst: boolean) {
    const a = device('dev-a');
    const b = device('dev-b');
    const seed = await legacySeed(a, slug, '1.0.0');
    const before = replay(seed);
    const fields = { notes: 'My mnemonic', meaning: 'a person, a human' };
    // A upgrades without having seen B's edit; which of the two has the later HLC varies.
    let editB: KnownEvent;
    let upA: KnownEvent[];
    if (editFirst) {
      editB = edit(b, before, slug, KEY, fields);
      upA = await upgrade(a, replay(seed));
    } else {
      upA = await upgrade(a, replay(seed));
      editB = edit(b, before, slug, KEY, fields);
    }
    return { seed, upA, editB, fields };
  }

  it.each([
    ['the edit has the earlier HLC', true],
    ['the edit has the later HLC', false],
  ])('%s: the edit wins in every delivery order, the rest upgrades', async (_name, editFirst) => {
    const { seed, upA, editB, fields } = await race(editFirst);
    const expected = { ...(await current(KEY)), ...fields };
    const other = await current(OTHER);
    const orders = everyOrder([seed, [editB], upA]);
    expect(orders).toHaveLength(6);
    for (const merged of [...orders.map((o) => replayInTurn(...o)), replay(seed, [editB], upA)]) {
      expect(noteFields(merged, slug)[KEY]).toEqual(expected);
      expect(noteFields(merged, slug)[OTHER]).toEqual(other);
      expect(starterDecksDueForUpgrade(merged)).toEqual([]);
    }
  });

  it('an edit made after the upgrade synced wins too, even back to the old text', async () => {
    const a = device('dev-a');
    const seed = await legacySeed(a, slug, '1.0.0');
    const oldNotes = must(noteFields(replay(seed), slug)[KEY]?.['notes'], 'old notes');
    const upA = await upgrade(a, replay(seed));
    const synced = replay(seed, upA);
    expect(noteFields(synced, slug)[KEY]).toEqual(await current(KEY));
    const revert = edit(device('dev-b'), synced, slug, KEY, { notes: oldNotes });
    const expected = { ...(await current(KEY)), notes: oldNotes };
    for (const order of everyOrder([seed, upA, [revert]])) {
      expect(noteFields(replayInTurn(...order), slug)[KEY]).toEqual(expected);
    }
  });

  it('a snapshot keeps the order: a late unsynced edit still wins after hydration', async () => {
    const { seed, upA, editB, fields } = await race(true);
    const hydrated = deserializeCollectionState(serializeCollectionState(replay(seed, upA)));
    expect(noteFields(hydrated, slug)[KEY]).toEqual(await current(KEY));
    applyEvents(hydrated, [editB]);
    expect(noteFields(hydrated, slug)[KEY]).toEqual({ ...(await current(KEY)), ...fields });
  });

  it('reaches the main thread through a worker patch, then loses to the late edit', async () => {
    const { seed, upA, editB, fields } = await race(true);
    const worker = replay(seed);
    const main = replay(seed);
    mergeStatePatch(main, computeStatePatch(worker, upA));
    expect(serializeCollectionState(main)).toEqual(serializeCollectionState(replay(seed, upA)));
    mergeStatePatch(main, computeStatePatch(worker, [editB]));
    expect(noteFields(main, slug)[KEY]).toEqual({ ...(await current(KEY)), ...fields });
    expect(serializeCollectionState(main)).toEqual(serializeCollectionState(worker));
  });

  it('hydrating an older build’s snapshot (event kept, old text shown) shows the upgrade', async () => {
    const a = device('dev-a');
    const seed = await legacySeed(a, slug, '1.0.0');
    const upA = await upgrade(a, replay(seed));
    const full = replay(seed, upA);
    // An older build keeps `StarterNoteUpgraded` in `unknownEvents` but never applies it.
    const snapshot = serializeCollectionState(full);
    const oldNotes = new Map(serializeCollectionState(replay(seed)).notes.map((n) => [n.id, n]));
    snapshot.notes = snapshot.notes.map((n) => must(oldNotes.get(n.id), n.id));
    expect(snapshot.unknownEvents.some((e) => e.type === 'StarterNoteUpgraded')).toBe(true);
    const hydrated = deserializeCollectionState(snapshot);
    expect(noteFields(hydrated, slug)).toEqual(noteFields(full, slug));
  });

  it('property: unsynced edits always win, at any HLC and in any delivery order', async () => {
    const { content, legacy } = await deck(slug);
    const keys = [KEY, OTHER, 'nikl:것01:dependent-noun'];
    const a = createEventFactory('dev-a', 0, hlcAt('dev-a', STARTER_SEED_EPOCH_MS));
    const seed = await legacySeed(a, slug, '1.0.0');
    const before = replay(seed);
    const old = noteFields(before, slug);
    const upgradeAt = STARTER_SEED_EPOCH_MS + 10 * 60_000;
    const upA: KnownEvent[] = [];
    for (const info of starterDecksDueForUpgrade(before)) {
      const plan = must(planStarterDeckUpgrade(before, info, content, legacy), 'plan');
      upA.push(...buildStarterDeckUpgradeEvents(a, plan, upgradeAt));
    }
    const target = Object.fromEntries(content.notes.map((n) => [n.key, { ...n.fields }]));

    const editArb = fc.record({
      key: fc.constantFrom(...keys),
      field: fc.constantFrom('notes', 'meaning'),
      // The user's own text, an emptied field, or (concurrently) exactly the old starter text.
      value: fc.constantFrom('mine', '', 'OLD'),
      // Minutes after the seed; the upgrade is at minute 10.
      minute: fc.integer({ min: 1, max: 20 }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(editArb, { minLength: 1, maxLength: 4, selector: (e) => e.minute }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (edits, shuffleSeed) => {
          const b = createEventFactory('dev-b', 0, hlcAt('dev-b', STARTER_SEED_EPOCH_MS));
          const expected = structuredClone(target);
          const editEvents = [...edits]
            .sort((x, y) => x.minute - y.minute)
            .map((e) => {
              const note = must(before.notes.get(deriveNoteId(starterDeckId(slug), e.key)), e.key);
              const value = e.value === 'OLD' ? must(old[e.key]?.[e.field], e.field) : e.value;
              must(expected[e.key], e.key)[e.field] = value;
              return b.create(
                'NoteUpserted',
                {
                  note_id: note.id,
                  deck_id: note.deck_id,
                  source_key: note.source_key,
                  fields: { [e.field]: value },
                },
                STARTER_SEED_EPOCH_MS + e.minute * 60_000,
              );
            });
          // A seeded shuffle of the chunks a device receives, each applied in its own call.
          const chunks: KnownEvent[][] = [seed, upA, ...editEvents.map((e) => [e])];
          let r = shuffleSeed;
          for (let i = chunks.length - 1; i > 0; i -= 1) {
            r = (r * 1_103_515_245 + 12_345) % 2_147_483_648;
            const j = r % (i + 1);
            [chunks[i], chunks[j]] = [must(chunks[j], 'chunk'), must(chunks[i], 'chunk')];
          }
          expect(noteFields(replayInTurn(...chunks), slug)).toEqual(expected);
          expect(noteFields(replay(seed, upA, editEvents), slug)).toEqual(expected);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('starter-deck upgrade vs another device’s seed (HLC tie)', () => {
  const slug = 'starter-ko-core';
  const KEY = 'nikl:사람:noun';
  /** A fresh install's factory, as the app builds it (HLC at 0), so its seed stamps the epoch. */
  const fresh = (id: string) => createEventFactory(id, 0, createHlcState(id, 0));
  const upgradeAt = STARTER_SEED_EPOCH_MS + 10 * 60_000;

  /** The upgrade `factory` writes having seen only `seen`. */
  async function upgradeSeeing(factory: EventFactory, seen: KnownEvent[]): Promise<KnownEvent[]> {
    const { content, legacy } = await deck(slug);
    const state = replay(seen);
    const events: KnownEvent[] = [];
    for (const info of starterDecksDueForUpgrade(state)) {
      const plan = must(planStarterDeckUpgrade(state, info, content, legacy), 'plan');
      events.push(...buildStarterDeckUpgradeEvents(factory, plan, upgradeAt));
    }
    return events;
  }

  /** A and B both seed a 1.0.0 deck at onboarding before syncing; A upgrades before B's seed. */
  async function tie() {
    const a = fresh('dev-a');
    const b = fresh('dev-b');
    const seedA = await legacySeed(a, slug, '1.0.0');
    const seedB = await legacySeed(b, slug, '1.0.0');
    const upA = await upgradeSeeing(a, seedA);
    return { seedA, seedB, upA };
  }

  const target = async () =>
    Object.fromEntries((await deck(slug)).content.notes.map((n) => [n.key, { ...n.fields }]));

  it('the seeds tie on HLC except for the node id, and B’s holds the register', async () => {
    const { seedA, seedB } = await tie();
    const id = deriveNoteId(starterDeckId(slug), KEY);
    const register = (state: CollectionState) => state.fieldHlcs.get(`note:${id}:field:notes`);
    const hlcA = must(register(replay(seedA)), 'A register');
    const hlcB = must(register(replay(seedA, seedB)), 'merged register');
    expect(hlcB).toBe(register(replay(seedB)));
    expect(hlcA.replace(/dev-a$/u, 'dev-b')).toBe(hlcB);
  });

  it('A’s upgrade shows over B’s later seed of the old text, in every delivery order', async () => {
    const { seedA, seedB, upA } = await tie();
    const expected = await target();
    const orders = everyOrder([seedA, seedB, upA]);
    for (const merged of [...orders.map((o) => replayInTurn(...o)), replay(seedA, seedB, upA)]) {
      expect(noteFields(merged, slug)).toEqual(expected);
      expect(starterDecksDueForUpgrade(merged)).toEqual([]);
    }
  });

  it('a snapshot keeps it: B’s seed after hydration, and an older build’s snapshot', async () => {
    const { seedA, seedB, upA } = await tie();
    const expected = await target();
    const hydrated = deserializeCollectionState(serializeCollectionState(replay(seedA, upA)));
    applyEvents(hydrated, seedB);
    expect(noteFields(hydrated, slug)).toEqual(expected);

    const full = replay(seedA, seedB, upA);
    expect(noteFields(deserializeCollectionState(serializeCollectionState(full)), slug)).toEqual(
      expected,
    );
    // An older build keeps `StarterNoteUpgraded` in `unknownEvents` but shows the old text.
    const snapshot = serializeCollectionState(full);
    const oldNotes = new Map(
      serializeCollectionState(replay(seedA, seedB)).notes.map((n) => [n.id, n]),
    );
    snapshot.notes = snapshot.notes.map((n) => must(oldNotes.get(n.id), n.id));
    expect(noteFields(deserializeCollectionState(snapshot), slug)).toEqual(expected);
  });

  it('property: seeds never hide an upgrade, unsynced edits still win, in any order', async () => {
    const expectedBase = await target();
    const before = replay(await legacySeed(fresh('dev-x'), slug, '1.0.0'));
    const old = noteFields(before, slug);
    const keys = [KEY, 'nikl:나03:pronoun', 'nikl:것01:dependent-noun'];
    const ids = ['dev-0', 'dev-a', 'dev-m', 'dev-z'];
    const editArb = fc.record({
      key: fc.constantFrom(...keys),
      field: fc.constantFrom('notes', 'meaning'),
      value: fc.constantFrom('mine', '', 'OLD'),
      minute: fc.integer({ min: 1, max: 20 }),
    });
    await fc.assert(
      fc.asyncProperty(
        // Devices that seed before syncing, and which of them upgrade (each seeing only its seed).
        fc.subarray(ids, { minLength: 2 }),
        fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }),
        fc.uniqueArray(editArb, { maxLength: 3, selector: (e) => e.minute }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (seeders, upgrades, edits, shuffleSeed) => {
          const chunks: KnownEvent[][] = [];
          const ups: KnownEvent[] = [];
          for (const [i, id] of seeders.entries()) {
            const factory = fresh(id);
            const seed = await legacySeed(factory, slug, '1.0.0');
            chunks.push(seed);
            if (i === 0 || upgrades[i] === true) ups.push(...(await upgradeSeeing(factory, seed)));
          }
          chunks.push(ups);
          // Offline edits on another device that no upgrading device has seen.
          const editor = fresh('dev-e');
          const expected = structuredClone(expectedBase);
          const editEvents = [...edits]
            .sort((x, y) => x.minute - y.minute)
            .map((e) => {
              const note = must(before.notes.get(deriveNoteId(starterDeckId(slug), e.key)), e.key);
              const value = e.value === 'OLD' ? must(old[e.key]?.[e.field], e.field) : e.value;
              must(expected[e.key], e.key)[e.field] = value;
              return editor.create(
                'NoteUpserted',
                {
                  note_id: note.id,
                  deck_id: note.deck_id,
                  source_key: note.source_key,
                  fields: { [e.field]: value },
                },
                STARTER_SEED_EPOCH_MS + e.minute * 60_000,
              );
            });
          chunks.push(...editEvents.map((e) => [e]));
          let r = shuffleSeed;
          for (let i = chunks.length - 1; i > 0; i -= 1) {
            r = (r * 1_103_515_245 + 12_345) % 2_147_483_648;
            const j = r % (i + 1);
            [chunks[i], chunks[j]] = [must(chunks[j], 'chunk'), must(chunks[i], 'chunk')];
          }
          const inTurn = replayInTurn(...chunks);
          expect(noteFields(inTurn, slug)).toEqual(expected);
          expect(noteFields(replay(...chunks), slug)).toEqual(expected);
          const hydrated = deserializeCollectionState(serializeCollectionState(inTurn));
          expect(noteFields(hydrated, slug)).toEqual(expected);
        },
      ),
      { numRuns: 25 },
    );
  });
});
