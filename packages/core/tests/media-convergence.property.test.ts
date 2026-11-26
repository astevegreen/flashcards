import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeStatePatch, mergeStatePatch } from '../src/events/patch.ts';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  type CollectionState,
} from '../src/events/replay.ts';
import { deserializeCollectionState, serializeCollectionState } from '../src/events/snapshot.ts';
import type { FlashEvent } from '../src/events/types.ts';
import { createHlcState } from '../src/hlc.ts';
import { compareCodeUnits } from '../src/study/queue.ts';

const HASHES = ['a'.repeat(64), 'b'.repeat(64)];

function shuffleWithSeed<T>(arr: readonly T[], s: number): T[] {
  const copy = [...arr];
  let x = s || 1;
  for (let i = copy.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

function replayChunked(list: readonly FlashEvent[], chunk: number): CollectionState {
  const st = createEmptyState();
  for (let i = 0; i < list.length; i += chunk) applyEvents(st, list.slice(i, i + chunk));
  return st;
}

function sortedRecord(map: ReadonlyMap<string, string>): [string, string][] {
  return [...map.entries()].sort(([a], [b]) => compareCodeUnits(a, b));
}

function observe(st: CollectionState) {
  return {
    media: [...st.media.values()]
      .sort((a, b) => compareCodeUnits(a.hash, b.hash))
      .map((m) => ({ ...m })),
    byKey: sortedRecord(st.ttsMediaByKey),
    byLangKey: sortedRecord(st.ttsMediaByLangKey),
  };
}

function roundTrip(st: CollectionState): CollectionState {
  return deserializeCollectionState(
    JSON.parse(JSON.stringify(serializeCollectionState(st))) as ReturnType<
      typeof serializeCollectionState
    >,
  );
}

describe('MediaAdded / MediaRemoved converge in any delivery order (D20)', () => {
  it('an older MediaAdded that arrives last does not overwrite the newer one', () => {
    const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);
    const a = createEventFactory('dev-a', 0, createHlcState('dev-a', t0));
    const b = createEventFactory('dev-b', 0, createHlcState('dev-b', t0));
    const hash = HASHES[0] ?? '';
    const older = a.create(
      'MediaAdded',
      { media: { hash, ext: 'mp3', mime: 'audio/mpeg', size: 10, tts_key: 'k-old' } },
      t0,
    );
    const newer = b.create(
      'MediaAdded',
      { media: { hash, ext: 'ogg', mime: 'audio/ogg', size: 10, tts_key: 'k-new' } },
      t0 + 1_000,
    );
    const inOrder = replayChunked([older, newer], 1);
    const reversed = replayChunked([newer, older], 1);
    expect(reversed.media.get(hash)).toEqual(inOrder.media.get(hash));
    expect(reversed.media.get(hash)?.ext).toBe('ogg');
    expect(reversed.media.get(hash)?.tts_key).toBe('k-new');
    expect(observe(reversed)).toEqual(observe(inOrder));
  });

  it('replay, snapshots and worker patches all agree under any interleaving', () => {
    const opArb = fc.record({
      remove: fc.boolean(),
      hash: fc.integer({ min: 0, max: 1 }),
      device: fc.integer({ min: 0, max: 2 }),
      ext: fc.constantFrom('mp3', 'ogg', 'PNG'),
      size: fc.integer({ min: 1, max: 3 }),
      ttsKey: fc.option(fc.constantFrom('k1', 'k2', 'k3'), { nil: undefined }),
      langKey: fc.option(fc.constantFrom('l1', 'l2'), { nil: undefined }),
      dt: fc.integer({ min: -2_000, max: 30_000 }),
    });
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 1, maxLength: 18 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (ops, seed) => {
          const base = Date.UTC(2026, 10, 1, 1, 0, 0);
          const factories = ['dev-a', 'dev-b', 'dev-c'].map((d, i) =>
            createEventFactory(d, 0, createHlcState(d, base + i * 100)),
          );
          let clock = base;
          const events: FlashEvent[] = ops.map((op) => {
            clock += op.dt;
            const f = factories[op.device] ?? factories[0];
            const hash = HASHES[op.hash] ?? '';
            if (!f) throw new Error('no factory');
            if (op.remove) return f.create('MediaRemoved', { hash }, clock);
            return f.create(
              'MediaAdded',
              {
                media: {
                  hash,
                  ext: op.ext,
                  mime: `audio/${op.ext.toLowerCase()}`,
                  size: op.size,
                  ...(op.ttsKey !== undefined ? { tts_key: op.ttsKey } : {}),
                  ...(op.langKey !== undefined ? { tts_lang_key: op.langKey } : {}),
                },
              },
              clock,
            );
          });

          const reference = observe(replayChunked(events, events.length));
          const orders: FlashEvent[][] = [
            [...events].reverse(),
            shuffleWithSeed(events, seed),
            [...shuffleWithSeed(events, seed + 1), ...shuffleWithSeed(events, seed + 2)],
          ];
          for (const [i, order] of orders.entries()) {
            expect(observe(replayChunked(order, i + 1))).toEqual(reference);
          }

          // A snapshot of a prefix, then the rest: on the main thread and through a worker patch.
          const cut = Math.floor(events.length / 2);
          const shuffled = shuffleWithSeed(events, seed + 3);
          const prefix = replayChunked(shuffled.slice(0, cut), 2);
          const hydrated = roundTrip(prefix);
          applyEvents(hydrated, shuffled.slice(cut));
          expect(observe(hydrated)).toEqual(reference);

          const main = roundTrip(prefix);
          const worker = roundTrip(prefix);
          mergeStatePatch(main, computeStatePatch(worker, shuffled.slice(cut)));
          expect(observe(main)).toEqual(reference);
        },
      ),
      { numRuns: 300 },
    );
  });
});
