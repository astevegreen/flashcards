import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyEvents,
  compareCodeUnits,
  compareHardestCards,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveNoteId,
  normalizeCardFilter,
  searchNotes,
  type Card,
  type CollectionState,
  type FlashEvent,
  type ReviewRating,
} from '../../../packages/core/src/index.ts';
import { computeHardestCards } from '../../../packages/core/src/stats/index.ts';
import { encodeEventsSegment, SYNC_V1_PREFIX } from '../../../packages/core/src/sync/index.ts';
import { handleMcpRequest, loadCollectionFromMirror, type JsonRpcRequest } from '../src/index.ts';
import { createMirrorStateCache, mirrorFingerprint } from '../src/mirror-cache.ts';
import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
} from '../src/mcp-protocol.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

const DECK_ID = 'deck-ko-13';
const factory = createEventFactory('device-a', 0, createHlcState('device-a', 1000));

function noteEvent(key: string, fields: Record<string, string>, tags: string[], order: number) {
  return factory.create(
    'NoteUpserted',
    {
      note_id: deriveNoteId(DECK_ID, key),
      deck_id: DECK_ID,
      source_key: key,
      fields,
      tags,
      provenance: { source: 'user', reviewed: true },
      created_order: order,
    },
    1001 + order,
  );
}

function baseEvents(): FlashEvent[] {
  return [
    factory.create(
      'DeckCreated',
      {
        deck_id: DECK_ID,
        name: 'Korean Core',
        note_type_id: 'preset:vocab-ko',
        language: 'ko',
        created_at: 1000,
      },
      1000,
    ),
    noteEvent('n1', { word: '경험', meaning: 'experience' }, ['vocab', 'topik::1'], 0),
    noteEvent('n2', { word: '약속', meaning: 'promise' }, ['vocab'], 1),
    noteEvent('n3', { word: '[約束]{약속}', meaning: 'appointment' }, ['grammar'], 2),
  ];
}

/** A `sync/v1` mirror with one device whose first segment holds `events`. */
function writeMirror(events: FlashEvent[]): { root: string; devDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'flash-mcp13-'));
  tempDirs.push(root);
  const devDir = join(root, SYNC_V1_PREFIX, 'devices', 'device-a');
  mkdirSync(devDir, { recursive: true });
  writeFileSync(join(devDir, 'seg-000001.jsonl.gz'), encodeEventsSegment(events));
  return { root, devDir };
}

function call(ctx: object, name: string, args: Record<string, unknown>, extra = {}) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name, arguments: args, ...extra },
    },
    ctx,
  );
}

const MODERN_META = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  },
};

describe('Phase 13 MCP: search_notes', () => {
  it('returns the Browse notes for a filter and search text, with total before limit', () => {
    const { root } = writeMirror(baseEvents());
    const ctx = { mirrorPath: root, nowMs: () => 5000 };

    const all = call(ctx, 'search_notes', {})?.result as {
      structuredContent: { total: number; notes: Array<{ noteId: string; tags: string[] }> };
      isError: boolean;
    };
    expect(all.isError).toBe(false);
    expect(all.structuredContent.total).toBe(3);
    expect(all.structuredContent.notes.map((n) => n.noteId)).toEqual([
      deriveNoteId(DECK_ID, 'n1'),
      deriveNoteId(DECK_ID, 'n2'),
      deriveNoteId(DECK_ID, 'n3'),
    ]);

    // Search text matches ruby-stripped field text too, exactly like the Browse search box.
    const promise = call(ctx, 'search_notes', { query: '약속' })?.result as {
      structuredContent: { total: number; notes: Array<{ noteId: string }> };
    };
    expect(promise.structuredContent.notes.map((n) => n.noteId)).toEqual([
      deriveNoteId(DECK_ID, 'n2'),
      deriveNoteId(DECK_ID, 'n3'),
    ]);

    // Phase 9 filter: category `topik` also matches `topik::1`.
    const topik = call(ctx, 'search_notes', {
      filter: { categories: { mode: 'any', tags: ['topik'] } },
    })?.result as { structuredContent: { total: number; notes: Array<{ noteId: string }> } };
    expect(topik.structuredContent.notes.map((n) => n.noteId)).toEqual([
      deriveNoteId(DECK_ID, 'n1'),
    ]);

    const limited = call(ctx, 'search_notes', { limit: 1 })?.result as {
      structuredContent: { total: number; notes: unknown[] };
    };
    expect(limited.structuredContent.total).toBe(3);
    expect(limited.structuredContent.notes).toHaveLength(1);

    // Contradicting deck restrictions match nothing instead of everything.
    const none = call(ctx, 'search_notes', {
      deckIds: ['other-deck'],
      filter: { deckIds: [DECK_ID] },
    })?.result as { structuredContent: { total: number } };
    expect(none.structuredContent.total).toBe(0);
  });

  it('agrees with the core searchNotes for the same filter', () => {
    const events = baseEvents();
    const { root } = writeMirror(events);
    const state = createEmptyState();
    applyEvents(state, events);
    const filter = normalizeCardFilter({ categories: { mode: 'none', tags: ['grammar'] } });
    const expected = searchNotes(state, filter, { nowMs: 5000, tzOffsetMinutes: 0 }, {});
    const resp = call({ mirrorPath: root, nowMs: () => 5000 }, 'search_notes', {
      filter,
      tzOffsetMinutes: 0,
    })?.result as { structuredContent: { total: number; notes: Array<{ noteId: string }> } };
    expect(resp.structuredContent.notes.map((n) => n.noteId)).toEqual(
      expected.notes.map((n) => n.id),
    );
    expect(resp.structuredContent.total).toBe(expected.total);
  });
});

describe('Phase 13 MCP: mirror reload', () => {
  it('reloads only when the mirror files change', () => {
    const { root, devDir } = writeMirror(baseEvents());
    let loads = 0;
    const cache = createMirrorStateCache(root, (path) => {
      loads += 1;
      return loadCollectionFromMirror(path);
    });
    expect(cache.get().notes.size).toBe(3);
    expect(cache.get().notes.size).toBe(3);
    expect(loads).toBe(1);
    expect(cache.loadCount).toBe(1);

    const before = mirrorFingerprint(root);
    writeFileSync(
      join(devDir, 'seg-000002.jsonl.gz'),
      encodeEventsSegment([noteEvent('n4', { word: '사랑', meaning: 'love' }, [], 3)]),
    );
    expect(mirrorFingerprint(root)).not.toBe(before);
    expect(cache.get().notes.size).toBe(4);
    expect(loads).toBe(2);
  });

  it('MCP tools see a new segment written while the server runs', () => {
    const { root, devDir } = writeMirror(baseEvents());
    const ctx = { mirrorPath: root, nowMs: () => 5000 };
    const total = () =>
      (call(ctx, 'search_notes', {})?.result as { structuredContent: { total: number } })
        .structuredContent.total;
    expect(total()).toBe(3);
    writeFileSync(
      join(devDir, 'seg-000002.jsonl.gz'),
      encodeEventsSegment([noteEvent('n4', { word: '사랑', meaning: 'love' }, [], 3)]),
    );
    expect(total()).toBe(4);
  });
});

describe('Phase 13 MCP: protocol versions', () => {
  const ctx = { state: createEmptyState(), nowMs: () => 5000 };

  it('legacy initialize echoes a supported version and offers the newest otherwise', () => {
    for (const version of MCP_LEGACY_PROTOCOL_VERSIONS) {
      const resp = handleMcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } },
        ctx,
      );
      expect((resp?.result as { protocolVersion: string }).protocolVersion).toBe(version);
    }
    const unknown = handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2023-01-01' } },
      ctx,
    );
    expect((unknown?.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    const bare = handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ctx);
    expect(bare?.result).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'flashcards-local-mcp' },
    });
  });

  it('modern requests carry _meta and get the complete result envelope', () => {
    const discover = handleMcpRequest(
      { jsonrpc: '2.0', id: 2, method: 'server/discover', params: MODERN_META },
      ctx,
    );
    expect(discover?.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'flashcards-local-mcp' } },
    });

    const listed = handleMcpRequest(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: MODERN_META },
      ctx,
    );
    expect(listed?.result).toMatchObject({ resultType: 'complete' });

    const called = call(ctx, 'list_decks', {}, MODERN_META);
    expect(called?.result).toMatchObject({
      resultType: 'complete',
      isError: false,
      structuredContent: { decks: [] },
    });
  });

  it('rejects an unsupported or incomplete modern request', () => {
    const unsupported = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2099-01-01',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      ctx,
    );
    expect(unsupported?.error).toEqual({
      code: MCP_UNSUPPORTED_PROTOCOL_VERSION,
      message: 'Unsupported protocol version',
      data: { supported: ['2026-07-28'], requested: '2099-01-01' },
    });

    const missingCaps = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      },
      ctx,
    );
    expect(missingCaps?.error?.code).toBe(-32602);
  });

  it('reports unknown tools as protocol errors and failing tools as isError results', () => {
    expect(call(ctx, 'no_such_tool', {})?.error?.code).toBe(-32602);
    const failed = call(ctx, 'propose_package', {})?.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(failed.isError).toBe(true);
    expect(failed.content[0]?.text).toMatch(/requires non-empty name/);
  });

  it('answers ping and ignores notifications', () => {
    expect(handleMcpRequest({ jsonrpc: '2.0', id: 9, method: 'ping' }, ctx)?.result).toEqual({});
    const note: JsonRpcRequest = { jsonrpc: '2.0', method: 'notifications/initialized' };
    expect(handleMcpRequest(note, ctx)).toBeNull();
    expect(handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/cancelled' }, ctx)).toBeNull();
    // A request method sent without an id is a notification too: no reply, and nothing runs.
    const noId: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'list_decks', arguments: {} },
    };
    expect(handleMcpRequest(noId, ctx)).toBeNull();
    expect(handleMcpRequest({ jsonrpc: '2.0', method: 'ping' }, ctx)).toBeNull();
    // An explicit `id: null` is still answered (with `id: null`).
    expect(handleMcpRequest({ jsonrpc: '2.0', id: null, method: 'ping' }, ctx)).toEqual({
      jsonrpc: '2.0',
      id: null,
      result: {},
    });
  });
});

describe('Phase 13 MCP: get_weak_cards with the Phase 9 filter', () => {
  const NOW = Date.UTC(2026, 2, 10, 3, 0, 0);
  const DAY = 86_400_000;
  const TZ = 540;
  const OTHER_DECK = 'deck-ko-13-b';

  function otherDeckEvents(f: ReturnType<typeof createEventFactory>): FlashEvent[] {
    return [
      f.create(
        'DeckCreated',
        {
          deck_id: OTHER_DECK,
          name: 'Korean Extra',
          note_type_id: 'preset:vocab-ko',
          language: 'ko',
          created_at: 1000,
        },
        1000,
      ),
      f.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId(OTHER_DECK, 'm1'),
          deck_id: OTHER_DECK,
          source_key: 'm1',
          fields: { word: '사랑', meaning: 'love' },
          tags: ['vocab', 'topik::2'],
          provenance: { source: 'user', reviewed: true },
          created_order: 0,
        },
        1010,
      ),
    ];
  }

  /** Two passes, then `lapses` Again + Good pairs, four days apart. */
  function reviewEvents(
    f: ReturnType<typeof createEventFactory>,
    cardId: string,
    index: number,
    lapses: number,
  ): FlashEvent[] {
    const out: FlashEvent[] = [];
    let t = NOW - 40 * DAY + index * 1000;
    const ratings: ReviewRating[] = [3, 3];
    for (let i = 0; i < lapses; i++) ratings.push(1, 3);
    ratings.forEach((rating, i) => {
      if (i > 0) t += rating === 1 ? 4 * DAY : 600_000;
      out.push(
        f.create(
          'ReviewRecorded',
          {
            review_id: `weak-${index}-${i}`,
            card_id: cardId,
            rating,
            reviewed_at: t,
            tz_offset: TZ,
            duration_ms: 1000,
            answer_mode: 'flip',
            fsrs_params_version: 0,
            resulting_due_at: t,
          },
          t,
        ),
      );
    });
    return out;
  }

  /** Two decks, tagged notes, and a different number of lapses on every card (card 0 unreviewed). */
  function reviewedState(): CollectionState {
    const f = createEventFactory('device-w', 0, createHlcState('device-w', 1000));
    const events: FlashEvent[] = [...baseEvents(), ...otherDeckEvents(f)];
    const seeded = createEmptyState();
    applyEvents(seeded, events);
    const cardIds = [...seeded.cards.keys()].sort(compareCodeUnits);
    cardIds.forEach((cardId, index) => {
      if (index > 0) events.push(...reviewEvents(f, cardId, index, (index * 7) % 4));
    });
    const state = createEmptyState();
    applyEvents(state, events);
    return state;
  }

  const filterCtx = { nowMs: NOW, tzOffsetMinutes: TZ };

  function weakIds(state: CollectionState, args: Record<string, unknown>): string[] {
    const resp = call({ state, nowMs: () => NOW }, 'get_weak_cards', {
      tzOffsetMinutes: TZ,
      ...args,
    });
    const data = (resp?.result as { structuredContent: { cards: Array<{ cardId: string }> } })
      .structuredContent;
    return data.cards.map((c) => c.cardId);
  }

  it('lists the same cards in the same order as the Stats screen hardest cards', () => {
    const state = reviewedState();
    const filters = [
      {},
      { categories: { mode: 'any', tags: ['topik'] } },
      { categories: { mode: 'all', tags: ['vocab', 'topik::1'] } },
      { categories: { mode: 'none', tags: ['grammar'] } },
      { deckIds: [OTHER_DECK], categories: { mode: 'any', tags: ['vocab'] } },
      { categories: { mode: 'any', tags: ['vocab'] }, performance: { minLapses: 1, hardest: 2 } },
      { states: ['review'], categories: { mode: 'none', tags: ['topik::2'] } },
    ];
    for (const filter of filters) {
      const screen = computeHardestCards(state, filter, filterCtx).map((c) => c.id);
      expect(weakIds(state, { filter })).toEqual(screen);
    }
  });

  it('a category filter narrows the ranked list to that category, hardest first', () => {
    const state = reviewedState();
    const all = computeHardestCards(state, {}, filterCtx);
    const topik = computeHardestCards(
      state,
      { categories: { mode: 'any', tags: ['topik'] } },
      filterCtx,
    );
    expect(topik.length).toBeGreaterThan(0);
    expect(topik.length).toBeLessThan(all.length);
    const topikTagged = topik.filter((card) =>
      state.notes.get(card.note_id)?.tags.some((t) => t.startsWith('topik')),
    );
    expect(topikTagged).toHaveLength(topik.length);
    const pairs = all.slice(1).map((card, i) => compareHardestCards(all[i] as Card, card));
    expect(pairs.every((cmp) => cmp < 0)).toBe(true);
    expect(all.every((c) => c.schedule.reps > 0)).toBe(true);
  });

  it('agrees with computeHardestCards for any filter, deck and limit (property)', () => {
    const state = reviewedState();
    const tag = fc.constantFrom('vocab', 'grammar', 'topik', 'topik::1', 'topik::2', 'leech');
    const filterArb = fc.record(
      {
        deckIds: fc.subarray([DECK_ID, OTHER_DECK]),
        categories: fc.record({
          mode: fc.constantFrom('any', 'all', 'none'),
          tags: fc.uniqueArray(tag, { maxLength: 3 }),
        }),
        performance: fc.record(
          { minLapses: fc.integer({ min: 1, max: 3 }), hardest: fc.integer({ min: 1, max: 6 }) },
          { requiredKeys: [] },
        ),
      },
      { requiredKeys: [] },
    );
    const deckArb = fc.option(fc.constantFrom(DECK_ID, OTHER_DECK), { nil: undefined });
    fc.assert(
      fc.property(filterArb, deckArb, fc.integer({ min: 1, max: 8 }), (filter, deckId, limit) => {
        const args = { filter, limit, ...(deckId === undefined ? {} : { deckId }) };
        const own = normalizeCardFilter(filter).deckIds;
        const narrowed = own?.filter((d) => d === deckId) ?? [deckId];
        const deckIds = deckId === undefined ? own : narrowed;
        const expected =
          deckIds?.length === 0
            ? []
            : computeHardestCards(state, { ...filter, deckIds }, filterCtx, limit).map((c) => c.id);
        expect(weakIds(state, args)).toEqual(expected);
      }),
      { numRuns: 150 },
    );
  });
});
