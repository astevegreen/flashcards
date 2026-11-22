import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as process from 'node:process';
import { createInterface } from 'node:readline';
import {
  applyEvents,
  buildStudyQueue,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type CollectionState,
  type FlashEvent,
} from '@flash/core';
import { importFlashpkg } from '@flash/core/flashpkg';
import { deserializeCollectionState } from '@flash/core/snapshot';
import { decodeEventsSegment, decodeSyncSnapshot, SYNC_V1_PREFIX } from '@flash/core/sync';
import {
  buildPackageFromSpec,
  type BuildDeckNoteInput,
  type BuildPageSpec,
} from './commands/build.ts';

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

function resolveState(ctx: McpServerContext): CollectionState {
  if (ctx.state) return ctx.state;
  if (ctx.mirrorPath) return loadCollectionFromMirror(ctx.mirrorPath);
  return createEmptyState();
}

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
    name: 'get_weak_cards',
    description:
      'Return cards with the highest lapses or lowest FSRS stability so AI tools can propose targeted reinforcement drills.',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'string', description: 'Optional deck ID filter' },
        limit: { type: 'number', description: 'Maximum cards to return (default 20)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_stats',
    description:
      'Return collection-wide review counts, due counts, AI unreviewed backlog, and Markdown page progress.',
    inputSchema: {
      type: 'object',
      properties: {},
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

export function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpServerContext,
): unknown {
  const now = ctx.nowMs ? ctx.nowMs() : Date.now();

  if (toolName === 'list_decks') {
    const state = resolveState(ctx);
    const decks = [...state.decks.values()]
      .filter((d) => !d.archived)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((deck) => {
        const noteIds = state.noteIdsByDeck.get(deck.id) ?? new Set<string>();
        let activeNotes = 0;
        let needsReviewCount = 0;
        for (const nId of noteIds) {
          const n = state.notes.get(nId);
          if (!n || n.archived) continue;
          activeNotes += 1;
          if (n.provenance.source === 'ai' && !n.provenance.reviewed) {
            needsReviewCount += 1;
          }
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

  if (toolName === 'get_weak_cards') {
    const state = resolveState(ctx);
    const deckFilter = typeof args['deckId'] === 'string' ? args['deckId'] : undefined;
    const rawLimit = typeof args['limit'] === 'number' ? Math.floor(args['limit']) : 20;
    const limit = Math.max(1, Math.min(200, rawLimit));

    const candidates: Array<{
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
    }> = [];

    for (const card of state.cards.values()) {
      if (deckFilter && card.deck_id !== deckFilter) continue;
      const deck = state.decks.get(card.deck_id);
      const note = state.notes.get(card.note_id);
      if (!deck || deck.archived || !note || note.archived) continue;
      if (card.schedule.reps === 0 && card.schedule.lapses === 0) continue;

      const preview =
        Object.values(note.fields)
          .find((v) => v.trim().length > 0)
          ?.slice(0, 120) ?? '';
      candidates.push({
        cardId: card.id,
        deckId: deck.id,
        deckName: deck.name,
        noteId: note.id,
        frontPreview: preview,
        lapses: card.schedule.lapses,
        stability: Number(card.schedule.stability.toFixed(4)),
        difficulty: Number(card.schedule.difficulty.toFixed(4)),
        reps: card.schedule.reps,
        state: card.schedule.state,
        ...(card.last_reviewed_at !== undefined ? { lastReviewedAt: card.last_reviewed_at } : {}),
      });
    }

    candidates.sort(
      (a, b) =>
        b.lapses - a.lapses ||
        a.stability - b.stability ||
        b.difficulty - a.difficulty ||
        (a.cardId < b.cardId ? -1 : 1),
    );

    return { cards: candidates.slice(0, limit) };
  }

  if (toolName === 'get_stats') {
    const state = resolveState(ctx);
    let activeDecks = 0;
    for (const d of state.decks.values()) {
      if (!d.archived) activeDecks += 1;
    }
    let activeNotes = 0;
    let needsReviewNotes = 0;
    for (const n of state.notes.values()) {
      if (n.archived) continue;
      activeNotes += 1;
      if (n.provenance.source === 'ai' && !n.provenance.reviewed) {
        needsReviewNotes += 1;
      }
    }

    let totalActiveReviews = 0;
    let passedReviews = 0;
    for (const reviews of state.reviewsByCard.values()) {
      for (const r of reviews) {
        if (state.undoneReviewIds.has(r.review_id)) continue;
        totalActiveReviews += 1;
        if (r.rating >= 2) passedReviews += 1;
      }
    }

    let pagesRead = 0;
    for (const p of state.pages.values()) {
      if (p.read_at !== undefined) pagesRead += 1;
    }

    const tzOffsetMinutes = -new Date(now).getTimezoneOffset();
    const queue = buildStudyQueue(state, { nowMs: now, tzOffsetMinutes });
    return {
      totalDecks: activeDecks,
      totalNotes: activeNotes,
      totalCards: state.cards.size,
      totalReviews: totalActiveReviews,
      retentionEstimate:
        totalActiveReviews > 0 ? Number((passedReviews / totalActiveReviews).toFixed(4)) : null,
      needsReviewNotes,
      totalPages: state.pages.size,
      pagesRead,
      dueCounts: queue.counts,
    };
  }

  if (toolName === 'propose_package') {
    const name = typeof args['name'] === 'string' ? args['name'].trim() : '';
    const language = typeof args['language'] === 'string' ? args['language'].trim() : '';
    const rawNotes = Array.isArray(args['notes']) ? args['notes'] : [];
    const rawPages = Array.isArray(args['pages']) ? args['pages'] : [];
    if (!name || !language || (rawNotes.length === 0 && rawPages.length === 0)) {
      throw new Error('propose_package requires non-empty name, language, and notes or pages.');
    }

    const notes: BuildDeckNoteInput[] = rawNotes.map((item, idx) => {
      const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const fieldsObj = (
        obj['fields'] && typeof obj['fields'] === 'object' ? obj['fields'] : {}
      ) as Record<string, unknown>;
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(fieldsObj)) {
        if (typeof v === 'string') fields[k] = v;
      }
      const tags = Array.isArray(obj['tags'])
        ? obj['tags'].filter((t): t is string => typeof t === 'string')
        : undefined;
      return {
        ...(typeof obj['id'] === 'string' ? { id: obj['id'] } : { id: `ai-${now}-${idx + 1}` }),
        fields,
        ...(tags ? { tags } : {}),
      };
    });

    const pages: BuildPageSpec[] = rawPages.map((item, idx) => {
      const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const tags = Array.isArray(obj['tags'])
        ? obj['tags'].filter((t): t is string => typeof t === 'string')
        : undefined;
      return {
        slug: typeof obj['slug'] === 'string' ? obj['slug'] : `ai-page-${idx + 1}`,
        title: typeof obj['title'] === 'string' ? obj['title'] : `AI Page ${idx + 1}`,
        markdown: typeof obj['markdown'] === 'string' ? obj['markdown'] : '',
        ...(typeof obj['lang'] === 'string' ? { lang: obj['lang'] } : {}),
        ...(tags ? { tags } : {}),
      };
    });

    const built = buildPackageFromSpec({
      ...(typeof args['packageId'] === 'string' ? { packageId: args['packageId'] } : {}),
      name,
      version: '1.0.0',
      aiProvenance: true,
      nowMs: now,
      decks:
        notes.length > 0
          ? [
              {
                name,
                language,
                ...(typeof args['noteTypeId'] === 'string'
                  ? { noteTypeId: args['noteTypeId'] }
                  : {}),
                notes,
              },
            ]
          : [],
      pages,
    });

    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'proposed';
    const filename = `${slug}-${now}.flashpkg`;
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

  throw new Error(`Unknown MCP tool: ${toolName}`);
}

/**
 * Handles a single JSON-RPC 2.0 MCP request (returns `null` for notifications with no `id`).
 */
export function handleMcpRequest(
  req: JsonRpcRequest,
  ctx: McpServerContext,
): JsonRpcResponse | null {
  const id = req.id ?? null;

  if (req.method === 'notifications/initialized' || req.id === undefined) {
    if (req.method === 'notifications/initialized') return null;
  }

  try {
    if (req.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'flashcards-local-mcp', version: '0.1.0' },
        },
      };
    }

    if (req.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS },
      };
    }

    if (req.method === 'tools/call') {
      const params = req.params ?? {};
      const toolName = typeof params['name'] === 'string' ? params['name'] : '';
      const rawArgs =
        params['arguments'] && typeof params['arguments'] === 'object'
          ? (params['arguments'] as Record<string, unknown>)
          : {};
      const data = executeMcpTool(toolName, rawArgs, ctx);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
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
