import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as process from 'node:process';
import { createInterface } from 'node:readline';
import {
  applyEvents,
  buildStudyQueue,
  cardFilterToStatsFilter,
  createEmptyState,
  createEventFactory,
  createHlcState,
  filterCards,
  normalizeCardFilter,
  searchNotes,
  type Card,
  type CardFilter,
  type CollectionState,
  type FlashEvent,
  type Note,
} from '@flash/core';
import { importFlashpkg } from '@flash/core/flashpkg';
import { deserializeCollectionState } from '@flash/core/snapshot';
import { computeCollectionStats, type CollectionStatsOptions } from '@flash/core/stats';
import { decodeEventsSegment, decodeSyncSnapshot, SYNC_V1_PREFIX } from '@flash/core/sync';
import {
  buildPackageFromSpec,
  type BuildDeckNoteInput,
  type BuildPageSpec,
} from './commands/build.ts';
import { createMirrorStateCache, type MirrorStateCache } from './mirror-cache.ts';
import {
  discoverResult,
  JSONRPC_INVALID_PARAMS,
  legacyInitializeResult,
  readRequestEra,
  withModernEnvelope,
  type McpProtocolError,
} from './mcp-protocol.ts';

export interface McpServerContext {
  state?: CollectionState;
  mirrorPath?: string;
  inboxDir?: string;
  nowMs?: () => number;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Loads a `CollectionState` from either a `.flashpkg` backup archive or a `sync/v1/` mirror folder.
 */
export function loadCollectionFromMirror(mirrorPath: string): CollectionState {
  if (!existsSync(mirrorPath)) {
    throw new Error(`Mirror path not found: ${mirrorPath}`);
  }
  const st = statSync(mirrorPath);
  if (st.isFile() && mirrorPath.toLowerCase().endsWith('.flashpkg')) {
    const state = createEmptyState();
    const factory = createEventFactory('mcp-reader', 0, createHlcState('mcp-reader', 1000));
    const imported = importFlashpkg(readFileSync(mirrorPath), state, factory, { nowMs: 1000 });
    applyEvents(state, imported.events);
    return state;
  }

  // Sync mirror directory: check `<mirrorPath>/sync/v1` or `<mirrorPath>` directly
  const syncRoot = existsSync(join(mirrorPath, SYNC_V1_PREFIX, 'devices'))
    ? join(mirrorPath, SYNC_V1_PREFIX)
    : mirrorPath;

  let state = createEmptyState();

  const snapshotsDir = join(syncRoot, 'snapshots');
  if (existsSync(snapshotsDir) && statSync(snapshotsDir).isDirectory()) {
    const snapFiles = readdirSync(snapshotsDir)
      .filter((f) => f.endsWith('.json.gz'))
      .sort();
    const latest = snapFiles[snapFiles.length - 1];
    if (latest) {
      const snap = decodeSyncSnapshot(readFileSync(join(snapshotsDir, latest)));
      state = deserializeCollectionState(snap.state);
    }
  }

  const devicesDir = join(syncRoot, 'devices');
  const events: FlashEvent[] = [];
  if (existsSync(devicesDir) && statSync(devicesDir).isDirectory()) {
    for (const dev of readdirSync(devicesDir, { withFileTypes: true })) {
      if (!dev.isDirectory()) continue;
      const devPath = join(devicesDir, dev.name);
      const segFiles = readdirSync(devPath)
        .filter((f) => /^seg-\d+\.jsonl\.gz$/i.test(f))
        .sort();
      for (const seg of segFiles) {
        events.push(...decodeEventsSegment(readFileSync(join(devPath, seg))));
      }
    }
  }

  if (events.length > 0) {
    applyEvents(state, events);
  }
  return state;
}

// One cache per server context: the mirror is reloaded only when its files change (Phase 13).
const mirrorCaches = new WeakMap<McpServerContext, { path: string; cache: MirrorStateCache }>();

function resolveState(ctx: McpServerContext): CollectionState {
  if (ctx.state) return ctx.state;
  if (ctx.mirrorPath) {
    let entry = mirrorCaches.get(ctx);
    if (entry?.path !== ctx.mirrorPath) {
      entry = {
        path: ctx.mirrorPath,
        cache: createMirrorStateCache(ctx.mirrorPath, loadCollectionFromMirror),
      };
      mirrorCaches.set(ctx, entry);
    }
    return entry.cache.get();
  }
  return createEmptyState();
}

/** JSON Schema of the Phase 9 `CardFilter` (the same model Browse, Study and Stats use). */
const CARD_FILTER_SCHEMA = {
  type: 'object',
  description:
    'Phase 9 card filter, all criteria AND-ed: decks, categories (note tags; "a" also matches "a::b") with any/all/none matching, card states and performance criteria.',
  properties: {
    deckIds: { type: 'array', items: { type: 'string' } },
    categories: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['any', 'all', 'none'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['mode', 'tags'],
    },
    states: {
      type: 'array',
      items: { type: 'string', enum: ['new', 'learning', 'review', 'due', 'suspended', 'leech'] },
    },
    performance: {
      type: 'object',
      properties: {
        minLapses: { type: 'integer', minimum: 1 },
        minAgainCount: { type: 'integer', minimum: 1 },
        failedWithinDays: { type: 'integer', minimum: 1 },
        maxRetrievability: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        hardest: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

function resolveTz(args: Record<string, unknown>, now: number): number {
  const tz = args['tzOffsetMinutes'];
  return typeof tz === 'number' && Number.isFinite(tz)
    ? Math.round(tz)
    : -new Date(now).getTimezoneOffset();
}

/**
 * Normalizes the optional `filter` argument and narrows it to `deckIds` when both are given.
 * Returns `undefined` when the two contradict (no deck can match).
 */
function resolveFilterArg(
  raw: unknown,
  deckIds: readonly string[] | undefined,
): CardFilter | undefined {
  const filter = normalizeCardFilter(raw);
  if (deckIds === undefined) return filter;
  const own = filter.deckIds;
  const wanted = own ? deckIds.filter((id) => own.includes(id)) : [...deckIds];
  if (wanted.length === 0) return undefined;
  return normalizeCardFilter({ ...filter, deckIds: wanted });
}

const SEARCH_NOTES_DEFAULT_LIMIT = 50;
const SEARCH_NOTES_MAX_LIMIT = 500;

export const MCP_TOOLS = [
  {
    name: 'list_decks',
    description:
      'List all active decks in the local collection with note counts, due counts, language, and AI review backlog.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'search_notes',
    description:
      'Find notes exactly as the Browse screen does: a Phase 9 filter (decks, categories with any/all/none, card states, performance) plus the Browse search text ("#tag" matches a category, other text matches fields or tags). Returns notes in Browse order (or hardest first when the filter ranks hardest cards) with `total` before `limit`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Browse search text (default: every note).' },
        filter: CARD_FILTER_SCHEMA,
        deckIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to these deck ids (AND-ed with filter.deckIds).',
        },
        archived: { type: 'boolean', description: 'Search archived notes instead (false).' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: SEARCH_NOTES_MAX_LIMIT,
          description: `Maximum notes returned (default ${SEARCH_NOTES_DEFAULT_LIMIT}).`,
        },
        tzOffsetMinutes: {
          type: 'integer',
          description: 'Minutes east of UTC for day-based criteria (default: this machine).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_weak_cards',
    description:
      'Return the hardest reviewed cards (lapses desc, stability asc, difficulty desc: the ranking of the Trouble cards preset) so AI tools can propose targeted reinforcement drills. Optionally restricted by deck and by a Phase 9 filter (e.g. categories).',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'string', description: 'Optional deck ID filter' },
        limit: { type: 'number', description: 'Maximum cards to return (default 20)' },
        filter: CARD_FILTER_SCHEMA,
        tzOffsetMinutes: {
          type: 'integer',
          description: 'Minutes east of UTC for day-based criteria (default: this machine).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_stats',
    description:
      'Return collection-wide review counts, due counts, AI unreviewed backlog, and Markdown page progress, plus `stats`: the same Phase 11 statistics as the Stats screen (reviews per day with time spent, true retention vs target, due forecast, calendar heatmap with streaks, maturity breakdown), optionally filtered by deck and by a Phase 9 filter (categories, card state, performance).',
    inputSchema: {
      type: 'object',
      properties: {
        deckIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict `stats` to these deck ids (default: every active deck).',
        },
        filter: CARD_FILTER_SCHEMA,
        tzOffsetMinutes: {
          type: 'integer',
          description: 'Minutes east of UTC used for "today" (default: this machine).',
        },
        historyDays: { type: 'integer', minimum: 1, description: 'Reviews-per-day window (30).' },
        forecastDays: { type: 'integer', minimum: 1, description: 'Due forecast window (30).' },
        heatmapDays: { type: 'integer', minimum: 1, description: 'Heatmap window (365).' },
        retentionWindowDays: {
          type: 'integer',
          minimum: 1,
          description: 'True retention window (30).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'propose_package',
    description:
      'Create a schema-validated .flashpkg with AI provenance (reviewed: false) and write it into the linked Inbox/ folder.',
    inputSchema: {
      type: 'object',
      required: ['name', 'language', 'notes'],
      properties: {
        name: { type: 'string' },
        language: { type: 'string' },
        packageId: { type: 'string' },
        noteTypeId: { type: 'string' },
        notes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['fields'],
            properties: {
              id: { type: 'string' },
              fields: { type: 'object' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        pages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['slug', 'title', 'markdown'],
            properties: {
              slug: { type: 'string' },
              title: { type: 'string' },
              markdown: { type: 'string' },
              lang: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
] as const;

type McpToolHandler = (
  args: Record<string, unknown>,
  ctx: McpServerContext,
  now: number,
) => unknown;

interface WeakCardCandidate {
  cardId: string;
  deckId: string;
  deckName: string;
  noteId: string;
  frontPreview: string;
  lapses: number;
  stability: number;
  difficulty: number;
  reps: number;
  state: number;
  lastReviewedAt?: number;
}

function isUnreviewedAiNote(note: Note): boolean {
  return note.provenance.source === 'ai' && !note.provenance.reviewed;
}

function compareByName(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function listDecksTool(
  _args: Record<string, unknown>,
  ctx: McpServerContext,
  now: number,
): unknown {
  const state = resolveState(ctx);
  const decks = [...state.decks.values()]
    .filter((d) => !d.archived)
    .sort(compareByName)
    .map((deck) => {
      let activeNotes = 0;
      let needsReviewCount = 0;
      for (const nId of state.noteIdsByDeck.get(deck.id) ?? new Set<string>()) {
        const n = state.notes.get(nId);
        if (!n || n.archived) continue;
        activeNotes += 1;
        if (isUnreviewedAiNote(n)) needsReviewCount += 1;
      }
      const tzOffsetMinutes = -new Date(now).getTimezoneOffset();
      const queue = buildStudyQueue(state, { deckId: deck.id, nowMs: now, tzOffsetMinutes });
      return {
        id: deck.id,
        name: deck.name,
        language: deck.language,
        noteTypeId: deck.note_type_id,
        noteCount: activeNotes,
        dueCounts: queue.counts,
        needsReviewCount,
      };
    });
  return { decks };
}

function searchNotesTool(
  args: Record<string, unknown>,
  ctx: McpServerContext,
  now: number,
): unknown {
  const state = resolveState(ctx);
  const rawLimit =
    typeof args['limit'] === 'number' && Number.isFinite(args['limit'])
      ? Math.floor(args['limit'])
      : SEARCH_NOTES_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(SEARCH_NOTES_MAX_LIMIT, rawLimit));
  const filter = resolveFilterArg(args['filter'], stringArray(args['deckIds']));
  if (!filter) return { total: 0, notes: [] };
  const { notes, total } = searchNotes(
    state,
    filter,
    { nowMs: now, tzOffsetMinutes: resolveTz(args, now) },
    {
      query: typeof args['query'] === 'string' ? args['query'] : '',
      archived: args['archived'] === true,
      limit,
    },
  );
  return {
    total,
    notes: notes.map((note) => ({
      noteId: note.id,
      deckId: note.deck_id,
      deckName: state.decks.get(note.deck_id)?.name ?? '',
      fields: note.fields,
      tags: note.tags,
      archived: note.archived,
      cardIds: [...(state.cardIdsByNote.get(note.id) ?? [])],
      needsReview: isUnreviewedAiNote(note),
    })),
  };
}

/** A ranked card as a `get_weak_cards` row. */
function toWeakCardRow(state: CollectionState, card: Card): WeakCardCandidate {
  const note = state.notes.get(card.note_id);
  const preview =
    Object.values(note?.fields ?? {})
      .find((v) => v.trim().length > 0)
      ?.slice(0, 120) ?? '';
  return {
    cardId: card.id,
    deckId: card.deck_id,
    deckName: state.decks.get(card.deck_id)?.name ?? '',
    noteId: card.note_id,
    frontPreview: preview,
    lapses: card.schedule.lapses,
    stability: Number(card.schedule.stability.toFixed(4)),
    difficulty: Number(card.schedule.difficulty.toFixed(4)),
    reps: card.schedule.reps,
    state: card.schedule.state,
    ...(card.last_reviewed_at !== undefined ? { lastReviewedAt: card.last_reviewed_at } : {}),
  };
}

function getWeakCardsTool(
  args: Record<string, unknown>,
  ctx: McpServerContext,
  now: number,
): unknown {
  const state = resolveState(ctx);
  const deckFilter = typeof args['deckId'] === 'string' ? args['deckId'] : undefined;
  const rawLimit = typeof args['limit'] === 'number' ? Math.floor(args['limit']) : 20;
  const limit = Math.max(1, Math.min(200, rawLimit));
  const filter = resolveFilterArg(
    args['filter'],
    deckFilter === undefined ? undefined : [deckFilter],
  );
  if (!filter) return { cards: [] };

  // The core `hardest` criterion ranks with `compareHardestCards` (lapses desc, stability asc,
  // difficulty desc, id) and skips unreviewed cards: the Trouble cards / Stats ordering. A
  // filter's own `hardest` still caps the result.
  const hardest = Math.min(limit, filter.performance?.hardest ?? limit);
  const ranked = filterCards(
    state,
    { ...filter, performance: { ...filter.performance, hardest } },
    { nowMs: now, tzOffsetMinutes: resolveTz(args, now) },
  );
  return { cards: ranked.map((card) => toWeakCardRow(state, card)) };
}

/** Active deck / note counts and read pages for the legacy `get_stats` fields. */
function countCollectionContent(state: CollectionState): {
  activeDecks: number;
  activeNotes: number;
  needsReviewNotes: number;
  pagesRead: number;
} {
  let activeDecks = 0;
  for (const d of state.decks.values()) {
    if (!d.archived) activeDecks += 1;
  }
  let activeNotes = 0;
  let needsReviewNotes = 0;
  for (const n of state.notes.values()) {
    if (n.archived) continue;
    activeNotes += 1;
    if (isUnreviewedAiNote(n)) needsReviewNotes += 1;
  }
  let pagesRead = 0;
  for (const p of state.pages.values()) {
    if (p.read_at !== undefined) pagesRead += 1;
  }
  return { activeDecks, activeNotes, needsReviewNotes, pagesRead };
}

const STATS_WINDOW_KEYS = [
  'historyDays',
  'forecastDays',
  'heatmapDays',
  'retentionWindowDays',
] as const;

function getStatsTool(args: Record<string, unknown>, ctx: McpServerContext, now: number): unknown {
  const state = resolveState(ctx);
  const { activeDecks, activeNotes, needsReviewNotes, pagesRead } = countCollectionContent(state);

  const tzOffsetMinutes = resolveTz(args, now);
  const queue = buildStudyQueue(state, { nowMs: now, tzOffsetMinutes });

  const statsOptions: CollectionStatsOptions = { nowMs: now, tzOffsetMinutes };
  for (const key of STATS_WINDOW_KEYS) {
    const v = args[key];
    if (typeof v === 'number' && Number.isFinite(v)) statsOptions[key] = v;
  }
  // The collection-wide legacy fields come from the same core stats module as `stats`, so the
  // two always agree (archived notes/decks and undone reviews are excluded from both).
  const collectionStats = computeCollectionStats(state, statsOptions);
  // `deckIds` and the Phase 9 `filter` compile through the core `cardFilterToStatsFilter`
  // bridge, so a filtered `stats` covers exactly the cards Browse / Study select for it.
  const deckIds = stringArray(args['deckIds']);
  let stats = collectionStats;
  if (deckIds !== undefined || args['filter'] !== undefined) {
    const filter = resolveFilterArg(args['filter'], deckIds);
    stats = computeCollectionStats(state, {
      ...statsOptions,
      filter: filter
        ? cardFilterToStatsFilter(state, filter, { nowMs: now, tzOffsetMinutes })
        : { deckIds: [] },
    });
  }
  const { totals } = collectionStats;

  return {
    totalDecks: activeDecks,
    totalNotes: activeNotes,
    totalCards: totals.cards,
    totalReviews: totals.reviews,
    retentionEstimate:
      totals.reviews > 0 ? Number((totals.passed / totals.reviews).toFixed(4)) : null,
    needsReviewNotes,
    totalPages: state.pages.size,
    pagesRead,
    dueCounts: queue.counts,
    stats,
  };
}

function toProposedNote(item: unknown, idx: number, now: number): BuildDeckNoteInput {
  const obj = asRecord(item);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(obj['fields']))) {
    if (typeof v === 'string') fields[k] = v;
  }
  const tags = stringArray(obj['tags']);
  return {
    ...(typeof obj['id'] === 'string' ? { id: obj['id'] } : { id: `ai-${now}-${idx + 1}` }),
    fields,
    ...(tags ? { tags } : {}),
  };
}

function toProposedPage(item: unknown, idx: number): BuildPageSpec {
  const obj = asRecord(item);
  const tags = stringArray(obj['tags']);
  return {
    slug: typeof obj['slug'] === 'string' ? obj['slug'] : `ai-page-${idx + 1}`,
    title: typeof obj['title'] === 'string' ? obj['title'] : `AI Page ${idx + 1}`,
    markdown: typeof obj['markdown'] === 'string' ? obj['markdown'] : '',
    ...(typeof obj['lang'] === 'string' ? { lang: obj['lang'] } : {}),
    ...(tags ? { tags } : {}),
  };
}

function packageSlug(name: string): string {
  // The first replace collapses every run to a single '-', so trimming one is enough.
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'proposed';
}

function proposePackageTool(
  args: Record<string, unknown>,
  ctx: McpServerContext,
  now: number,
): unknown {
  const name = trimmedString(args['name']);
  const language = trimmedString(args['language']);
  const rawNotes = Array.isArray(args['notes']) ? args['notes'] : [];
  const rawPages = Array.isArray(args['pages']) ? args['pages'] : [];
  if (!name || !language || (rawNotes.length === 0 && rawPages.length === 0)) {
    throw new Error('propose_package requires non-empty name, language, and notes or pages.');
  }

  const notes = rawNotes.map((item, idx) => toProposedNote(item, idx, now));
  const pages = rawPages.map((item, idx) => toProposedPage(item, idx));
  const noteTypeId = typeof args['noteTypeId'] === 'string' ? args['noteTypeId'] : undefined;

  const built = buildPackageFromSpec({
    ...(typeof args['packageId'] === 'string' ? { packageId: args['packageId'] } : {}),
    name,
    version: '1.0.0',
    aiProvenance: true,
    nowMs: now,
    decks:
      notes.length > 0
        ? [{ name, language, ...(noteTypeId !== undefined ? { noteTypeId } : {}), notes }]
        : [],
    pages,
  });

  const filename = `${packageSlug(name)}-${now}.flashpkg`;
  let writtenPath: string | undefined;
  if (ctx.inboxDir) {
    mkdirSync(ctx.inboxDir, { recursive: true });
    writtenPath = join(ctx.inboxDir, filename);
    writeFileSync(writtenPath, built.bytes);
  }

  return {
    packageId: built.packageId,
    filename,
    ...(writtenPath ? { path: writtenPath } : {}),
    bytesLength: built.bytes.byteLength,
    notesProposed: built.notesCount,
    pagesProposed: built.pagesCount,
    aiProvenance: true,
  };
}

const MCP_TOOL_HANDLERS: ReadonlyMap<string, McpToolHandler> = new Map<string, McpToolHandler>([
  ['list_decks', listDecksTool],
  ['search_notes', searchNotesTool],
  ['get_weak_cards', getWeakCardsTool],
  ['get_stats', getStatsTool],
  ['propose_package', proposePackageTool],
]);

export function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpServerContext,
): unknown {
  const now = ctx.nowMs ? ctx.nowMs() : Date.now();
  const handler = MCP_TOOL_HANDLERS.get(toolName);
  if (!handler) throw new Error(`Unknown MCP tool: ${toolName}`);
  return handler(args, ctx, now);
}

type McpMethodOutcome = { result: unknown } | { error: McpProtocolError };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `tools/call`: an unknown tool is a protocol error (-32602); a failing tool is a result with
 * `isError: true`, so the model sees the message and can retry with corrected arguments.
 */
function callTool(params: Record<string, unknown>, ctx: McpServerContext): McpMethodOutcome {
  const toolName = typeof params['name'] === 'string' ? params['name'] : '';
  if (!MCP_TOOL_HANDLERS.has(toolName)) {
    return { error: { code: JSONRPC_INVALID_PARAMS, message: `Unknown tool: ${toolName}` } };
  }
  try {
    const data = executeMcpTool(toolName, asRecord(params['arguments']), ctx);
    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
        isError: false,
      },
    };
  } catch (err) {
    return { result: { content: [{ type: 'text', text: errorMessage(err) }], isError: true } };
  }
}

function dispatchMcpMethod(req: JsonRpcRequest, ctx: McpServerContext): McpMethodOutcome {
  switch (req.method) {
    case 'initialize':
      return { result: legacyInitializeResult(req.params) };
    case 'server/discover':
      return { result: discoverResult() };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: MCP_TOOLS } };
    case 'tools/call':
      return callTool(req.params ?? {}, ctx);
    default:
      return { error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

/**
 * Handles a single JSON-RPC 2.0 MCP request (returns `null` for notifications: any message
 * without an `id`).
 *
 * Serves both protocol eras (see `mcp-protocol.ts`): a request whose `params._meta` names a
 * protocol version is answered in the modern stateless form, anything else keeps the legacy
 * `initialize`-handshake behavior.
 */
export function handleMcpRequest(
  req: JsonRpcRequest,
  ctx: McpServerContext,
): JsonRpcResponse | null {
  // JSON-RPC 2.0: a message without an `id` is a notification and never gets a reply. Every
  // method served here is a request, so a notification (`notifications/*` or a request method
  // sent without an id) is ignored rather than run.
  if (req.id === undefined) return null;
  const id = req.id;
  const era = readRequestEra(req.params);
  if (era.era === 'error') return { jsonrpc: '2.0', id, error: era.error };

  let outcome: McpMethodOutcome;
  try {
    outcome = dispatchMcpMethod(req, ctx);
  } catch (err) {
    outcome = { error: { code: -32603, message: errorMessage(err) } };
  }
  if ('error' in outcome) return { jsonrpc: '2.0', id, error: outcome.error };
  return {
    jsonrpc: '2.0',
    id,
    result: era.era === 'modern' ? withModernEnvelope(outcome.result) : outcome.result,
  };
}

export async function runMcpStdioServer(ctx: McpServerContext): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errResp: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
      process.stdout.write(JSON.stringify(errResp) + '\n');
      continue;
    }
    const resp = handleMcpRequest(req, ctx);
    if (resp) {
      process.stdout.write(JSON.stringify(resp) + '\n');
    }
  }
}
