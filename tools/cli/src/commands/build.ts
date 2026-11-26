import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { FamilyCatalog } from '@flash/content-schema';
import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveNoteId,
  FLASH_NAMESPACE_UUID,
  uuidv5,
  type KnownEvent,
  type NoteType,
} from '@flash/core';
import { buildEventsFromCsv } from '@flash/core/csv';
import { exportFlashpkg } from '@flash/core/flashpkg';
import { parseMarkdownFrontmatter, sha256Hex } from '@flash/core/sources';

export interface BuildDeckNoteInput {
  id?: string;
  fields: Record<string, string>;
  tags?: string[];
}

export interface BuildDeckSpec {
  id?: string;
  name: string;
  language?: string;
  noteTypeId?: string;
  csvText?: string;
  delimiter?: ',' | '\t';
  notes?: readonly BuildDeckNoteInput[];
}

export interface BuildPageSpec {
  slug: string;
  title: string;
  markdown: string;
  lang?: string;
  tags?: string[];
}

export interface BuildMediaSpec {
  bytes: Uint8Array;
  ext: string;
  mime: string;
  ttsKey?: string;
  ttsLangKey?: string;
}

export interface BuildPackageSpec {
  packageId?: string;
  name: string;
  version?: string;
  author?: string;
  license?: string;
  aiProvenance?: boolean;
  nowMs?: number;
  decks?: readonly BuildDeckSpec[];
  pages?: readonly BuildPageSpec[];
  media?: readonly BuildMediaSpec[];
}

export interface BuildPackageResult {
  bytes: Uint8Array;
  packageId: string;
  name: string;
  version: string;
  decksCount: number;
  notesCount: number;
  pagesCount: number;
  mediaCount: number;
}

export function inferNoteTypeIdForLang(lang: string | undefined): string {
  const norm = (lang ?? 'en').trim().toLowerCase();
  if (norm === 'ja' || norm.startsWith('ja-')) return BUILTIN_NOTE_TYPE_IDS.VOCAB_JA;
  if (norm.startsWith('zh')) return BUILTIN_NOTE_TYPE_IDS.VOCAB_ZH;
  if (norm === 'ko' || norm.startsWith('ko-')) return BUILTIN_NOTE_TYPE_IDS.VOCAB_KO;
  return BUILTIN_NOTE_TYPE_IDS.SENTENCE;
}

function resolveMimeForExt(ext: string): string {
  switch (ext.toLowerCase().replace(/^\./, '')) {
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'm4a':
      return 'audio/mp4';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Compiles decks, Markdown pages, and media into a schema-validated `.flashpkg` archive.
 * When `aiProvenance: true`, stamps `provenance = { source: 'ai', reviewed: false }` (§10.3).
 */
export function buildPackageFromSpec(spec: BuildPackageSpec): BuildPackageResult {
  const nowMs = spec.nowMs ?? Date.now();
  const state = createEmptyState();
  const factory = createEventFactory('cli-build', 0, createHlcState('cli-build', nowMs));
  const version = spec.version ?? '1.0.0';
  const slugBase =
    spec.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'package';
  const packageId = spec.packageId ?? `pkg:${slugBase}`;
  const events: KnownEvent[] = [];
  const mediaBlobs = new Map<string, Uint8Array>();

  if (spec.media) {
    for (const m of spec.media) {
      const hash = sha256Hex(m.bytes).toLowerCase();
      mediaBlobs.set(hash, m.bytes);
      events.push(
        factory.create(
          'MediaAdded',
          {
            media: {
              hash,
              ext: m.ext.toLowerCase().replace(/^\./, ''),
              mime: m.mime,
              size: m.bytes.byteLength,
              ...(m.ttsKey !== undefined ? { tts_key: m.ttsKey } : {}),
              ...(m.ttsLangKey !== undefined ? { tts_lang_key: m.ttsLangKey } : {}),
            },
          },
          nowMs,
        ),
      );
    }
  }

  let notesCount = 0;
  let decksCount = 0;
  for (const deckSpec of spec.decks ?? []) {
    const language = deckSpec.language ?? 'en';
    const noteTypeId = deckSpec.noteTypeId ?? inferNoteTypeIdForLang(language);
    const noteType: NoteType = state.noteTypes.get(noteTypeId) ??
      state.noteTypes.get(BUILTIN_NOTE_TYPE_IDS.VOCAB_KO) ?? {
        id: noteTypeId,
        name: noteTypeId,
        fields: [
          { key: 'word', label: 'Word', kind: 'text', lang: language },
          { key: 'meaning', label: 'Meaning', kind: 'text', lang: 'en' },
        ],
      };

    const deckId =
      deckSpec.id ?? uuidv5(FLASH_NAMESPACE_UUID, `${packageId}:deck:${deckSpec.name}`);
    events.push(
      factory.create(
        'DeckCreated',
        {
          deck_id: deckId,
          name: deckSpec.name,
          note_type_id: noteType.id,
          language,
          source: { kind: 'package', package_id: packageId, package_version: version },
          created_at: nowMs,
        },
        nowMs,
      ),
    );
    decksCount += 1;

    if (deckSpec.csvText) {
      const csvRes = buildEventsFromCsv(deckSpec.csvText, {
        deckId,
        noteType,
        eventFactory: factory,
        ...(deckSpec.delimiter ? { delimiter: deckSpec.delimiter } : {}),
        nowMs,
      });
      for (const ev of csvRes.events) {
        if (spec.aiProvenance && ev.type === 'NoteUpserted') {
          ev.payload.provenance = { source: 'ai', reviewed: false };
        }
        events.push(ev);
        if (ev.type === 'NoteUpserted') notesCount += 1;
      }
    }

    if (deckSpec.notes) {
      for (let i = 0; i < deckSpec.notes.length; i++) {
        const note = deckSpec.notes[i];
        if (!note) continue;
        const sourceKey = note.id ?? `note-${i + 1}`;
        const noteId = deriveNoteId(deckId, sourceKey);
        events.push(
          factory.create(
            'NoteUpserted',
            {
              note_id: noteId,
              deck_id: deckId,
              source_key: sourceKey,
              fields: note.fields,
              tags: note.tags ?? [],
              provenance: spec.aiProvenance
                ? { source: 'ai', reviewed: false }
                : { source: 'import', reviewed: true },
              created_order: i,
            },
            nowMs,
          ),
        );
        notesCount += 1;
      }
    }
  }

  let pagesCount = 0;
  for (const page of spec.pages ?? []) {
    const cleanSlug =
      page.slug
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af-]+/g, '-')
        .replace(/^-+|-+$/g, '') || `page-${pagesCount + 1}`;
    const pageId = uuidv5(FLASH_NAMESPACE_UUID, `${packageId}:page:${cleanSlug}`);
    events.push(
      factory.create(
        'PageUpserted',
        {
          page_id: pageId,
          slug: cleanSlug,
          title: page.title || cleanSlug,
          markdown: page.markdown,
          ...(page.lang ? { lang: page.lang } : {}),
          tags: page.tags ?? [],
          source: { kind: 'package', package_id: packageId, package_version: version },
        },
        nowMs,
      ),
    );
    pagesCount += 1;
  }

  applyEvents(state, events);
  const bytes = exportFlashpkg(state, {
    packageId,
    name: spec.name,
    version,
    ...(spec.author !== undefined ? { author: spec.author } : {}),
    ...(spec.license !== undefined ? { license: spec.license } : {}),
    ...(mediaBlobs.size > 0 ? { mediaBlobs } : {}),
  });

  return {
    bytes,
    packageId,
    name: spec.name,
    version,
    decksCount,
    notesCount,
    pagesCount,
    mediaCount: mediaBlobs.size,
  };
}

interface PackageDirectoryConfig {
  package_id?: string;
  name?: string;
  version?: string;
  author?: string;
  license?: string;
  language?: string;
  note_type_id?: string;
}

/**
 * Compiles a local directory containing `package.json`/`flashpkg.config.json`, `*.csv`/`*.tsv` decks,
 * `pages/*.md` Markdown lessons, and `media/*` assets into a `.flashpkg` archive on disk.
 */
export function buildPackageFromDirectory(
  inputDir: string,
  options: {
    outPath?: string;
    name?: string;
    packageId?: string;
    version?: string;
    language?: string;
    aiProvenance?: boolean;
  } = {},
): BuildPackageResult & { outPath: string } {
  if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  let dirConfig: PackageDirectoryConfig = {};
  const configCandidates = ['flashpkg.config.json', 'manifest.json', 'package.json'];
  for (const cfgName of configCandidates) {
    const cfgPath = join(inputDir, cfgName);
    if (existsSync(cfgPath)) {
      try {
        dirConfig = JSON.parse(readFileSync(cfgPath, 'utf8')) as PackageDirectoryConfig;
        break;
      } catch {
        // Ignore non-JSON or unrelated configs
      }
    }
  }

  const decks: BuildDeckSpec[] = [];
  const pages: BuildPageSpec[] = [];
  const media: BuildMediaSpec[] = [];

  const collectCsvFromDir = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.csv' || ext === '.tsv') {
        const deckName = basename(entry.name, ext);
        const language = options.language ?? dirConfig.language ?? 'ko';
        decks.push({
          name: deckName,
          language,
          noteTypeId: dirConfig.note_type_id ?? inferNoteTypeIdForLang(language),
          csvText: readFileSync(join(dir, entry.name), 'utf8'),
          delimiter: ext === '.tsv' ? '\t' : ',',
        });
      }
    }
  };

  collectCsvFromDir(inputDir);
  collectCsvFromDir(join(inputDir, 'decks'));

  const pagesDir = existsSync(join(inputDir, 'pages')) ? join(inputDir, 'pages') : inputDir;
  for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;
    if (entry.name.toLowerCase() === 'readme.md' && pagesDir === inputDir) continue;
    const rawMd = readFileSync(join(pagesDir, entry.name), 'utf8');
    const slug = basename(entry.name, '.md');
    const parsed = parseMarkdownFrontmatter(rawMd);
    pages.push({
      slug: parsed.slug ?? slug,
      title: parsed.title ?? slug,
      markdown: parsed.body,
      ...(parsed.lang ? { lang: parsed.lang } : {}),
      tags: parsed.tags,
    });
  }

  const mediaDir = join(inputDir, 'media');
  if (existsSync(mediaDir) && statSync(mediaDir).isDirectory()) {
    for (const entry of readdirSync(mediaDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase().replace(/^\./, '');
      if (!ext) continue;
      media.push({
        bytes: readFileSync(join(mediaDir, entry.name)),
        ext,
        mime: resolveMimeForExt(ext),
      });
    }
  }

  const pkgName = options.name ?? dirConfig.name ?? basename(inputDir);
  const pkgVersion = options.version ?? dirConfig.version ?? '1.0.0';
  const result = buildPackageFromSpec({
    ...((options.packageId ?? dirConfig.package_id)
      ? { packageId: options.packageId ?? dirConfig.package_id }
      : {}),
    name: pkgName,
    version: pkgVersion,
    ...(dirConfig.author !== undefined ? { author: dirConfig.author } : {}),
    ...(dirConfig.license !== undefined ? { license: dirConfig.license } : {}),
    ...(options.aiProvenance !== undefined ? { aiProvenance: options.aiProvenance } : {}),
    decks,
    pages,
    media,
  });

  const slug =
    pkgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'package';
  const outPath = options.outPath ?? join(inputDir, `${slug}.flashpkg`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.bytes);

  return { ...result, outPath };
}

/**
 * Generates a static Family Library / Starter Decks `index.json` manifest (§3.4).
 */
export function buildFamilyCatalogJson(params: {
  name: string;
  description?: string;
  updatedAt?: string;
  packages: FamilyCatalog['packages'];
}): string {
  const catalog: FamilyCatalog = {
    format_version: 1,
    name: params.name,
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.updatedAt !== undefined ? { updated_at: params.updatedAt } : {}),
    packages: params.packages,
  };
  return decodeTextPretty(catalog);
}

function decodeTextPretty(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}
