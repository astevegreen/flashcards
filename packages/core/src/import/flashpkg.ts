import {
  validateCourses,
  validateLayouts,
  validateNoteTypes,
  validatePackageManifest,
  validatePackageNote,
  type CourseDef,
  type LayoutDef,
  type NoteTypeDef,
  type PackageDeckEntry,
  type PackageManifest,
  type PackageNoteRecord,
  type SchemaValidationError,
} from '@flash/content-schema';
import { unzipSync, zipSync, type Unzipped } from 'fflate';
import type { CollectionState, EventFactory } from '../events/replay.ts';
import type { KnownEvent } from '../events/types.ts';
import { decodeUtf8, deriveNoteId, encodeUtf8, uuidv5, FLASH_NAMESPACE_UUID } from '../ids.ts';

export const FLASHPKG_SECURITY_LIMITS = {
  maxFiles: 10_000,
  maxTotalUncompressedBytes: 100 * 1024 * 1024, // 100 MB
  maxSingleFileBytes: 25 * 1024 * 1024, // 25 MB
  maxCompressedBytes: 50 * 1024 * 1024, // 50 MB
} as const;

export interface FlashpkgExportOptions {
  packageId?: string;
  name?: string;
  version?: string;
  author?: string;
  license?: string;
  /** Optional single deckId to export; omits to export entire collection. */
  deckId?: string;
}

export interface FlashpkgImportResult {
  manifest: PackageManifest;
  events: KnownEvent[];
  decksImported: number;
  notesImported: number;
  upgradedDecks: number;
}

export class FlashpkgSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlashpkgSecurityError';
  }
}

export class FlashpkgValidationError extends Error {
  readonly errors: SchemaValidationError[];
  constructor(message: string, errors: SchemaValidationError[] = []) {
    super(message);
    this.name = 'FlashpkgValidationError';
    this.errors = errors;
  }
}

/** Validates archive entry path against path traversal & unsafe characters (§13). */
export function assertSafeArchivePath(path: string): void {
  if (!path || path.includes('\0')) {
    throw new FlashpkgSecurityError(`Invalid empty or NUL path in archive.`);
  }
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) {
    throw new FlashpkgSecurityError(`Absolute path rejected in archive: "${path}"`);
  }
  if (path.includes('\\')) {
    throw new FlashpkgSecurityError(`Backslash path separator rejected in archive: "${path}"`);
  }
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '..') {
      throw new FlashpkgSecurityError(`Path traversal rejected in archive: "${path}"`);
    }
  }
}

function safeSlug(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/**
 * Exports a single deck or the full collection into a `.flashpkg` zip archive.
 */
export function exportFlashpkg(
  state: CollectionState,
  options: FlashpkgExportOptions = {},
): Uint8Array {
  const targetDecks = [...state.decks.values()].filter(
    (d) => !d.archived && (options.deckId === undefined || d.id === options.deckId),
  );
  targetDecks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const usedNoteTypeIds = new Set<string>();
  const languages = new Set<string>();
  const deckEntries: PackageDeckEntry[] = [];
  const files: Record<string, Uint8Array> = {};

  for (let i = 0; i < targetDecks.length; i++) {
    const deck = targetDecks[i];
    if (!deck) continue;
    usedNoteTypeIds.add(deck.note_type_id);
    if (deck.language) languages.add(deck.language);

    const filePath = `decks/${safeSlug(deck.name, `deck-${i + 1}`)}-${i + 1}.jsonl`;
    deckEntries.push({
      id: deck.id,
      name: deck.name,
      file: filePath,
      note_type_id: deck.note_type_id,
      language: deck.language,
    });

    const deckNotes = [...state.notes.values()]
      .filter((n) => n.deck_id === deck.id && !n.archived)
      .sort((a, b) => a.created_order - b.created_order || (a.id < b.id ? -1 : 1));

    const lines = deckNotes.map((n) => {
      const rec: PackageNoteRecord = {
        id: n.source_key || n.id,
        fields: n.fields,
        tags: n.tags,
        provenance: n.provenance,
      };
      return JSON.stringify(rec);
    });

    files[filePath] = encodeUtf8(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  }

  const noteTypes: NoteTypeDef[] = [];
  const layouts: LayoutDef[] = [];

  for (const ntId of usedNoteTypeIds) {
    const nt = state.noteTypes.get(ntId);
    if (nt) {
      noteTypes.push({
        id: nt.id,
        name: nt.name,
        fields: nt.fields.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          lang: f.lang,
          ...(f.tts !== undefined ? { tts: f.tts } : {}),
          ...(f.sortKey !== undefined ? { sortKey: f.sortKey } : {}),
        })),
      });
    }
    for (const layout of state.layouts.values()) {
      if (layout.note_type_id === ntId) {
        layouts.push({
          id: layout.id,
          note_type_id: layout.note_type_id,
          name: layout.name,
          front_fields: layout.front_fields,
          reveal_steps: layout.reveal_steps,
          answer_mode: layout.answer_mode,
          ...(layout.speak_field !== undefined ? { speak_field: layout.speak_field } : {}),
          hide_furigana_on_front: layout.hide_furigana_on_front,
          enabled: layout.enabled,
        });
      }
    }
  }

  const manifest: PackageManifest = {
    package_id:
      options.packageId ??
      (options.deckId
        ? `pkg:${options.deckId}`
        : `pkg:collection-${uuidv5(FLASH_NAMESPACE_UUID, targetDecks.map((d) => d.id).join(','))}`),
    name:
      options.name ??
      (options.deckId && targetDecks[0] ? targetDecks[0].name : 'Flashcards Backup'),
    version: options.version ?? '1.0.0',
    format_version: 1,
    ...(options.author !== undefined ? { author: options.author } : {}),
    ...(options.license !== undefined ? { license: options.license } : {}),
    languages: [...languages].sort(),
    decks: deckEntries,
  };

  files['manifest.json'] = encodeUtf8(JSON.stringify(manifest, null, 2));
  files['note_types.json'] = encodeUtf8(JSON.stringify(noteTypes, null, 2));
  files['layouts.json'] = encodeUtf8(JSON.stringify(layouts, null, 2));

  if (options.deckId === undefined && state.courses.size > 0) {
    const courses: CourseDef[] = [...state.courses.values()].map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      items: c.items.map((item) => ({
        kind: item.kind,
        ref_id: item.ref_id,
        ...(item.unlocks_after_page_id !== undefined
          ? { unlocks_after_page_id: item.unlocks_after_page_id }
          : {}),
      })),
    }));
    files['courses.json'] = encodeUtf8(JSON.stringify(courses, null, 2));
  }

  return zipSync(files, { level: 6 });
}

function parseJsonFile(files: Unzipped, path: string): unknown {
  const bytes = files[path];
  if (!bytes) {
    throw new FlashpkgValidationError(`Missing required archive file "${path}".`);
  }
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (err) {
    throw new FlashpkgValidationError(
      `Invalid JSON in "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Safely unpacks, validates, and converts a `.flashpkg` archive into events.
 * - Security (§13): blocks path traversal, file-count bombs, and uncompressed size bombs.
 * - Upgrades (§3.4): matches existing decks by `(source.package_id, packageDeckId)` and
 *   notes by `source_key = record.id` so re-importing updates content without losing reviews.
 */
export function importFlashpkg(
  archiveBytes: Uint8Array,
  state: CollectionState,
  eventFactory: EventFactory,
  options?: { nowMs?: number; limits?: Partial<typeof FLASHPKG_SECURITY_LIMITS> },
): FlashpkgImportResult {
  const limits = { ...FLASHPKG_SECURITY_LIMITS, ...options?.limits };
  const nowMs = options?.nowMs ?? Date.now();

  if (archiveBytes.byteLength > limits.maxCompressedBytes) {
    throw new FlashpkgSecurityError(
      `Archive exceeds max compressed size (${limits.maxCompressedBytes} bytes).`,
    );
  }

  let fileCount = 0;
  let totalUncompressed = 0;

  let extracted: Unzipped;
  try {
    extracted = unzipSync(archiveBytes, {
      filter(file) {
        assertSafeArchivePath(file.name);
        fileCount += 1;
        if (fileCount > limits.maxFiles) {
          throw new FlashpkgSecurityError(
            `Archive exceeds maximum file count (${limits.maxFiles}).`,
          );
        }
        if (file.originalSize > limits.maxSingleFileBytes) {
          throw new FlashpkgSecurityError(
            `File "${file.name}" exceeds max single-file size (${limits.maxSingleFileBytes} bytes).`,
          );
        }
        totalUncompressed += file.originalSize;
        if (totalUncompressed > limits.maxTotalUncompressedBytes) {
          throw new FlashpkgSecurityError(
            `Archive exceeds max uncompressed byte limit (${limits.maxTotalUncompressedBytes} bytes).`,
          );
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof FlashpkgSecurityError) throw err;
    throw new FlashpkgValidationError(
      `Failed to unzip .flashpkg archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Secondary verification on actual inflated byte lengths (protects against spoofed zip headers)
  let actualTotal = 0;
  for (const [name, data] of Object.entries(extracted)) {
    assertSafeArchivePath(name);
    if (data.byteLength > limits.maxSingleFileBytes) {
      throw new FlashpkgSecurityError(
        `Inflated file "${name}" exceeds max single-file size (${limits.maxSingleFileBytes} bytes).`,
      );
    }
    actualTotal += data.byteLength;
    if (actualTotal > limits.maxTotalUncompressedBytes) {
      throw new FlashpkgSecurityError(
        `Inflated archive exceeds max uncompressed byte limit (${limits.maxTotalUncompressedBytes} bytes).`,
      );
    }
  }

  const manifestValidation = validatePackageManifest(parseJsonFile(extracted, 'manifest.json'));
  if (!manifestValidation.ok) {
    throw new FlashpkgValidationError('Invalid manifest.json', manifestValidation.errors);
  }
  const manifest = manifestValidation.data;

  const events: KnownEvent[] = [];

  if (extracted['note_types.json']) {
    const ntRes = validateNoteTypes(parseJsonFile(extracted, 'note_types.json'));
    if (!ntRes.ok) {
      throw new FlashpkgValidationError('Invalid note_types.json', ntRes.errors);
    }
    for (const nt of ntRes.data) {
      events.push(
        eventFactory.create(
          'NoteTypeChanged',
          {
            note_type: {
              id: nt.id,
              name: nt.name,
              fields: nt.fields.map((f) => ({
                key: f.key,
                label: f.label ?? f.key,
                kind: f.kind,
                lang: f.lang,
                ...(f.tts !== undefined ? { tts: f.tts } : {}),
                ...(f.sortKey !== undefined ? { sortKey: f.sortKey } : {}),
              })),
            },
          },
          nowMs,
        ),
      );
    }
  }

  if (extracted['layouts.json']) {
    const layoutRes = validateLayouts(parseJsonFile(extracted, 'layouts.json'));
    if (!layoutRes.ok) {
      throw new FlashpkgValidationError('Invalid layouts.json', layoutRes.errors);
    }
    for (const layout of layoutRes.data) {
      events.push(
        eventFactory.create(
          'LayoutChanged',
          {
            layout: {
              id: layout.id,
              note_type_id: layout.note_type_id,
              name: layout.name,
              front_fields: layout.front_fields,
              reveal_steps: layout.reveal_steps,
              answer_mode: layout.answer_mode,
              ...(layout.speak_field !== undefined ? { speak_field: layout.speak_field } : {}),
              hide_furigana_on_front: layout.hide_furigana_on_front,
              enabled: layout.enabled,
            },
          },
          nowMs,
        ),
      );
    }
  }

  if (extracted['courses.json']) {
    const coursesRes = validateCourses(parseJsonFile(extracted, 'courses.json'));
    if (!coursesRes.ok) {
      throw new FlashpkgValidationError('Invalid courses.json', coursesRes.errors);
    }
    for (const course of coursesRes.data) {
      events.push(
        eventFactory.create(
          'CourseChanged',
          {
            course: {
              id: course.id,
              name: course.name,
              ...(course.description !== undefined ? { description: course.description } : {}),
              items: course.items.map((item) => ({
                kind: item.kind,
                ref_id: item.ref_id,
                ...(item.unlocks_after_page_id !== undefined
                  ? { unlocks_after_page_id: item.unlocks_after_page_id }
                  : {}),
              })),
            },
          },
          nowMs,
        ),
      );
    }
  }

  let decksImported = 0;
  let notesImported = 0;
  let upgradedDecks = 0;

  // Build list of deck entries from manifest (or discover decks/*.jsonl if manifest.decks is empty)
  const deckEntries: PackageDeckEntry[] =
    manifest.decks.length > 0
      ? manifest.decks
      : Object.keys(extracted)
          .filter((k) => k.startsWith('decks/') && k.endsWith('.jsonl'))
          .sort()
          .map((file) => {
            const slug = file.slice('decks/'.length, -'.jsonl'.length);
            return {
              id: uuidv5(manifest.package_id, slug),
              name: slug,
              file,
              note_type_id: 'preset:vocab-ko',
            };
          });

  for (const deckEntry of deckEntries) {
    assertSafeArchivePath(deckEntry.file);
    const jsonlBytes = extracted[deckEntry.file];
    if (!jsonlBytes) {
      throw new FlashpkgValidationError(
        `Deck file "${deckEntry.file}" listed in manifest not found.`,
      );
    }

    // Upgrade-safe deck matching:
    // If collection already has a deck from the same package_id with matching deck id (or deterministic id), reuse its deck_id!
    const deterministicDeckId = state.decks.has(deckEntry.id)
      ? deckEntry.id
      : uuidv5(manifest.package_id, deckEntry.id);

    const existingDeck =
      state.decks.get(deckEntry.id) ??
      state.decks.get(deterministicDeckId) ??
      [...state.decks.values()].find(
        (d) => d.source?.package_id === manifest.package_id && d.id === deckEntry.id,
      );

    const targetDeckId = existingDeck ? existingDeck.id : deterministicDeckId;

    if (existingDeck) {
      upgradedDecks += 1;
      events.push(
        eventFactory.create(
          'DeckSettingsChanged',
          {
            deck_id: targetDeckId,
            name: deckEntry.name,
            ...(deckEntry.language !== undefined ? { language: deckEntry.language } : {}),
            archived: false,
          },
          nowMs,
        ),
      );
      events.push(
        eventFactory.create(
          'SourceLinked',
          {
            target_kind: 'deck',
            target_id: targetDeckId,
            source: {
              kind: 'package',
              package_id: manifest.package_id,
              package_version: manifest.version,
              last_synced_at: nowMs,
            },
          },
          nowMs,
        ),
      );
    } else {
      events.push(
        eventFactory.create(
          'DeckCreated',
          {
            deck_id: targetDeckId,
            name: deckEntry.name,
            note_type_id: deckEntry.note_type_id,
            language: deckEntry.language ?? manifest.languages[0] ?? 'en',
            source: {
              kind: 'package',
              package_id: manifest.package_id,
              package_version: manifest.version,
              last_synced_at: nowMs,
            },
            created_at: nowMs,
          },
          nowMs,
        ),
      );
    }
    decksImported += 1;

    const lines = decodeUtf8(jsonlBytes)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let rawRecord: unknown;
      try {
        rawRecord = JSON.parse(line);
      } catch (err) {
        throw new FlashpkgValidationError(
          `Invalid JSON on line ${i + 1} of "${deckEntry.file}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const noteValidation = validatePackageNote(rawRecord);
      if (!noteValidation.ok) {
        throw new FlashpkgValidationError(
          `Invalid note record on line ${i + 1} of "${deckEntry.file}"`,
          noteValidation.errors,
        );
      }
      const rec = noteValidation.data;

      // Upgrade-safe note matching: find existing note in targetDeck by source_key, else derive deterministically
      const existingNote = [...state.notes.values()].find(
        (n) => n.deck_id === targetDeckId && n.source_key === rec.id,
      );
      const noteId = existingNote ? existingNote.id : deriveNoteId(targetDeckId, rec.id);

      events.push(
        eventFactory.create(
          'NoteUpserted',
          {
            note_id: noteId,
            deck_id: targetDeckId,
            source_key: rec.id,
            fields: rec.fields,
            tags: rec.tags,
            provenance: rec.provenance ?? { source: 'import', reviewed: true },
            created_order: i,
          },
          nowMs,
        ),
      );
      notesImported += 1;
    }
  }

  return {
    manifest,
    events,
    decksImported,
    notesImported,
    upgradedDecks,
  };
}
