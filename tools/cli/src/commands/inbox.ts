import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  FLASH_NAMESPACE_UUID,
  uuidv5,
  type CollectionState,
  type KnownEvent,
} from '@flash/core';
import { buildEventsFromCsv } from '@flash/core/csv';
import { exportFlashpkg, importFlashpkg } from '@flash/core/flashpkg';
import { parseMarkdownFrontmatter } from '@flash/core/sources';
import { inferNoteTypeIdForLang } from './build.ts';

export interface InboxProcessOptions {
  outPackagePath?: string;
  aiProvenance?: boolean;
  language?: string;
  nowMs?: number;
  state?: CollectionState;
}

export interface InboxProcessResult {
  processed: string[];
  failed: Array<{ file: string; error: string }>;
  events: KnownEvent[];
  state: CollectionState;
  outPackagePath?: string;
  /** True when the processed files were moved to `Inbox/imported/` (only after a written package). */
  archived: boolean;
}

function uniqueImportedDest(importedDir: string, fileName: string): string {
  const direct = join(importedDir, fileName);
  if (!existsSync(direct)) return direct;
  const ext = extname(fileName);
  const stem = basename(fileName, ext);
  return join(importedDir, `${stem}-${Date.now()}${ext}`);
}

/**
 * Processes an `Inbox/` directory (§10.3 route 2):
 * validates and imports `.flashpkg`, `.csv`, `.tsv`, and `.md` files into a collection state.
 * With `outPackagePath`, it writes the consolidated `.flashpkg` and only then archives the
 * processed inputs to `Inbox/imported/`. Without one, the files stay where they are: the import
 * exists only in the returned state (C27).
 */
export function processInboxFolder(
  inboxDir: string,
  options: InboxProcessOptions = {},
): InboxProcessResult {
  if (!existsSync(inboxDir) || !statSync(inboxDir).isDirectory()) {
    throw new Error(`Inbox directory not found: ${inboxDir}`);
  }

  const nowMs = options.nowMs ?? Date.now();
  const state = options.state ?? createEmptyState();
  const factory = createEventFactory('cli-inbox', 0, createHlcState('cli-inbox', nowMs));
  const mediaBlobs = new Map<string, Uint8Array>();

  const importedDir = join(inboxDir, 'imported');

  const processed: string[] = [];
  const failed: Array<{ file: string; error: string }> = [];
  const allEvents: KnownEvent[] = [];

  const entries = readdirSync(inboxDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const filePath = join(inboxDir, entry.name);
    const ext = extname(entry.name).toLowerCase();

    try {
      if (ext === '.flashpkg') {
        const bytes = readFileSync(filePath);
        const res = importFlashpkg(bytes, state, factory, { nowMs });
        applyEvents(state, res.events);
        allEvents.push(...res.events);
        for (const m of res.extractedMedia) {
          mediaBlobs.set(m.hash.toLowerCase(), m.bytes);
        }
      } else if (ext === '.csv' || ext === '.tsv') {
        const text = readFileSync(filePath, 'utf8');
        const deckName = basename(entry.name, ext);
        const language = options.language ?? 'ko';
        const noteTypeId = inferNoteTypeIdForLang(language);
        const noteType =
          state.noteTypes.get(noteTypeId) ?? state.noteTypes.get(BUILTIN_NOTE_TYPE_IDS.VOCAB_KO);
        if (!noteType) {
          throw new Error(`Missing built-in note type "${noteTypeId}".`);
        }
        const deckId = uuidv5(FLASH_NAMESPACE_UUID, `inbox:deck:${deckName}`);
        const deckEv = factory.create(
          'DeckCreated',
          {
            deck_id: deckId,
            name: deckName,
            note_type_id: noteType.id,
            language,
            source: { kind: 'local_file', uri: filePath, last_synced_at: nowMs },
            created_at: nowMs,
          },
          nowMs,
        );
        const csvRes = buildEventsFromCsv(text, {
          deckId,
          noteType,
          eventFactory: factory,
          delimiter: ext === '.tsv' ? '\t' : ',',
          nowMs,
        });
        if (options.aiProvenance) {
          for (const ev of csvRes.events) {
            if (ev.type === 'NoteUpserted') {
              ev.payload.provenance = { source: 'ai', reviewed: false };
            }
          }
        }
        const batch = [deckEv, ...csvRes.events];
        applyEvents(state, batch);
        allEvents.push(...batch);
      } else if (ext === '.md') {
        const raw = readFileSync(filePath, 'utf8');
        const parsed = parseMarkdownFrontmatter(raw);
        const slug =
          (parsed.slug ?? basename(entry.name, '.md'))
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'page';
        const pageId = parsed.id ?? uuidv5(FLASH_NAMESPACE_UUID, `inbox:page:${slug}`);
        const ev = factory.create(
          'PageUpserted',
          {
            page_id: pageId,
            slug,
            title: parsed.title ?? slug,
            markdown: parsed.body,
            ...(parsed.lang ? { lang: parsed.lang } : {}),
            tags: parsed.tags,
            source: { kind: 'local_file', uri: filePath, last_synced_at: nowMs },
          },
          nowMs,
        );
        applyEvents(state, [ev]);
        allEvents.push(ev);
      } else {
        continue;
      }

      processed.push(entry.name);
    } catch (err) {
      failed.push({
        file: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Created before the write, so `-o Inbox/imported/<name>.flashpkg` keeps working.
  if (options.outPackagePath) mkdirSync(importedDir, { recursive: true });
  if (options.outPackagePath && allEvents.length > 0) {
    const pkgBytes = exportFlashpkg(state, {
      packageId: 'pkg:inbox-collection',
      name: 'Inbox Collection',
      version: '1.0.0',
      ...(mediaBlobs.size > 0 ? { mediaBlobs } : {}),
    });
    // A failed write throws here, before any input has moved.
    writeFileSync(options.outPackagePath, pkgBytes);
  }

  const archived = Boolean(options.outPackagePath) && processed.length > 0;
  if (archived) {
    for (const name of processed) {
      renameSync(join(inboxDir, name), uniqueImportedDest(importedDir, name));
    }
  }

  return {
    processed,
    failed,
    events: allEvents,
    state,
    ...(options.outPackagePath ? { outPackagePath: options.outPackagePath } : {}),
    archived,
  };
}
