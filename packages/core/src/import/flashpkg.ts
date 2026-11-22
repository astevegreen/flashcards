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
import { Unzip, UnzipInflate, UnzipPassThrough, zipSync } from 'fflate';
import type { CollectionState, EventFactory } from '../events/replay.ts';
import type { KnownEvent } from '../events/types.ts';
import { decodeUtf8, deriveNoteId, encodeUtf8, uuidv5, FLASH_NAMESPACE_UUID } from '../ids.ts';
import type { Deck, Note, SourceRef } from '../model/types.ts';
import { computeNoteContentHash, sha256Hex } from '../sources/hash.ts';
import { compareCodeUnits } from '../study/queue.ts';
import { normalizeTagList } from '../tags/index.ts';
import {
  normalizeMarkdownPage,
  parseMarkdownFrontmatter,
  type PageNormalizeWarning,
} from '../sources/pages.ts';

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
  /** Optional single page to export (no decks). Mutually exclusive with `deckId`/`courseId`. */
  pageId?: string;
  /** Optional single course to export, with every deck and page it references. */
  courseId?: string;
  /**
   * Optional subset of notes (e.g. one category): only these active notes are exported, under
   * the decks that contain them (narrowed further by `deckId` when both are given). No pages or
   * courses; media is limited to what those notes reference.
   */
  noteIds?: Iterable<string>;
  /** Optional local media blobs keyed by SHA-256 hex to pack under `media/<sha256>.<ext>`. */
  mediaBlobs?: ReadonlyMap<string, Uint8Array>;
}

export interface ExtractedPackageMedia {
  hash: string;
  ext: string;
  mime: string;
  bytes: Uint8Array;
}

export interface FlashpkgImportResult {
  manifest: PackageManifest;
  events: KnownEvent[];
  decksImported: number;
  notesImported: number;
  pagesImported: number;
  upgradedDecks: number;
  extractedMedia: ExtractedPackageMedia[];
  warnings: PageNormalizeWarning[];
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

interface ExportScope {
  /** True for a full-collection export (everything, including all media). */
  full: boolean;
  /** `null` = all non-archived decks. */
  deckIds: Set<string> | null;
  /** `null` = all pages. */
  pageIds: Set<string> | null;
  /** `null` = all non-archived courses. */
  courseIds: Set<string> | null;
  defaultPackageId: (decks: readonly Deck[]) => string;
  defaultName: (decks: readonly Deck[]) => string;
}

/** Scope of a note-subset export (see {@link FlashpkgExportOptions.noteIds}). */
function noteSubsetScope(
  state: CollectionState,
  noteIds: ReadonlySet<string>,
  deckId: string | undefined,
): ExportScope {
  const deckIds = new Set<string>();
  for (const id of noteIds) {
    const note = state.notes.get(id);
    if (note && !note.archived && (deckId === undefined || note.deck_id === deckId)) {
      deckIds.add(note.deck_id);
    }
  }
  return {
    full: false,
    deckIds,
    pageIds: new Set(),
    courseIds: new Set(),
    defaultPackageId: (decks) =>
      `pkg:notes-${uuidv5(FLASH_NAMESPACE_UUID, [...decks.map((d) => d.id), ...[...noteIds].sort(compareCodeUnits)].join(','))}`,
    defaultName: (decks) => decks[0]?.name ?? 'Flashcards Export',
  };
}

/** An active note inside the optional note subset. */
function isExportedNote(note: Note, subset: ReadonlySet<string> | undefined): boolean {
  return !note.archived && (subset === undefined || subset.has(note.id));
}

function resolveExportScope(
  state: CollectionState,
  options: FlashpkgExportOptions,
  noteSubset: ReadonlySet<string> | undefined,
): ExportScope {
  if (noteSubset !== undefined) return noteSubsetScope(state, noteSubset, options.deckId);
  if (options.courseId !== undefined) {
    const course = state.courses.get(options.courseId);
    const deckIds = new Set<string>();
    const pageIds = new Set<string>();
    for (const item of course?.items ?? []) {
      if (item.kind === 'deck') deckIds.add(item.ref_id);
      else pageIds.add(item.ref_id);
      if (item.unlocks_after_page_id !== undefined) pageIds.add(item.unlocks_after_page_id);
    }
    return {
      full: false,
      deckIds,
      pageIds,
      courseIds: new Set(course ? [course.id] : []),
      defaultPackageId: () => `pkg:course-${options.courseId}`,
      defaultName: () => course?.name ?? 'Course',
    };
  }
  if (options.pageId !== undefined) {
    const page = state.pages.get(options.pageId);
    return {
      full: false,
      deckIds: new Set(),
      pageIds: new Set(page ? [page.id] : []),
      courseIds: new Set(),
      defaultPackageId: () => `pkg:page-${options.pageId}`,
      defaultName: () => page?.title ?? 'Page',
    };
  }
  if (options.deckId !== undefined) {
    const deckId = options.deckId;
    return {
      full: false,
      deckIds: new Set([deckId]),
      pageIds: new Set(),
      courseIds: new Set(),
      defaultPackageId: () => `pkg:${deckId}`,
      defaultName: (decks) => decks[0]?.name ?? 'Flashcards Backup',
    };
  }
  return {
    full: true,
    deckIds: null,
    pageIds: null,
    courseIds: null,
    defaultPackageId: (decks) =>
      `pkg:collection-${uuidv5(FLASH_NAMESPACE_UUID, decks.map((d) => d.id).join(','))}`,
    defaultName: () => 'Flashcards Backup',
  };
}

/**
 * Exports a single deck, page, course (with its decks and pages), or the full collection
 * into a `.flashpkg` zip archive.
 */
export function exportFlashpkg(
  state: CollectionState,
  options: FlashpkgExportOptions = {},
): Uint8Array {
  const noteSubset = options.noteIds === undefined ? undefined : new Set(options.noteIds);
  const scope = resolveExportScope(state, options, noteSubset);
  const targetDecks = [...state.decks.values()].filter(
    (d) => !d.archived && (scope.deckIds === null || scope.deckIds.has(d.id)),
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
      .filter((n) => n.deck_id === deck.id && isExportedNote(n, noteSubset))
      .sort((a, b) => a.created_order - b.created_order || (a.id < b.id ? -1 : 1));

    const lines = deckNotes.map((n) => {
      const rec: PackageNoteRecord = {
        id: n.source_key || n.id,
        fields: n.fields,
        // Categories travel as note tags (NFC); `importFlashpkg` reads them back unchanged.
        tags: normalizeTagList(n.tags),
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
          ...(layout.speak_on !== undefined ? { speak_on: layout.speak_on } : {}),
          hide_furigana_on_front: layout.hide_furigana_on_front,
          enabled: layout.enabled,
          ...(layout.cloze_typed !== undefined ? { cloze_typed: layout.cloze_typed } : {}),
          ...(layout.answer_field !== undefined ? { answer_field: layout.answer_field } : {}),
        });
      }
    }
  }

  const manifest: PackageManifest = {
    package_id: options.packageId ?? scope.defaultPackageId(targetDecks),
    name: options.name ?? scope.defaultName(targetDecks),
    version: options.version ?? '1.0.0',
    format_version: 1,
    ...(options.author !== undefined ? { author: options.author } : {}),
    ...(options.license !== undefined ? { license: options.license } : {}),
    languages: [...languages].sort(),
    decks: deckEntries,
    ...(noteSubset === undefined ? {} : { subset: true }),
  };

  files['manifest.json'] = encodeUtf8(JSON.stringify(manifest, null, 2));
  files['note_types.json'] = encodeUtf8(JSON.stringify(noteTypes, null, 2));
  files['layouts.json'] = encodeUtf8(JSON.stringify(layouts, null, 2));

  const exportedCourses = [...state.courses.values()]
    .filter((c) => !c.archived && (scope.courseIds === null || scope.courseIds.has(c.id)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (exportedCourses.length > 0) {
    const courses: CourseDef[] = exportedCourses.map((c) => ({
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

  // Pack Markdown Pages (`pages/<slug>.md`) on full collection backup
  const exportedPages = [...state.pages.values()]
    .filter((p) => scope.pageIds === null || scope.pageIds.has(p.id))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const usedSlugs = new Set<string>();
  for (const page of exportedPages) {
    let slug = safeSlug(page.slug || page.title, 'page');
    let suffix = 2;
    while (usedSlugs.has(slug)) {
      slug = `${safeSlug(page.slug || page.title, 'page')}-${suffix}`;
      suffix += 1;
    }
    usedSlugs.add(slug);
    const fmLines = [
      '---',
      `id: ${JSON.stringify(page.id)}`,
      `slug: ${JSON.stringify(page.slug)}`,
      `title: ${JSON.stringify(page.title)}`,
      ...(page.lang ? [`lang: ${JSON.stringify(page.lang)}`] : []),
      ...(page.tags.length > 0
        ? [`tags: [${page.tags.map((t) => JSON.stringify(t)).join(', ')}]`]
        : []),
      '---',
      '',
    ];
    files[`pages/${slug}.md`] = encodeUtf8(fmLines.join('\n') + page.markdown + '\n');
  }

  // Pack media/<sha256>.<ext> blobs when provided
  if (options.mediaBlobs && options.mediaBlobs.size > 0) {
    const referencedHashes = new Set<string>();
    if (!scope.full) {
      const mediaRe = /media:([0-9a-f]{64})/gi;
      const collect = (val: string) => {
        let m: RegExpExecArray | null;
        while ((m = mediaRe.exec(val)) !== null) {
          if (m[1]) referencedHashes.add(m[1].toLowerCase());
        }
      };
      const deckIdSet = new Set(targetDecks.map((d) => d.id));
      for (const note of state.notes.values()) {
        if (!deckIdSet.has(note.deck_id) || !isExportedNote(note, noteSubset)) continue;
        for (const val of Object.values(note.fields)) collect(val);
      }
      for (const page of exportedPages) collect(page.markdown);
    }

    for (const [hash, entry] of state.media.entries()) {
      const normHash = hash.toLowerCase();
      if (!scope.full && !referencedHashes.has(normHash)) continue;
      const blob = options.mediaBlobs.get(normHash) ?? options.mediaBlobs.get(hash);
      if (!blob) continue;
      const ext = entry.ext.toLowerCase().replace(/^\./, '');
      if (!SAFE_MEDIA_MIME_BY_EXT[ext]) continue;
      files[`media/${normHash}.${ext}`] = blob;
    }
  }

  return zipSync(files, { level: 6 });
}

function parseJsonFile(files: Map<string, Uint8Array>, path: string): unknown {
  const bytes = files.get(path);
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

function concatChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Streaming, chunked zip extractor that enforces path-traversal, file-count, and actual inflated
 * byte caps mid-stream so zip bombs with spoofed headers abort before exhausting memory (§13).
 */
function safeUnzipArchive(
  archiveBytes: Uint8Array,
  limits: {
    maxFiles: number;
    maxTotalUncompressedBytes: number;
    maxSingleFileBytes: number;
    maxCompressedBytes: number;
  },
): Map<string, Uint8Array> {
  if (archiveBytes.byteLength > limits.maxCompressedBytes) {
    throw new FlashpkgSecurityError(
      `Archive exceeds max compressed size (${limits.maxCompressedBytes} bytes).`,
    );
  }

  const extracted = new Map<string, Uint8Array>();
  let fileCount = 0;
  let declaredTotal = 0;
  let actualTotal = 0;
  let streamError: Error | null = null;

  const unzipper = new Unzip((file) => {
    if (streamError) return;
    try {
      assertSafeArchivePath(file.name);
      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw new FlashpkgSecurityError(`Archive exceeds maximum file count (${limits.maxFiles}).`);
      }
      if (file.originalSize !== undefined && file.originalSize > limits.maxSingleFileBytes) {
        throw new FlashpkgSecurityError(
          `File "${file.name}" exceeds max single-file size (${limits.maxSingleFileBytes} bytes).`,
        );
      }
      if (file.originalSize !== undefined) {
        declaredTotal += file.originalSize;
        if (declaredTotal > limits.maxTotalUncompressedBytes) {
          throw new FlashpkgSecurityError(
            `Archive exceeds max uncompressed byte limit (${limits.maxTotalUncompressedBytes} bytes).`,
          );
        }
      }

      const chunks: Uint8Array[] = [];
      let fileBytes = 0;

      file.ondata = (err, chunk, final) => {
        if (streamError) return;
        if (err) {
          streamError = new FlashpkgValidationError(
            `Failed to inflate "${file.name}": ${err.message}`,
          );
          return;
        }
        if (chunk.byteLength > 0) {
          fileBytes += chunk.byteLength;
          if (fileBytes > limits.maxSingleFileBytes) {
            streamError = new FlashpkgSecurityError(
              `Inflated file "${file.name}" exceeds max single-file size (${limits.maxSingleFileBytes} bytes).`,
            );
            return;
          }
          actualTotal += chunk.byteLength;
          if (actualTotal > limits.maxTotalUncompressedBytes) {
            streamError = new FlashpkgSecurityError(
              `Inflated archive exceeds max uncompressed byte limit (${limits.maxTotalUncompressedBytes} bytes).`,
            );
            return;
          }
          chunks.push(chunk);
        }
        if (final) {
          extracted.set(file.name, concatChunks(chunks, fileBytes));
        }
      };

      file.start();
    } catch (err) {
      streamError = err instanceof Error ? err : new Error(String(err));
    }
  });

  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);

  const CHUNK_SIZE = 4096;
  try {
    for (let offset = 0; offset < archiveBytes.byteLength; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, archiveBytes.byteLength);
      const isFinal = end >= archiveBytes.byteLength;
      unzipper.push(archiveBytes.subarray(offset, end), isFinal);
      if (streamError) {
        throw streamError;
      }
    }
    if (archiveBytes.byteLength === 0) {
      throw new FlashpkgValidationError('Empty .flashpkg archive.');
    }
  } catch (err) {
    if (streamError) throw streamError;
    if (err instanceof FlashpkgSecurityError || err instanceof FlashpkgValidationError) throw err;
    throw new FlashpkgValidationError(
      `Failed to unzip .flashpkg archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return extracted;
}

const SAFE_MEDIA_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};

/**
 * Events for re-importing into a deck that already exists. A full package renames, unarchives and
 * links the deck to itself. A subset package (`manifest.subset`, e.g. one exported category)
 * only unarchives it: the deck keeps its own name and source, since the package holds just part
 * of its notes.
 */
function upgradeExistingDeckEvents(
  eventFactory: EventFactory,
  input: {
    deckId: string;
    entry: PackageDeckEntry;
    source: SourceRef;
    subset: boolean;
    nowMs: number;
  },
): KnownEvent[] {
  const { deckId, entry, source, nowMs } = input;
  if (input.subset) {
    return [
      eventFactory.create('DeckSettingsChanged', { deck_id: deckId, archived: false }, nowMs),
    ];
  }
  return [
    eventFactory.create(
      'DeckSettingsChanged',
      {
        deck_id: deckId,
        name: entry.name,
        ...(entry.language === undefined ? {} : { language: entry.language }),
        archived: false,
      },
      nowMs,
    ),
    eventFactory.create('SourceLinked', { target_kind: 'deck', target_id: deckId, source }, nowMs),
  ];
}

/**
 * Safely unpacks, validates, and converts a `.flashpkg` archive into events.
 * - Security (§13): blocks path traversal, file-count bombs, and uncompressed size bombs (including spoofed headers).
 * - Upgrades (§3.4): matches existing decks by `(source.package_id, packageDeckId)` and
 *   notes by `source_key = record.id` so re-importing updates content without losing reviews.
 */
export function importFlashpkg(
  archiveBytes: Uint8Array,
  state: CollectionState,
  eventFactory: EventFactory,
  options?: {
    nowMs?: number;
    limits?: Partial<typeof FLASHPKG_SECURITY_LIMITS>;
    sourceOverride?: Partial<SourceRef>;
    archiveRemovedOnUpgrade?: boolean;
  },
): FlashpkgImportResult {
  const limits = { ...FLASHPKG_SECURITY_LIMITS, ...options?.limits };
  const nowMs = options?.nowMs ?? Date.now();
  const extracted = safeUnzipArchive(archiveBytes, limits);

  const manifestValidation = validatePackageManifest(parseJsonFile(extracted, 'manifest.json'));
  if (!manifestValidation.ok) {
    throw new FlashpkgValidationError('Invalid manifest.json', manifestValidation.errors);
  }
  const manifest = manifestValidation.data;
  const subset = manifest.subset === true;
  const baseSource: SourceRef = {
    kind: options?.sourceOverride?.kind ?? 'package',
    ...(options?.sourceOverride?.uri !== undefined ? { uri: options.sourceOverride.uri } : {}),
    ...(options?.sourceOverride?.external_id !== undefined
      ? { external_id: options.sourceOverride.external_id }
      : {}),
    package_id: manifest.package_id,
    package_version: manifest.version,
    last_synced_at: nowMs,
  };

  const events: KnownEvent[] = [];
  const extractedMedia: ExtractedPackageMedia[] = [];
  const warnings: PageNormalizeWarning[] = [];
  let firstImportedNoteTypeId: string | undefined;

  if (extracted.has('note_types.json')) {
    const ntRes = validateNoteTypes(parseJsonFile(extracted, 'note_types.json'));
    if (!ntRes.ok) {
      throw new FlashpkgValidationError('Invalid note_types.json', ntRes.errors);
    }
    firstImportedNoteTypeId = ntRes.data[0]?.id;
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

  if (extracted.has('layouts.json')) {
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
              ...(layout.speak_on !== undefined ? { speak_on: layout.speak_on } : {}),
              hide_furigana_on_front: layout.hide_furigana_on_front,
              enabled: layout.enabled,
              ...(layout.cloze_typed !== undefined ? { cloze_typed: layout.cloze_typed } : {}),
              ...(layout.answer_field !== undefined ? { answer_field: layout.answer_field } : {}),
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
  const deckIdMap = new Map<string, string>();
  const pageIdMap = new Map<string, string>();

  // Build list of deck entries from manifest (or discover decks/*.jsonl if manifest.decks is empty)
  const deckEntries: PackageDeckEntry[] =
    manifest.decks.length > 0
      ? manifest.decks
      : [...extracted.keys()]
          .filter((k) => k.startsWith('decks/') && k.endsWith('.jsonl'))
          .sort()
          .map((file) => {
            const slug = file.slice('decks/'.length, -'.jsonl'.length);
            return {
              id: uuidv5(manifest.package_id, slug),
              name: slug,
              file,
              note_type_id: firstImportedNoteTypeId ?? 'preset:vocab-ko',
            };
          });

  for (const deckEntry of deckEntries) {
    assertSafeArchivePath(deckEntry.file);
    const jsonlBytes = extracted.get(deckEntry.file);
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
    deckIdMap.set(deckEntry.id, targetDeckId);

    if (existingDeck) {
      upgradedDecks += 1;
      events.push(
        ...upgradeExistingDeckEvents(eventFactory, {
          deckId: targetDeckId,
          entry: deckEntry,
          source: baseSource,
          subset,
          nowMs,
        }),
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
            source: baseSource,
            created_at: nowMs,
          },
          nowMs,
        ),
      );
    }
    decksImported += 1;

    // Pre-index existing notes for this deck by source_key for O(1) upgrade matching
    const existingDeckNotes: Note[] = [];
    const existingNotesBySourceKey = new Map<string, Note>();
    for (const note of state.notes.values()) {
      if (note.deck_id === targetDeckId) {
        existingDeckNotes.push(note);
        if (note.source_key) {
          existingNotesBySourceKey.set(note.source_key, note);
        }
      }
    }

    const lines = decodeUtf8(jsonlBytes)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const seenNoteIds = new Set<string>();

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
      const recTags = normalizeTagList(rec.tags);

      // Upgrade-safe note matching: find existing note in targetDeck by source_key, else derive deterministically
      const existingNote = existingNotesBySourceKey.get(rec.id);
      const noteId = existingNote ? existingNote.id : deriveNoteId(targetDeckId, rec.id);
      seenNoteIds.add(noteId);

      if (existingNote) {
        const prevHash = computeNoteContentHash(existingNote.fields, existingNote.tags);
        const nextHash = computeNoteContentHash(rec.fields, recTags);
        if (existingNote.archived) {
          events.push(eventFactory.create('NoteRestored', { note_id: noteId }, nowMs));
        }
        if (prevHash !== nextHash) {
          events.push(
            eventFactory.create(
              'NoteUpserted',
              {
                note_id: noteId,
                deck_id: targetDeckId,
                source_key: rec.id,
                fields: rec.fields,
                tags: recTags,
                provenance: rec.provenance ?? { source: 'import', reviewed: true },
                created_order: i,
              },
              nowMs,
            ),
          );
        }
      } else {
        events.push(
          eventFactory.create(
            'NoteUpserted',
            {
              note_id: noteId,
              deck_id: targetDeckId,
              source_key: rec.id,
              fields: rec.fields,
              tags: recTags,
              provenance: rec.provenance ?? { source: 'import', reviewed: true },
              created_order: i,
            },
            nowMs,
          ),
        );
      }
      notesImported += 1;
    }

    // Soft-archive notes removed in an upgraded package version when requested (preserves reviews)
    // A subset package (one category) never archives the deck's other notes.
    if (existingDeck && options?.archiveRemovedOnUpgrade && !subset) {
      for (const existing of existingDeckNotes) {
        if (!existing.archived && !seenNoteIds.has(existing.id)) {
          events.push(eventFactory.create('NoteArchived', { note_id: existing.id }, nowMs));
        }
      }
    }
  }

  // Import pages/<slug>.md entries (enforcing §13 raw HTML stripping)
  let pagesImported = 0;
  const pagePaths = [...extracted.keys()]
    .filter((k) => k.startsWith('pages/') && k.endsWith('.md'))
    .sort();
  for (const pagePath of pagePaths) {
    const mdBytes = extracted.get(pagePath);
    if (!mdBytes) continue;
    const rawMd = decodeUtf8(mdBytes);
    const fm = parseMarkdownFrontmatter(rawMd);
    const slugFromFile = pagePath.slice('pages/'.length, -'.md'.length);
    const pageRes = normalizeMarkdownPage({
      sourceKey: `pkg:${manifest.package_id}:${slugFromFile}`,
      fallbackTitle: slugFromFile,
      rawMarkdown: rawMd,
      source: baseSource,
      state,
      eventFactory,
      nowMs,
    });
    if (fm.id) {
      pageIdMap.set(fm.id, pageRes.pageId);
    }
    pageIdMap.set(slugFromFile, pageRes.pageId);
    pageIdMap.set(pageRes.slug, pageRes.pageId);
    events.push(...pageRes.events);
    warnings.push(...pageRes.warnings);
    pagesImported += 1;
  }

  // Import courses.json AFTER decks & pages so course references remap cleanly to resolved IDs
  if (extracted.has('courses.json')) {
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
              items: course.items.map((item) => {
                const resolvedRefId =
                  item.kind === 'deck'
                    ? (deckIdMap.get(item.ref_id) ?? item.ref_id)
                    : (pageIdMap.get(item.ref_id) ?? item.ref_id);
                const resolvedPrereq =
                  item.unlocks_after_page_id !== undefined
                    ? (pageIdMap.get(item.unlocks_after_page_id) ?? item.unlocks_after_page_id)
                    : undefined;
                return {
                  kind: item.kind,
                  ref_id: resolvedRefId,
                  ...(resolvedPrereq !== undefined
                    ? { unlocks_after_page_id: resolvedPrereq }
                    : {}),
                };
              }),
            },
          },
          nowMs,
        ),
      );
    }
  }

  // Extract media/<sha256>.<ext> entries and emit MediaAdded
  const mediaPaths = [...extracted.keys()].filter((k) => k.startsWith('media/')).sort();
  for (const mediaPath of mediaPaths) {
    const mediaBytes = extracted.get(mediaPath);
    if (!mediaBytes) continue;
    const match = /^media\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/i.exec(mediaPath);
    if (!match) continue;
    const declaredHash = (match[1] ?? '').toLowerCase();
    const ext = (match[2] ?? '').toLowerCase();
    const mime = SAFE_MEDIA_MIME_BY_EXT[ext];
    if (!mime) continue;
    const actualHash = sha256Hex(mediaBytes);
    if (actualHash !== declaredHash) {
      throw new FlashpkgSecurityError(
        `Media hash mismatch for "${mediaPath}": expected ${declaredHash}, got ${actualHash}.`,
      );
    }
    extractedMedia.push({ hash: actualHash, ext, mime, bytes: mediaBytes });
    if (!state.media.has(actualHash)) {
      events.push(
        eventFactory.create(
          'MediaAdded',
          {
            media: {
              hash: actualHash,
              ext,
              mime,
              size: mediaBytes.byteLength,
            },
          },
          nowMs,
        ),
      );
    }
  }

  return {
    manifest,
    events,
    decksImported,
    notesImported,
    pagesImported,
    upgradedDecks,
    extractedMedia,
    warnings,
  };
}
