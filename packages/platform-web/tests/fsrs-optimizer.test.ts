import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  applyEvents,
  applyReviewToSchedule,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  createInitialSchedule,
  deriveCardId,
  deriveNoteId,
  type FlashEvent,
  type ReviewRating,
} from '@flash/core';
import {
  buildTrainingBatch,
  collectOptimizerDataset,
  estimateRetention,
  getCurrentDeckWeights,
  getOptimizerReadiness,
  normalizeOptimizedWeights,
} from '@flash/core/fsrs-optimizer';
import type { FsrsOptimizerInput } from '@flash/platform';
import type * as FsrsBrowserModule from 'fsrs-browser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  handleFsrsOptimizerRequest,
  type FsrsOptimizerResponse,
  type FsrsTrainingEngine,
} from '../src/fsrs/fsrs-optimizer-protocol.ts';
import { WebFsrsOptimizer, type FsrsOptimizerWorkerLike } from '../src/fsrs/web-fsrs-optimizer.ts';

const DECK = 'deck-ko-fixture';
const LAYOUT = 'layout:vocab-ko:recognition';
const DAY = 86_400_000;
const BASE = Date.UTC(2025, 0, 6, 1, 0, 0);
const CARD_COUNT = 60;

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/**
 * Fixed synthetic review log: a simulated learner (true stability x2.4 on recall, x0.35 on a
 * lapse, FSRS-6 power forgetting curve) studies 60 cards, each reviewed when the app's own
 * default scheduler says it is due. Same seed -> same events -> same training batch.
 */
function buildFixtureEvents(): FlashEvent[] {
  const f = createEventFactory('fixture', 0, createHlcState('fixture', BASE - DAY));
  const events: FlashEvent[] = [
    f.create(
      'DeckCreated',
      {
        deck_id: DECK,
        name: 'Fixture',
        note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
        language: 'ko',
      },
      BASE - DAY,
    ),
  ];
  const rand = lcg(20_260_301);
  let n = 0;
  for (let c = 0; c < CARD_COUNT; c++) {
    const key = `word-${c}`;
    events.push(
      f.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(DECK, key),
          deck_id: DECK,
          source_key: key,
          fields: { word: key, meaning: `m${c}` },
          created_order: c,
        },
        BASE - DAY + c,
      ),
    );
    const cardId = deriveCardId(deriveNoteId(DECK, key), LAYOUT, 0);
    let at = BASE + Math.floor(rand() * 20) * DAY + Math.floor(rand() * 10) * 3_600_000;
    let schedule = createInitialSchedule(0);
    let trueStability = 0.5 + rand() * 3;
    let lastAt: number | undefined;
    for (let i = 0; i < 12; i++) {
      let rating: ReviewRating;
      if (lastAt === undefined) {
        rating = rand() < 0.25 ? 1 : 3;
      } else {
        const days = (at - lastAt) / DAY;
        const recall = (1 + (days / trueStability) * (0.9 ** (-1 / 0.1542) - 1)) ** -0.1542;
        const remembered = rand() < recall;
        trueStability = remembered ? trueStability * 2.4 : Math.max(0.3, trueStability * 0.35);
        rating = remembered ? (rand() < 0.15 ? 4 : 3) : 1;
      }
      n += 1;
      events.push(
        f.create(
          'ReviewRecorded',
          {
            review_id: `fx-${n}`,
            card_id: cardId,
            rating,
            reviewed_at: at,
            tz_offset: 0,
            duration_ms: 3000,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: 0,
          },
          at,
        ),
      );
      schedule = applyReviewToSchedule(schedule, rating, at, { request_retention: 0.9 }).next;
      lastAt = at;
      at = Math.max(schedule.due, at + 60_000);
    }
  }
  return events;
}

function fixtureInput(): {
  input: FsrsOptimizerInput;
  histories: ReturnType<typeof collectOptimizerDataset>['histories'];
} {
  const state = createEmptyState();
  applyEvents(state, buildFixtureEvents());
  const dataset = collectOptimizerDataset(state, DECK);
  expect(getOptimizerReadiness(dataset).ready).toBe(true);
  const batch = buildTrainingBatch(dataset.histories);
  return {
    histories: dataset.histories,
    input: {
      ratings: batch.ratings,
      delta_ts: batch.delta_ts,
      lengths: batch.lengths,
      enable_short_term: true,
    },
  };
}

/**
 * Weights `fsrs-browser@6.6.0` (fsrs-rs 6.6, seeded training) produced for the fixture above.
 * Regenerate only when the fixture, the training-data rules or the trainer version change.
 */
const KNOWN_WEIGHTS: readonly number[] = [
  2.2324, 3.9265, 5.8134, 8.1209, 6.3371, 0.8266, 2.9464, 0.0886, 1.9209, 0.2356, 0.8416, 1.5206,
  0.0663, 0.3459, 1.6605, 0.6014, 1.7731, 0.5388, 0.125, 0.0677, 0.2325,
];
const WEIGHT_TOLERANCE = 0.02;

async function collect(
  data: unknown,
  loadEngine: () => Promise<FsrsTrainingEngine>,
): Promise<FsrsOptimizerResponse[]> {
  const out: FsrsOptimizerResponse[] = [];
  await handleFsrsOptimizerRequest(data, loadEngine, (m) => out.push(m));
  return out;
}

describe('FSRS optimizer worker protocol', () => {
  const input: FsrsOptimizerInput = {
    ratings: new Uint32Array([3, 3]),
    delta_ts: new Uint32Array([0, 2]),
    lengths: new Uint32Array([2]),
    enable_short_term: true,
  };

  it('reports loading then training, then the raw weights', async () => {
    const seen: FsrsOptimizerInput[] = [];
    const msgs = await collect({ type: 'optimize', input }, async () => ({
      computeParameters: (i) => {
        seen.push(i);
        return Float32Array.of(1.5, 2.25);
      },
    }));
    expect(msgs).toEqual([
      { type: 'stage', stage: 'loading' },
      { type: 'stage', stage: 'training' },
      { type: 'done', weights: [1.5, 2.25] },
    ]);
    expect(seen[0]?.lengths).toEqual(input.lengths);
  });

  it('turns engine load and training failures into error messages', async () => {
    expect(
      await collect({ type: 'optimize', input }, () => Promise.reject(new Error('no wasm'))),
    ).toEqual([
      { type: 'stage', stage: 'loading' },
      { type: 'error', message: 'no wasm' },
    ]);
    const msgs = await collect({ type: 'optimize', input }, async () => ({
      computeParameters: () => {
        throw 'not enough data';
      },
    }));
    expect(msgs.at(-1)).toEqual({ type: 'error', message: 'not enough data' });
  });

  it('rejects malformed requests without touching the engine', async () => {
    const load = vi.fn();
    for (const bad of [null, 'optimize', { type: 'optimize' }, { type: 'x', input }]) {
      expect(await collect(bad, load)).toEqual([
        { type: 'error', message: 'Malformed FSRS optimizer request' },
      ]);
    }
    expect(load).not.toHaveBeenCalled();
  });
});

class FakeWorker implements FsrsOptimizerWorkerLike {
  onmessage: ((ev: MessageEvent<FsrsOptimizerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  transfers: Transferable[][] = [];
  terminated = 0;
  postMessage(message: unknown, transfer: Transferable[]): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }
  terminate(): void {
    this.terminated += 1;
  }
  emit(msg: FsrsOptimizerResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<FsrsOptimizerResponse>);
  }
}

describe('WebFsrsOptimizer (one Worker per run)', () => {
  const input = (): FsrsOptimizerInput => ({
    ratings: new Uint32Array([3, 1]),
    delta_ts: new Uint32Array([0, 4]),
    lengths: new Uint32Array([2]),
    enable_short_term: true,
  });

  it('posts a transferable copy, forwards stages and resolves with the weights', async () => {
    const worker = new FakeWorker();
    const optimizer = new WebFsrsOptimizer(() => worker);
    const stages: string[] = [];
    const original = input();
    const run = optimizer.optimize(original, { onStage: (s) => stages.push(s) });
    expect(worker.transfers[0]).toHaveLength(3);
    // The caller's arrays stay usable (a retry can reuse them).
    expect(original.ratings.length).toBe(2);
    worker.emit({ type: 'stage', stage: 'loading' });
    worker.emit({ type: 'stage', stage: 'training' });
    worker.emit({ type: 'done', weights: [0.4, 0.6] });
    await expect(run.result).resolves.toEqual([0.4, 0.6]);
    expect(stages).toEqual(['loading', 'training']);
    expect(worker.terminated).toBe(1);
    run.cancel();
    expect(worker.terminated).toBe(1);
  });

  it('cancel terminates the Worker and rejects with AbortError', async () => {
    const worker = new FakeWorker();
    const run = new WebFsrsOptimizer(() => worker).optimize(input());
    worker.emit({ type: 'stage', stage: 'training' });
    run.cancel();
    await expect(run.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(1);
    // A late message from the dead Worker is ignored.
    worker.emit({ type: 'done', weights: [1] });
  });

  it('rejects on trainer errors and Worker load errors', async () => {
    const w1 = new FakeWorker();
    const r1 = new WebFsrsOptimizer(() => w1).optimize(input());
    w1.emit({ type: 'error', message: 'boom' });
    await expect(r1.result).rejects.toThrow('boom');
    const w2 = new FakeWorker();
    const r2 = new WebFsrsOptimizer(() => w2).optimize(input());
    w2.onerror?.({ message: '' } as ErrorEvent);
    await expect(r2.result).rejects.toThrow('FSRS optimizer worker failed to load');
    expect(w1.terminated + w2.terminated).toBe(2);
  });
});

/**
 * Runs the real `fsrs-browser` WASM under Node. Its glue expects a worker-like `self` with
 * `addEventListener` (wasm-bindgen-rayon's helper registers a listener at import time), so a
 * minimal one is installed for the duration of the suite. Training is single-threaded, exactly
 * like the app's Worker, so this is the same code path minus the Worker boundary.
 */
describe('fsrs-browser WASM fixture (real trainer, known weights)', () => {
  const g = globalThis as Record<string, unknown>;
  const hadSelf = 'self' in g;
  let engine: FsrsTrainingEngine;

  beforeAll(async () => {
    if (!hadSelf) {
      const target = new EventTarget();
      g['self'] = Object.assign(Object.create(null) as object, {
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
      });
    }
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('fsrs-browser/fsrs_browser_bg.wasm');
    // fsrs-browser only declares `module`, which Node-side resolution ignores: load the file.
    const mod = (await import(
      pathToFileURL(require.resolve('fsrs-browser/fsrs_browser.js')).href
    )) as typeof FsrsBrowserModule;
    mod.initSync({ module: readFileSync(wasmPath) });
    engine = {
      computeParameters(i) {
        const fsrs = new mod.Fsrs();
        try {
          return fsrs.computeParameters(
            i.ratings,
            i.delta_ts,
            i.lengths,
            undefined,
            i.enable_short_term,
          );
        } finally {
          fsrs.free();
        }
      },
    };
  });

  afterAll(() => {
    if (!hadSelf) delete g['self'];
  });

  it('optimizes the fixture through the worker protocol to the known weights', async () => {
    const { input, histories } = fixtureInput();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const msgs = await collect({ type: 'optimize', input }, async () => engine);
    log.mockRestore();
    const done = msgs.at(-1);
    expect(done?.type).toBe('done');
    const weights = normalizeOptimizedWeights(done?.type === 'done' ? done.weights : []);
    expect(weights).not.toBeNull();
    if (!weights) return;
    expect(weights).toHaveLength(KNOWN_WEIGHTS.length);
    weights.forEach((w, i) =>
      expect(Math.abs(w - (KNOWN_WEIGHTS[i] ?? Number.NaN))).toBeLessThan(WEIGHT_TOLERANCE),
    );

    // The optimized weights must fit the history better than the defaults they replace.
    const before = estimateRetention(
      histories,
      getCurrentDeckWeights(createEmptyState(), DECK, BASE),
    );
    const after = estimateRetention(histories, weights);
    expect(after.reviews).toBe(before.reviews);
    expect(after.log_loss).toBeLessThan(before.log_loss);
    expect(Math.abs(after.predicted_retention - after.measured_retention)).toBeLessThan(
      Math.abs(before.predicted_retention - before.measured_retention) + 0.01,
    );
  });

  it('is deterministic: the same events train to the same weights', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = engine.computeParameters(fixtureInput().input);
    const b = engine.computeParameters(fixtureInput().input);
    log.mockRestore();
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
