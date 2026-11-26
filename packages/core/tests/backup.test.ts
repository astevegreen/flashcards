import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackupArchiveError,
  BACKUP_KEEP_COUNT,
  buildBackupAsync,
  chooseBackupKind,
  FULL_BACKUP_INTERVAL_MS,
  isAutoBackupDue,
  mediaHashesUsedByBackups,
  packBackupAsync,
  packBackupStream,
  parseSyncFolderBackupPath,
  PRE_RESTORE_KEEP_COUNT,
  planBackupRestore,
  readBackupArchive,
  restoreStepsToEvents,
  selectBackupsToPrune,
  syncFolderBackupPath,
  verifyBackupMedia,
  withBackupMediaStream,
  type BackupManifest,
} from '../src/backup/index.ts';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  isCardSuspended,
  type CollectionState,
  type EventFactory,
} from '../src/events/replay.ts';
import type { FlashEvent, KnownEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import type { Note } from '../src/model/types.ts';
import { encodeUtf8 } from '../src/ids.ts';
import { exportFlashpkg, importFlashpkg } from '../src/import/flashpkg.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import { sha256Hex } from '../src/sources/hash.ts';

const DAY = 24 * 60 * 60 * 1000;

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
const T0 = SAMPLE_SEED_EPOCH_MS + 30 * DAY;

function factoryFor(device: string): EventFactory {
  return createEventFactory(device, 0, createHlcState(device, 0));
}

function review(factory: EventFactory, cardId: string, atMs: number, rating: 1 | 3 = 3) {
  return factory.create(
    'ReviewRecorded',
    {
      review_id: `rev-${cardId}-${atMs}`,
      card_id: cardId,
      rating,
      reviewed_at: atMs,
      tz_offset: 540,
      duration_ms: 1200,
      answer_mode: 'flip',
      fsrs_params_version: 0,
      resulting_due_at: atMs + DAY,
    },
    atMs,
  );
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PNG_HASH = sha256Hex(PNG);

/** Sample decks, one image, and a few reviews: the collection as it was at backup time. */
function buildCollection(): {
  events: FlashEvent[];
  state: CollectionState;
  factory: EventFactory;
} {
  const factory = factoryFor('dev-a');
  const events: FlashEvent[] = [...buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS)];
  events.push(
    factory.create(
      'MediaAdded',
      { media: { hash: PNG_HASH, ext: 'png', mime: 'image/png', size: PNG.byteLength } },
      SAMPLE_SEED_EPOCH_MS + 1,
    ),
  );
  const state = applyEvents(createEmptyState(), events);
  const cards = [...state.cards.keys()].slice(0, 4);
  const reviews = cards.map((id, i) => review(factory, id, T0 + i * 1000));
  events.push(...reviews);
  events.push(
    factory.create('CardSuspended', { card_id: cards[3] ?? '', reason: 'manual' }, T0 + 5000),
  );
  applyEvents(state, events.slice(-5));
  return { events, state, factory };
}

/** This device's media, read one file at a time as the packer asks for it. */
const loadPng = (hash: string) => Promise.resolve(hash === PNG_HASH ? PNG : undefined);
const loadNothing = () => Promise.resolve(undefined);

async function packBackupAsyncWith(
  archive: Uint8Array,
  loadMedia: (hash: string) => Promise<Uint8Array | undefined>,
) {
  const chunks: Uint8Array[] = [];
  const { manifest, missingMedia } = await withBackupMediaStream(archive, loadMedia, (chunk) => {
    chunks.push(chunk.slice());
  });
  return { manifest, missingMedia, bytes: join(chunks) };
}

async function backupOf(
  state: CollectionState,
  kind: 'daily' | 'full' = 'daily',
  nowMs = T0 + DAY,
) {
  const built = await buildBackupAsync(state, {
    backupId: `b-${nowMs}`,
    kind,
    reason: 'auto',
    nowMs,
    deviceId: 'dev-a',
    collectionId: 'col-1',
  });
  return packBackupAsync(built, { withMedia: true, loadMedia: loadPng });
}

function activeNotes(state: CollectionState) {
  return [...state.notes.values()]
    .filter((n) => !n.archived)
    .map((n) => ({
      id: n.id,
      // An emptied field is how a restore removes one (field registers stay).
      fields: Object.fromEntries(Object.entries(n.fields).filter(([, v]) => v !== '')),
      tags: n.tags,
      deck: n.deck_id,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function schedules(state: CollectionState) {
  return [...state.cards.values()]
    .map((c) => [c.id, c.schedule.due, c.schedule.reps, isCardSuspended(state, c.id)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function restore(
  current: CollectionState,
  backup: CollectionState,
  factory: EventFactory,
): KnownEvent[] {
  const plan = planBackupRestore(current, backup, { nowMs: T0 + 10 * DAY });
  const events = restoreStepsToEvents(plan.steps, factory, T0 + 10 * DAY);
  applyEvents(current, events);
  return events;
}

describe('backup archive', () => {
  it('round-trips the full state and stays an importable .flashpkg', async () => {
    const { state } = buildCollection();
    const { bytes, manifest } = await backupOf(state);
    expect(manifest.kind).toBe('daily');
    expect(manifest.media_included).toBe(false);
    expect(manifest.media_hashes).toEqual([PNG_HASH]);
    expect(manifest.counts.reviews).toBe(4);

    const read = readBackupArchive(bytes);
    expect(read.manifest.backup_id).toBe(manifest.backup_id);
    expect(read.media.size).toBe(0);
    expect(activeNotes(read.state)).toEqual(activeNotes(state));
    expect(schedules(read.state)).toEqual(schedules(state));

    const imported = importFlashpkg(bytes, createEmptyState(), factoryFor('dev-z'));
    expect(imported.notesImported).toBe(manifest.counts.notes);
  });

  it('packs media only in a full backup, and can add it to a daily one', async () => {
    const { state } = buildCollection();
    const full = await backupOf(state, 'full');
    expect(full.manifest.media_included).toBe(true);
    const read = readBackupArchive(full.bytes);
    const file = read.media.get(PNG_HASH);
    expect(file && verifyBackupMedia(file)).toBe(true);

    const daily = await backupOf(state, 'daily');
    const added = await packBackupAsyncWith(daily.bytes, loadPng);
    expect(added.missingMedia).toBe(0);
    expect(readBackupArchive(added.bytes).media.has(PNG_HASH)).toBe(true);
    expect((await packBackupAsyncWith(daily.bytes, loadNothing)).missingMedia).toBe(1);
  });

  it('rejects a plain .flashpkg and damaged archives', () => {
    const { state } = buildCollection();
    expect(() => readBackupArchive(exportFlashpkg(state))).toThrow(BackupArchiveError);
    expect(() => readBackupArchive(encodeUtf8('not a zip'))).toThrow(BackupArchiveError);
  });
});

describe('backup policy', () => {
  const info = (id: string, created_at: number, extra: Partial<BackupManifest> = {}) => ({
    backup_id: id,
    created_at,
    kind: 'daily' as const,
    media_included: false,
    ...extra,
  });

  it('is due once a day, only when the collection changed, never for an empty one', () => {
    const { state } = buildCollection();
    const total = state.snapshotEventCount + state.appliedEventIds.size;
    expect(isAutoBackupDue([], createEmptyState(), T0)).toBe(false);
    expect(isAutoBackupDue([], state, T0)).toBe(true);
    const recent = [info('a', T0 - 2 * 60 * 60 * 1000, { total_events: 1 })];
    expect(isAutoBackupDue(recent, state, T0)).toBe(false);
    const old = [info('a', T0 - DAY, { total_events: total, collection_id: 'c' })];
    expect(isAutoBackupDue(old, state, T0, 'c')).toBe(false);
    expect(isAutoBackupDue(old, state, T0, 'other')).toBe(true);
    const changed = [info('a', T0 - DAY, { total_events: total - 1, collection_id: 'c' })];
    expect(isAutoBackupDue(changed, state, T0, 'c')).toBe(true);
  });

  it('ignores snapshots stamped in the future by a wrong clock, without churning', () => {
    const { state } = buildCollection();
    const total = state.snapshotEventCount + state.appliedEventIds.size;
    const future = info('future', T0 + 30 * DAY, { total_events: 0 });
    // The future one never counts as "newest", so a snapshot is due now...
    expect(isAutoBackupDue([future], state, T0)).toBe(true);
    // ...and once a sane one exists, the hourly checks are quiet again.
    const sane = info('sane', T0, { total_events: total });
    for (let hour = 1; hour < 20; hour++) {
      expect(isAutoBackupDue([future, sane], state, T0 + hour * 60 * 60 * 1000)).toBe(false);
    }
    // Future-stamped snapshots were taken earlier in real time: they go first when pruning.
    const daily = Array.from({ length: BACKUP_KEEP_COUNT }, (_, i) => info(`d${i}`, T0 - i * DAY));
    expect(selectBackupsToPrune([future, ...daily], { nowMs: T0 })).toEqual(['future']);
  });

  it('keeps pre-restore snapshots apart and never prunes the backup being restored', () => {
    const daily = Array.from({ length: BACKUP_KEEP_COUNT }, (_, i) => info(`d${i}`, T0 - i * DAY));
    const pre = Array.from({ length: PRE_RESTORE_KEEP_COUNT + 2 }, (_, i) =>
      info(`p${i}`, T0 + 1000 - i, { reason: 'pre-restore' }),
    );
    const pruned = selectBackupsToPrune([...daily, ...pre], { nowMs: T0 + 2000 });
    // The rolling 14 are untouched; only the oldest pre-restore snapshots go.
    expect(pruned).toEqual(['p3', 'p4']);
    const oldest = `d${BACKUP_KEEP_COUNT - 1}`;
    const withNew = [...daily, info('new', T0 + 5000)];
    expect(selectBackupsToPrune(withNew, { nowMs: T0 + 5000 })).toEqual([oldest]);
    expect(selectBackupsToPrune(withNew, { nowMs: T0 + 5000, protect: [oldest] })).toEqual([]);
  });

  it('takes a full snapshot weekly unless the media is too large', () => {
    expect(chooseBackupKind([], 0, T0)).toBe('daily');
    expect(chooseBackupKind([], 1000, T0)).toBe('full');
    expect(chooseBackupKind([], 500 * 1024 * 1024, T0)).toBe('daily');
    const fullYesterday = [info('f', T0 - DAY, { kind: 'full', media_included: true })];
    expect(chooseBackupKind(fullYesterday, 1000, T0)).toBe('daily');
    expect(chooseBackupKind(fullYesterday, 1000, T0 + FULL_BACKUP_INTERVAL_MS)).toBe('full');
  });

  it('keeps the newest 14 plus the newest full snapshot', () => {
    const list = Array.from({ length: 20 }, (_, i) =>
      info(`d${i}`, T0 - i * DAY, i === 16 ? { kind: 'full', media_included: true } : {}),
    );
    const pruned = selectBackupsToPrune(list, { nowMs: T0 });
    expect(pruned).toHaveLength(20 - BACKUP_KEEP_COUNT - 1);
    expect(pruned).not.toContain('d16');
    expect(pruned).not.toContain('d0');
    expect(pruned).toContain('d19');
  });

  it('lists the media hashes kept snapshots use', () => {
    const used = mediaHashesUsedByBackups([
      info('a', 1, { media_hashes: ['AA'.repeat(32)] }),
      info('b', 2, { media_hashes: ['bb'.repeat(32)] }),
    ]);
    expect([...used].sort()).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
  });

  it('writes one sync-folder slot per weekday and parses it back', () => {
    const path = syncFolderBackupPath('web-abc', Date.UTC(2026, 10, 23));
    expect(path).toBe('backups/v1/web-abc/day-1.flashpkg');
    expect(parseSyncFolderBackupPath(path)).toEqual({ deviceId: 'web-abc', day: 1 });
    expect(parseSyncFolderBackupPath('backups/v1/../day-1.flashpkg')).toBeNull();
    expect(parseSyncFolderBackupPath('sync/v1/manifest.json')).toBeNull();
    expect(() => syncFolderBackupPath('a/b', 0)).toThrow();
  });
});

function noteUpsertOf(note: Note) {
  return {
    note_id: note.id,
    deck_id: note.deck_id,
    source_key: note.source_key,
    fields: note.fields,
    tags: note.tags,
  };
}

describe('backup archive validation and async packing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('packs the same snapshot off the UI thread, media stored uncompressed', async () => {
    const { state } = buildCollection();
    const options = {
      backupId: 'b-async',
      kind: 'full' as const,
      reason: 'auto' as const,
      nowMs: T0,
      deviceId: 'dev-a',
    };
    let pauses = 0;
    const built = await buildBackupAsync(state, options, async () => {
      pauses += 1;
    });
    expect(pauses).toBeGreaterThan(0);
    const packed = await packBackupAsync(built, { withMedia: true, loadMedia: loadPng });
    const read = readBackupArchive(packed.bytes);
    expect(read.manifest.media_included).toBe(true);
    expect(read.media.get(PNG_HASH)?.bytes).toEqual(PNG);
    expect(activeNotes(read.state)).toEqual(activeNotes(state));
  });

  it('packs a state.json far over 160 KB without a worker or an object URL (CSP)', async () => {
    const { state, factory } = buildCollection();
    const cards = [...state.cards.keys()];
    const reviews: KnownEvent[] = [];
    for (let i = 0; i < 40; i++) {
      for (const card_id of cards) {
        reviews.push(
          factory.create(
            'ReviewRecorded',
            {
              review_id: `r-${i}-${card_id}`,
              card_id,
              rating: 3,
              reviewed_at: T0 + i * DAY,
              tz_offset: 0,
              duration_ms: 1500,
              answer_mode: 'flip',
              fsrs_params_version: 0,
              resulting_due_at: T0 + (i + 3) * DAY,
            },
            T0 + i * DAY,
          ),
        );
      }
    }
    applyEvents(state, reviews);
    // fflate's async zip would start a `blob:` worker here, which `worker-src 'self'` refuses.
    const workers = vi.fn(() => {
      throw new Error('no workers');
    });
    vi.stubGlobal('Worker', workers);
    const objectUrls = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('no object URLs');
    });
    const built = await buildBackupAsync(state, {
      backupId: 'b-large',
      kind: 'full',
      reason: 'auto',
      nowMs: T0,
      deviceId: 'dev-a',
    });
    expect(built.entries['backup/state.json']?.byteLength).toBeGreaterThan(160 * 1024);
    let pauses = 0;
    const packed = await packBackupAsync(
      built,
      { withMedia: true, loadMedia: loadPng },
      async () => {
        pauses += 1;
      },
    );
    expect(workers).not.toHaveBeenCalled();
    expect(objectUrls).not.toHaveBeenCalled();
    expect(pauses).toBeGreaterThan(1);
    const read = readBackupArchive(packed.bytes);
    expect(read.state.reviewsByCard.size).toBe(state.reviewsByCard.size);
    expect(read.media.get(PNG_HASH)?.bytes).toEqual(PNG);
  });

  it('streams the archive to a slow sink, waiting for each write before packing more', async () => {
    const { state } = buildCollection();
    const built = await buildBackupAsync(state, {
      backupId: 'b-stream',
      kind: 'full',
      reason: 'manual',
      nowMs: T0,
      deviceId: 'dev-a',
    });
    const chunks: Uint8Array[] = [];
    let inFlight = 0;
    let maxInFlightAtPause = 0;
    let loads = 0;
    const { manifest } = await packBackupStream(
      built,
      {
        withMedia: true,
        loadMedia: (hash) => {
          loads += 1;
          return loadPng(hash);
        },
      },
      (chunk) => {
        inFlight += 1;
        chunks.push(chunk.slice());
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            inFlight -= 1;
            resolve();
          }, 1),
        );
      },
      async () => {
        maxInFlightAtPause = Math.max(maxInFlightAtPause, inFlight);
      },
    );
    expect(inFlight).toBe(0);
    expect(maxInFlightAtPause).toBe(0);
    expect(manifest.media_included).toBe(true);
    // Media is read one file at a time while the archive is written, never up front.
    expect(loads).toBe(1);
    const read = readBackupArchive(join(chunks));
    expect(read.media.get(PNG_HASH)?.bytes).toEqual(PNG);
    expect(activeNotes(read.state)).toEqual(activeNotes(state));
    // Same contents as the one-array packer.
    const whole = readBackupArchive(
      (await packBackupAsync(built, { withMedia: true, loadMedia: loadPng })).bytes,
    );
    expect(activeNotes(whole.state)).toEqual(activeNotes(read.state));
  });

  it('streams a daily snapshot with the media from this device added', async () => {
    const { state } = buildCollection();
    const built = await buildBackupAsync(state, {
      backupId: 'b-daily',
      kind: 'daily',
      reason: 'auto',
      nowMs: T0,
      deviceId: 'dev-a',
    });
    const daily = (await packBackupAsync(built, { withMedia: false })).bytes;
    const chunks: Uint8Array[] = [];
    const streamed = await withBackupMediaStream(daily, loadPng, async (chunk) => {
      chunks.push(chunk.slice());
    });
    expect(streamed.manifest.media_included).toBe(true);
    expect(streamed.missingMedia).toBe(0);
    const read = readBackupArchive(join(chunks));
    expect(read.manifest.media_included).toBe(true);
    expect(read.media.get(PNG_HASH)?.bytes).toEqual(PNG);
    await expect(
      withBackupMediaStream(daily, loadPng, () => Promise.reject(new Error('disk full'))),
    ).rejects.toThrow('disk full');
  });

  it('rejects a malformed state.json before any of it becomes an event', async () => {
    const { state } = buildCollection();
    const tamper = async (edit: (raw: Record<string, unknown>) => void) => {
      const built = await buildBackupAsync(state, {
        backupId: 'b-bad',
        kind: 'daily',
        reason: 'auto',
        nowMs: T0,
        deviceId: 'dev-a',
      });
      const raw = JSON.parse(
        new TextDecoder().decode(built.entries['backup/state.json']),
      ) as Record<string, unknown>;
      edit(raw);
      built.entries['backup/state.json'] = encodeUtf8(JSON.stringify(raw));
      const { bytes } = await packBackupAsync(built, { withMedia: false });
      return () => readBackupArchive(bytes);
    };
    const notes = (raw: Record<string, unknown>) => raw['notes'] as Record<string, unknown>[];
    const firstReviews = (raw: Record<string, unknown>) =>
      Object.values(raw['reviewsByCard'] as Record<string, Record<string, unknown>[]>)[0] ?? [];
    expect(
      await tamper((raw) => {
        const n = notes(raw)[0];
        if (n) n['fields'] = { front: 42 };
      }),
    ).toThrow(BackupArchiveError);
    expect(
      await tamper((raw) => {
        const r = firstReviews(raw)[0];
        if (r) r['rating'] = 9;
      }),
    ).toThrow(/rating/);
    expect(
      await tamper((raw) => {
        const r = firstReviews(raw)[0];
        if (r) r['reviewed_at'] = null;
      }),
    ).toThrow(BackupArchiveError);
    expect(
      await tamper((raw) => {
        raw['decks'] = 'nope';
      }),
    ).toThrow(BackupArchiveError);
    // The untouched archive still reads.
    expect(await tamper(() => undefined)).not.toThrow();
  });
});

describe('backup restore', () => {
  it('rebuilds the whole collection on an empty device', async () => {
    const { state } = buildCollection();
    const read = readBackupArchive((await backupOf(state)).bytes);
    const fresh = createEmptyState();
    restore(fresh, read.state, factoryFor('dev-new'));
    expect(activeNotes(fresh)).toEqual(activeNotes(state));
    expect(schedules(fresh)).toEqual(schedules(state));
    expect(fresh.media.has(PNG_HASH)).toBe(true);
    // Nothing is left to do: the plan is a fixed point.
    expect(planBackupRestore(fresh, read.state).steps).toHaveLength(0);
  });

  it('undoes a bad import, a deletion and an edit, and keeps newer reviews', async () => {
    const { state, factory } = buildCollection();
    const read = readBackupArchive((await backupOf(state)).bytes);
    const notes = [...state.notes.values()];
    const victim = notes[0];
    const edited = notes[1];
    const deck = [...state.decks.values()][0];
    if (!victim || !edited || !deck) throw new Error('sample data changed');
    const deckName = deck.name;

    const later = T0 + 2 * DAY;
    const damage: KnownEvent[] = [
      factory.create('NoteArchived', { note_id: victim.id }, later),
      factory.create(
        'NoteUpserted',
        {
          note_id: edited.id,
          deck_id: edited.deck_id,
          source_key: edited.source_key,
          fields: { ...edited.fields, junk: 'x' },
          tags: ['oops'],
        },
        later,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: 'imported-1',
          deck_id: deck.id,
          source_key: 'imported-1',
          fields: { front: 'bad import' },
        },
        later,
      ),
      factory.create('DeckSettingsChanged', { deck_id: deck.id, name: 'Renamed' }, later),
    ];
    applyEvents(state, damage);
    const newerCard = [...state.cards.keys()].find((id) => !state.reviewsByCard.has(id)) ?? '';
    applyEvents(state, [review(factory, newerCard, later + 1000)]);

    const plan = planBackupRestore(state, read.state);
    expect(plan.summary.notesRestored).toBe(1);
    expect(plan.summary.notesChanged).toBe(1);
    expect(plan.summary.notesArchived).toBe(1);
    expect(plan.summary.decksChanged).toBe(1);
    expect(plan.summary.reviewsKept).toBe(1);

    const kept = structuredClone(state);
    restore(kept, read.state, factory);
    expect(activeNotes(kept)).toEqual(activeNotes(read.state));
    expect(kept.notes.get(edited.id)?.fields['junk']).toBe('');
    expect(kept.decks.get(deck.id)?.name).toBe(deckName);
    expect(kept.reviewsByCard.get(newerCard)?.length).toBe(1);
    expect(kept.undoneReviewIds.size).toBe(state.undoneReviewIds.size);
    expect(planBackupRestore(kept, read.state).steps).toHaveLength(0);
  });

  it('brings a leech suspension back as a leech one', async () => {
    const { state, factory } = buildCollection();
    const card = [...state.cards.values()][5];
    const note = card ? state.notes.get(card.note_id) : undefined;
    if (!card || !note) throw new Error('sample data changed');
    applyEvents(state, [
      factory.create('NoteTagsAdded', { note_id: note.id, tags: ['leech'], reason: 'leech' }, T0),
      factory.create('CardSuspended', { card_id: card.id, reason: 'leech' }, T0),
    ]);
    const read = readBackupArchive((await backupOf(state)).bytes);
    applyEvents(state, [factory.create('CardUnsuspended', { card_id: card.id }, T0 + DAY)]);
    const step = planBackupRestore(state, read.state).steps.find((s) => s.type === 'CardSuspended');
    expect(step?.payload).toEqual({ card_id: card.id, reason: 'leech' });
  });

  it('restores while another device edits offline: both converge, the offline edit survives', async () => {
    const { events, state, factory } = buildCollection();
    const read = readBackupArchive((await backupOf(state)).bytes);
    const note = [...state.notes.values()][3];
    if (!note) throw new Error('sample data changed');
    const b = factoryFor('dev-b');
    const deviceB = applyEvents(createEmptyState(), events);
    // Device B edits offline before the restore; device A has not seen it.
    const offlineEdit = b.create(
      'NoteUpserted',
      { ...noteUpsertOf(note), fields: { ...note.fields, extra: 'offline' } },
      T0 + 3 * DAY,
    );
    applyEvents(deviceB, [offlineEdit]);
    const restoreEvents = restore(state, read.state, factory);
    applyEvents(state, [offlineEdit]);
    applyEvents(deviceB, restoreEvents);
    expect(activeNotes(deviceB)).toEqual(activeNotes(state));
    expect(state.notes.get(note.id)?.fields['extra']).toBe('offline');
  });

  it('converges: a device that never saw the damage ends in the same state', async () => {
    const { events, state, factory } = buildCollection();
    const read = readBackupArchive((await backupOf(state)).bytes);
    const victim = [...state.notes.values()][2];
    if (!victim) throw new Error('sample data changed');
    const damage = [factory.create('NoteArchived', { note_id: victim.id }, T0 + 2 * DAY)];
    applyEvents(state, damage);
    const restoreEvents = restore(state, read.state, factory);

    // Device B gets the restore before the damage (out of order); the HLCs decide.
    const other = applyEvents(createEmptyState(), events);
    applyEvents(other, restoreEvents);
    applyEvents(other, damage);
    expect(activeNotes(other)).toEqual(activeNotes(state));
    expect(schedules(other)).toEqual(schedules(state));
  });
});
