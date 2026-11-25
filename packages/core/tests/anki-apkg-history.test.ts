import { describe, expect, it } from 'vitest';
import {
  applyEvents,
  createEventFactory,
  replaySingleCard,
  type CollectionState,
} from '../src/events/replay.ts';
import { planAnkiApkgExport, type AnkiApkgPlan } from '../src/export/anki/index.ts';
import { createHlcState } from '../src/hlc.ts';
import {
  buildAnkiExportState,
  buildAnkiHistoryState,
  CLOZE_DECK,
  HISTORY_NOW,
  HISTORY_T,
  LEARNING_CARD,
  RELEARNED_CARD,
  VOCAB_DECK,
} from './helpers/anki-export-state.ts';

const DAY = 86_400_000;

/** One Easy review (straight to review) on note 1's flip card, at `at` in offset `tz`. */
function oneReviewState(at: number, tz: number): CollectionState {
  const state = buildAnkiExportState();
  const f = createEventFactory('dev-z', 0, createHlcState('dev-z', at));
  applyEvents(state, [
    f.create(
      'ReviewRecorded',
      {
        review_id: 'rev-tz',
        card_id: LEARNING_CARD,
        rating: 4,
        reviewed_at: at,
        tz_offset: tz,
        duration_ms: 1000,
        answer_mode: 'flip',
        fsrs_params_version: 0,
        resulting_due_at: at,
      },
      at,
    ),
  ]);
  return state;
}

/** Anki's day count for `nowMs` (rslib `timing.rs`): whole days since `crt`. */
function ankiToday(p: AnkiApkgPlan, nowMs: number): number {
  return Math.floor((nowMs / 1000 - Number(table(p, 'col')[0]?.['crt'])) / 86_400);
}

const CARD_COLUMNS = ['id', 'nid', 'ord', 'type', 'queue', 'due', 'ivl', 'factor'] as const;

function table(plan: AnkiApkgPlan, name: string) {
  const t = plan.collection.tables.find((x) => x.name === name);
  if (!t) throw new Error(`no ${name} table`);
  return t.rows.map((row) => Object.fromEntries(t.columns.map((c, i) => [c, row[i]])));
}

function plan(options: { includeReviewHistory?: boolean } = {}) {
  return planAnkiApkgExport(buildAnkiHistoryState(), {
    nowMs: HISTORY_NOW,
    deckIds: [VOCAB_DECK, CLOZE_DECK],
    ...options,
  });
}

/** Cards in export order: cloze-1 (c1, c2), note-1 (flip, typed), note-2 (flip, typed), note-3 ×2. */
function cardsOf(p: AnkiApkgPlan): Record<string, unknown>[] {
  const notes = table(p, 'notes');
  const guid = new Map(notes.map((n) => [n['id'], n['guid']]));
  return table(p, 'cards').map((c) => ({ ...c, guid: guid.get(c['nid']) }));
}

describe('.apkg review history', () => {
  it('writes one revlog row per active review, in replay order, with unique nudged ids', () => {
    const p = plan();
    const revlog = table(p, 'revlog');
    // 11 reviews recorded, one undone.
    expect(revlog).toHaveLength(10);
    expect(p.reviewCount).toBe(10);
    const ids = revlog.map((r) => r['id'] as number);
    // Three reviews at the same millisecond: the later two move up by 1 ms each.
    expect(ids.slice(0, 3)).toEqual([HISTORY_T, HISTORY_T + 1, HISTORY_T + 2]);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(revlog.every((r) => r['usn'] === -1)).toBe(true);
    expect(revlog.every((r) => Number(r['time']) > 4200 && Number(r['time']) < 4300)).toBe(true);
  });

  it('maps learning steps, lapses and relearning to Anki revlog types and intervals', () => {
    const p = plan();
    const cards = cardsOf(p);
    const revlog = table(p, 'revlog');
    const byCard = (index: number) => revlog.filter((r) => r['cid'] === cards[index]?.['id']);
    // cloze-1 c1: one Hard on a new card stays on the first learning step.
    expect(byCard(0).map((r) => [r['ease'], r['type']])).toEqual([[2, 0]]);

    // note-1 flip: one Good on a new card -> learning step (10 min), the undone Again is gone.
    expect(
      byCard(2).map((r) => [r['ease'], r['type'], r['ivl'], r['lastIvl'], r['factor']]),
    ).toEqual([[3, 0, -600, 0, 0]]);
    // note-2 flip: learn, graduate, lapse (a review entry), relearn and graduate again.
    const relearned = byCard(4);
    expect(relearned.map((r) => [r['ease'], r['type']])).toEqual([
      [3, 0],
      [3, 0],
      [1, 1],
      [3, 2],
    ]);
    const [first, graduated, lapse, back] = relearned;
    expect(first?.['ivl']).toBe(-600);
    expect(graduated?.['ivl']).toBeGreaterThan(0);
    expect(graduated?.['lastIvl']).toBe(-600);
    expect(lapse?.['ivl']).toBe(-600);
    expect(lapse?.['lastIvl']).toBe(graduated?.['ivl']);
    expect(back?.['ivl']).toBeGreaterThan(0);
    expect(back?.['factor']).toBe(2500);
  });

  it('gives each card its Anki scheduling and FSRS memory state from replay', () => {
    const p = plan();
    const cards = cardsOf(p);
    const [cloze1, cloze2, learning, suspended, relearned, relearning, new1, new2] = cards;
    const today = Math.floor((HISTORY_NOW / 1000 - Number(table(p, 'col')[0]?.['crt'])) / 86_400);

    expect([learning?.['type'], learning?.['queue'], learning?.['ivl']]).toEqual([1, 1, 0]);
    expect(learning?.['due']).toBe(Math.floor((HISTORY_T + 600_000) / 1000));
    expect(learning?.['left']).toBe(1001);

    // Suspended keeps its review type and goes to queue -1.
    expect([suspended?.['type'], suspended?.['queue'], suspended?.['factor']]).toEqual([
      2, -1, 2500,
    ]);
    expect(suspended?.['reps']).toBe(2);

    expect([relearned?.['type'], relearned?.['queue']]).toEqual([2, 2]);
    expect(relearned?.['lapses']).toBe(1);
    expect(relearned?.['reps']).toBe(4);
    // Day number relative to crt (today = 0): graduated on day 5 with `ivl` days, export on day 40.
    const ivl = Number(relearned?.['ivl']);
    expect(today).toBe(0);
    expect(relearned?.['due']).toBe(5 + ivl - 40);

    expect([relearning?.['type'], relearning?.['queue'], relearning?.['lapses']]).toEqual([
      3, 1, 1,
    ]);
    expect(Number(relearning?.['ivl'])).toBeGreaterThanOrEqual(1);
    expect(relearning?.['due']).toBe(Math.floor((HISTORY_T + 20 * 86_400_000 + 600_000) / 1000));

    for (const c of [new1, new2, cloze2]) {
      expect([c?.['type'], c?.['queue'], c?.['reps'], c?.['data']]).toEqual([0, 0, 0, '']);
    }
    expect([cloze1?.['type'], cloze1?.['queue'], cloze1?.['left']]).toEqual([1, 1, 2002]);

    const data = JSON.parse(String(relearned?.['data'])) as Record<string, number>;
    const replayed = replaySingleCard(buildAnkiHistoryState(), RELEARNED_CARD)?.schedule;
    if (!replayed) throw new Error('fixture');
    expect(data).toEqual({
      s: Math.round(replayed.stability * 10_000) / 10_000,
      d: Math.round(replayed.difficulty * 1000) / 1000,
      dr: 0.9,
      decay: 0.154,
      lrt: Math.floor((HISTORY_T + 5 * DAY + 600_000) / 1000),
    });
  });

  it('is byte-for-byte deterministic and matches the golden rows', async () => {
    const a = plan();
    const b = plan();
    expect(JSON.stringify(a.collection)).toBe(JSON.stringify(b.collection));
    const golden = {
      cards: cardsOf(a).map((c) =>
        Object.fromEntries(
          [...CARD_COLUMNS, 'reps', 'lapses', 'left', 'data', 'guid'].map((k) => [k, c[k]]),
        ),
      ),
      revlog: table(a, 'revlog'),
    };
    await expect(JSON.stringify(golden, null, 2) + '\n').toMatchFileSnapshot(
      './__golden__/anki-apkg-history.json.snap',
    );
  });

  it('exports every card new when review history is turned off', () => {
    const p = plan({ includeReviewHistory: false });
    expect(table(p, 'revlog')).toHaveLength(0);
    expect(p.reviewCount).toBe(0);
    const cards = cardsOf(p);
    expect(cards.every((c) => c['type'] === 0 && c['data'] === '')).toBe(true);
    expect(cards.filter((c) => c['queue'] === -1)).toHaveLength(1);
  });

  it('leaves a collection without reviews exactly as before (all new, empty revlog)', () => {
    const p = planAnkiApkgExport(buildAnkiExportState(), {
      nowMs: HISTORY_NOW,
      deckIds: [VOCAB_DECK],
    });
    expect(table(p, 'revlog')).toHaveLength(0);
    expect(table(p, 'cards').map((c) => c['due'])).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('keeps crt at or before the export time', () => {
    const early = Date.UTC(2026, 10, 23, 2, 0, 0);
    const p = planAnkiApkgExport(buildAnkiExportState(), { nowMs: early });
    const crt = Number(table(p, 'col')[0]?.['crt']);
    expect(crt).toBe(Date.UTC(2026, 10, 22, 4) / 1000);
  });

  it('anchors crt to the study day in the latest review offset (UTC+9 at 00:00 UTC)', () => {
    // 09:00 KST on 24 Nov (study day 24 Nov); export at 09:00 KST on 25 Nov = 00:00 UTC.
    const at = Date.UTC(2026, 10, 24, 0, 0);
    const now = Date.UTC(2026, 10, 25, 0, 0);
    const p = planAnkiApkgExport(oneReviewState(at, 540), { nowMs: now, deckIds: [VOCAB_DECK] });
    const col = table(p, 'col')[0] ?? {};
    // 04:00 KST on 25 Nov.
    expect(col['crt']).toBe(Date.UTC(2026, 10, 24, 19) / 1000);
    const conf = JSON.parse(String(col['conf'])) as Record<string, unknown>;
    expect([conf['rollover'], conf['creationOffset']]).toEqual([4, -540]);
    expect(ankiToday(p, now)).toBe(0);
    const card = table(p, 'cards').find((c) => c['queue'] === 2);
    // Due on study day 24 Nov + ivl; today is 25 Nov.
    expect(card?.['due']).toBe(Number(card?.['ivl']) - 1);
  });

  it('anchors crt in a negative offset before the rollover hour (UTC-5)', () => {
    // 22:00 EST on 23 Nov (study day 23 Nov); export at 03:00 EST on 25 Nov (study day 24 Nov).
    const at = Date.UTC(2026, 10, 24, 3, 0);
    const now = Date.UTC(2026, 10, 25, 8, 0);
    const p = planAnkiApkgExport(oneReviewState(at, -300), { nowMs: now, deckIds: [VOCAB_DECK] });
    const col = table(p, 'col')[0] ?? {};
    // 04:00 EST on 24 Nov.
    expect(col['crt']).toBe(Date.UTC(2026, 10, 24, 9) / 1000);
    const conf = JSON.parse(String(col['conf'])) as Record<string, unknown>;
    expect([conf['rollover'], conf['creationOffset']]).toEqual([4, 300]);
    expect(ankiToday(p, now)).toBe(0);
    const card = table(p, 'cards').find((c) => c['queue'] === 2);
    expect(card?.['due']).toBe(Number(card?.['ivl']) - 1);
  });

  it('anchors crt to the export offset when given, not the latest review (DST change)', () => {
    // Last review at 22:00 EDT (UTC-4) on 20 Nov; export at 03:30 EST (UTC-5) on 25 Nov, half an
    // hour before the rollover, so still study day 24 Nov. The review's offset would say 04:30
    // and study day 25 Nov.
    const at = Date.UTC(2026, 10, 21, 2, 0);
    const now = Date.UTC(2026, 10, 25, 8, 30);
    const state = oneReviewState(at, -240);
    const stale = planAnkiApkgExport(state, { nowMs: now, deckIds: [VOCAB_DECK] });
    expect(table(stale, 'col')[0]?.['crt']).toBe(Date.UTC(2026, 10, 25, 8) / 1000);

    const p = planAnkiApkgExport(state, {
      nowMs: now,
      tzOffsetMinutes: -300,
      deckIds: [VOCAB_DECK],
    });
    const col = table(p, 'col')[0] ?? {};
    // 04:00 EST on 24 Nov.
    expect(col['crt']).toBe(Date.UTC(2026, 10, 24, 9) / 1000);
    const conf = JSON.parse(String(col['conf'])) as Record<string, unknown>;
    expect([conf['rollover'], conf['creationOffset']]).toEqual([4, 300]);
    expect(ankiToday(p, now)).toBe(0);
    const card = table(p, 'cards').find((c) => c['queue'] === 2);
    // Reviewed on study day 20 Nov (21:00 EST); today is 24 Nov.
    expect(card?.['due']).toBe(Number(card?.['ivl']) - 4);
  });
});
