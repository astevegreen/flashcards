import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  isCardSuspended,
  stripRuby,
  type CollectionState,
} from '@flash/core';
import { importAnkiPackage, unzipApkg, ANKI_IMPORT_LIMITS } from '@flash/core/anki';
import { planAnkiApkgExport, writeApkg } from '@flash/core/anki-export';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  buildAnkiExportState,
  buildAnkiHistoryState,
  CLOZE_DECK,
  HISTORY_NOW,
  MP3,
  MP3_HASH,
  PNG,
  PNG_HASH,
  T0,
  VOCAB_DECK,
} from '../../core/tests/helpers/anki-export-state.ts';
import { readApkg } from '../src/anki/apkg-reader.ts';
import {
  handleAnkiWriteRequest,
  WebAnkiCollectionWriter,
  writeAnkiCollection,
  type AnkiWriterWorkerLike,
  type AnkiWriteResponse,
} from '../src/anki/apkg-writer.ts';
import { zstdDecompressCapped } from '../src/anki/zstd.ts';

const sqlite = initSqlJs();
const NOW = T0 + 60_000;
const MEDIA = new Map([
  [PNG_HASH, PNG],
  [MP3_HASH, MP3],
]);

async function exportApkg(state: CollectionState, deckIds?: string[], nowMs = NOW) {
  const SQL = await sqlite;
  const plan = planAnkiApkgExport(state, { nowMs, ...(deckIds ? { deckIds } : {}) });
  const collection = writeAnkiCollection(new SQL.Database(), plan.collection);
  const chunks: Uint8Array[] = [];
  const written = await writeApkg(
    collection,
    plan,
    async (hash) => MEDIA.get(hash),
    (chunk) => chunks.push(chunk.slice()),
  );
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { plan, collection, apkg: { ...written, bytes } };
}

/** Exports, reads the package back with the importer's reader, and imports it. */
async function roundTrip(state: CollectionState, nowMs = NOW) {
  const SQL = await sqlite;
  const exported = await exportApkg(state, undefined, nowMs);
  const raw = await readApkg(
    exported.apkg.bytes,
    {
      openDatabase: async (b) => new SQL.Database(b),
      zstdDecompress: zstdDecompressCapped,
    },
    { includeReviewHistory: true },
  );
  const target = createEmptyState();
  const factory = createEventFactory('dev-b', 0, createHlcState('dev-b', nowMs));
  const result = importAnkiPackage(raw, target, factory, { nowMs, includeReviewHistory: true });
  applyEvents(target, result.events);
  return { ...exported, raw, target, result };
}

function notesIn(state: CollectionState, deckName: string) {
  const deck = [...state.decks.values()].find((d) => d.name === deckName);
  if (!deck) throw new Error(`no deck ${deckName}`);
  const notes = [...state.notes.values()]
    .filter((n) => n.deck_id === deck.id)
    .sort((a, b) => a.created_order - b.created_order);
  return { deck, notes };
}

function textValues(fields: Record<string, string>): string[] {
  return Object.values(fields).filter((v) => !v.startsWith('media:'));
}

describe('.apkg export (legacy collection.anki2 + media map)', () => {
  it('writes collection.anki2 and the JSON media map, nothing newer', async () => {
    const { apkg } = await exportApkg(buildAnkiExportState());
    const files = unzipApkg(apkg.bytes, ANKI_IMPORT_LIMITS);
    expect([...files.keys()].sort()).toEqual(['0', '1', 'collection.anki2', 'media']);
    const map = JSON.parse(new TextDecoder().decode(files.get('media'))) as Record<string, string>;
    expect(Object.values(map).sort()).toEqual([`${MP3_HASH}.mp3`, `${PNG_HASH}.png`].sort());
    expect(apkg.mediaCount).toBe(2);
    expect(apkg.missingMediaCount).toBe(1); // note 3's image isn't in the media list
  });

  it('round-trips notes, fields, ruby, media, tags and GUIDs through the Anki importer', async () => {
    const { target, result, plan } = await roundTrip(buildAnkiExportState());
    expect(plan.deckCount).toBe(2);
    expect(plan.noteCount).toBe(4); // the archived note stays out
    expect(result.summary.notes).toBe(4);
    expect(result.summary.media).toBe(2);

    const vocab = notesIn(target, 'Japanese::Vocab');
    expect(vocab.notes).toHaveLength(3);
    const [n1, n2, n3] = vocab.notes;
    const word1 = n1?.fields['word'] ?? '';
    expect(stripRuby(word1)).toBe('日本語を食べる');
    expect(stripRuby(word1, 'readings')).toBe('にほんごをたべる');
    expect(textValues(n1?.fields ?? {})).toContain('Japanese, "quoted" <b>');
    expect(textValues(n1?.fields ?? {})).toContain('line one\nline two');
    expect(Object.values(n1?.fields ?? {})).toEqual(
      expect.arrayContaining([`media:${PNG_HASH}`, `media:${MP3_HASH}`]),
    );
    expect(n1?.tags).toEqual(['jlpt_n5', 'grammar::verbs']);
    // Literal brackets stay text; the explicit ruby keeps its reading.
    expect(stripRuby(n2?.fields['word'] ?? '')).toBe('test[abc] & 今日');
    expect(stripRuby(n2?.fields['word'] ?? '', 'readings')).toBe('test[abc] & きょう');
    expect(n2?.source_key).toBe('anki:AbC123guid');
    expect(n1?.source_key).toBe('anki:note-1');
    expect(stripRuby(n3?.fields['word'] ?? '')).toBe('学校');

    const cloze = notesIn(target, 'Japanese Cloze');
    expect(cloze.notes).toHaveLength(1);
    expect(stripRuby(cloze.notes[0]?.fields['text'] ?? '')).toBe(
      // `晴れ[はれ]` isn't ruby in this app (the strict form needs an all-Han base): it stays text.
      '{{c1::今日::today}}は{{c2::晴れ[はれ]}}です',
    );
  });

  it('keeps layouts: furigana hidden on the front, typed answers, cloze cards, suspension', async () => {
    const source = buildAnkiExportState();
    const { target } = await roundTrip(source);
    const vocab = notesIn(target, 'Japanese::Vocab');
    const layouts = [...target.layouts.values()].filter(
      (l) => l.note_type_id === vocab.deck.note_type_id,
    );
    const recognition = layouts.find((l) => l.name === 'Recognition');
    const production = layouts.find((l) => l.name === 'Production');
    expect(recognition?.answer_mode).toBe('flip');
    expect(recognition?.hide_furigana_on_front).toBe(true);
    expect(production?.answer_mode).toBe('typed');

    const cardsOf = (noteId: string) =>
      [...(target.cardIdsByNote.get(noteId) ?? [])].map((id) => target.cards.get(id));
    const first = vocab.notes[0];
    expect(cardsOf(first?.id ?? '')).toHaveLength(2);
    const suspended = cardsOf(first?.id ?? '').filter((c) => c && isCardSuspended(target, c.id));
    expect(suspended.map((c) => c?.layout_id)).toEqual([production?.id]);

    const clozeNote = notesIn(target, 'Japanese Cloze').notes[0];
    const clozeLayout = [...target.layouts.values()].find(
      (l) => l.note_type_id === notesIn(target, 'Japanese Cloze').deck.note_type_id,
    );
    expect(clozeLayout?.answer_mode).toBe('cloze');
    expect(
      cardsOf(clozeNote?.id ?? '')
        .map((c) => c?.variant)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('writes revlog and card scheduling that read back from SQLite and import with history', async () => {
    const source = buildAnkiHistoryState();
    const { collection, target, result } = await roundTrip(source, HISTORY_NOW);
    const SQL = await sqlite;
    const db = new SQL.Database(collection);
    try {
      const revlog = db.exec('SELECT id, usn, ease, type FROM revlog ORDER BY id')[0]?.values ?? [];
      expect(revlog).toHaveLength(10);
      expect(new Set(revlog.map((r) => r[0])).size).toBe(10);
      expect(revlog.map((r) => r[3]).filter((t) => t === 2)).toHaveLength(1);
      const queues = db.exec('SELECT queue, count(*) FROM cards GROUP BY queue ORDER BY queue')[0];
      // suspended 1, new 3 (note-3 ×2, cloze c2), learning/relearning 3, review 1.
      expect(queues?.values).toEqual([
        [-1, 1],
        [0, 3],
        [1, 3],
        [2, 1],
      ]);
      const data = db.exec('SELECT data FROM cards WHERE type = 2 AND queue = 2')[0]?.values[0];
      expect(Object.keys(JSON.parse(String(data?.[0])))).toEqual(['s', 'd', 'dr', 'decay', 'lrt']);
    } finally {
      db.close();
    }
    expect(result.summary.reviews).toBe(10);
    // Replaying the imported history gives the same FSRS state as the source collection.
    const memory = (state: CollectionState) =>
      [...state.cards.values()]
        .filter((c) => c.schedule.reps > 0)
        .map((c) => [
          c.schedule.state,
          c.schedule.reps,
          c.schedule.lapses,
          c.schedule.stability.toFixed(3),
          c.schedule.difficulty.toFixed(3),
        ])
        .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    expect(memory(target)).toEqual(memory(source));
  });

  it('writes Anki templates with furigana, type, cloze and the schema-11 tables', async () => {
    const { collection } = await exportApkg(buildAnkiExportState(), [VOCAB_DECK, CLOZE_DECK]);
    const SQL = await sqlite;
    const db = new SQL.Database(collection);
    try {
      const col = db.exec('SELECT ver, models, decks FROM col')[0]?.values[0] ?? [];
      expect(col[0]).toBe(11);
      const models = Object.values(JSON.parse(String(col[1]))) as Array<{
        name: string;
        type: number;
        tmpls: Array<{ name: string; qfmt: string; afmt: string }>;
      }>;
      const vocab = models.find((m) => m.name === 'Japanese Vocab');
      const recognition = vocab?.tmpls.find((t) => t.name === 'Recognition');
      expect(recognition?.qfmt).toBe('{{kanji:Word}}');
      expect(recognition?.afmt).toContain('{{FrontSide}}');
      expect(recognition?.afmt).toContain('{{Meaning}}');
      const production = vocab?.tmpls.find((t) => t.name === 'Production');
      expect(production?.qfmt).toContain('{{type:Word}}');
      const cloze = models.find((m) => m.name === 'Japanese Cloze');
      expect(cloze?.type).toBe(1);
      expect(cloze?.tmpls[0]?.qfmt).toBe('{{furigana:cloze:Text}}');
      const decks = Object.values(JSON.parse(String(col[2]))) as Array<{ name: string }>;
      expect(decks.map((d) => d.name).sort()).toEqual(
        ['Default', 'Japanese', 'Japanese Cloze', 'Japanese::Vocab'].sort(),
      );
      const csum = db.exec("SELECT csum FROM notes WHERE guid = 'note-1'")[0]?.values[0]?.[0];
      // SHA-1 of the stripped first field, first 32 bits (what Anki computes).
      expect(typeof csum).toBe('number');
      const indexes = db.exec("SELECT name FROM sqlite_master WHERE type = 'index'")[0]?.values;
      expect(indexes?.map((r) => r[0])).toContain('ix_notes_csum');
    } finally {
      db.close();
    }
  });

  it('WebAnkiCollectionWriter writes in a worker and terminates it', async () => {
    const SQL = await sqlite;
    let terminated = 0;
    const fakeWorker = (): AnkiWriterWorkerLike => {
      const w: AnkiWriterWorkerLike = {
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage: (msg) => {
          void handleAnkiWriteRequest(
            msg,
            async () => new SQL.Database(),
            (res) => w.onmessage?.({ data: res } as MessageEvent<AnkiWriteResponse>),
          );
        },
        terminate: () => {
          terminated += 1;
        },
      };
      return w;
    };
    const writer = new WebAnkiCollectionWriter({ createWorker: fakeWorker });
    const plan = planAnkiApkgExport(buildAnkiExportState(), { nowMs: NOW });
    const bytes = await writer.write(plan.collection);
    expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe('SQLite format 3');
    expect(terminated).toBe(1);
    const posts: AnkiWriteResponse[] = [];
    await handleAnkiWriteRequest(
      { type: 'nope' },
      async () => new SQL.Database(),
      (m) => posts.push(m),
    );
    expect(posts[0]?.type).toBe('error');
  });

  it('WebAnkiCollectionWriter rejects and terminates on worker failure, bad answers and timeouts', async () => {
    const plan = planAnkiApkgExport(buildAnkiExportState(), { nowMs: NOW });
    const run = async (onPost: (w: AnkiWriterWorkerLike) => void, timeoutMs = 1000) => {
      let terminated = 0;
      const w: AnkiWriterWorkerLike = {
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage: () => queueMicrotask(() => onPost(w)),
        terminate: () => {
          terminated += 1;
        },
      };
      const writer = new WebAnkiCollectionWriter({ createWorker: () => w, timeoutMs });
      const error = await writer.write(plan.collection).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      return { error, terminated, handlers: [w.onmessage, w.onerror, w.onmessageerror] };
    };
    const failed = await run((w) => w.onerror?.({ message: 'boom' } as ErrorEvent));
    expect(failed.error).toBe('boom');
    const unreadable = await run((w) => w.onmessageerror?.({} as MessageEvent));
    expect(unreadable.error).toContain('unreadable');
    const silent = await run(() => {}, 20);
    expect(silent.error).toContain('too long');
    const answered = await run((w) =>
      w.onmessage?.({
        data: { type: 'error', message: 'disk full' },
      } as MessageEvent<AnkiWriteResponse>),
    );
    expect(answered.error).toBe('disk full');
    for (const r of [failed, unreadable, silent, answered]) {
      expect(r.terminated).toBe(1);
      expect(r.handlers).toEqual([null, null, null]);
    }
  });
});
