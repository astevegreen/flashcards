import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  decodeUtf8,
} from '@flash/core';
import { parseDelimitedText } from '@flash/core/csv';
import { parseAndValidatePackCatalog } from '@flash/core/dictionary';
import { importFlashpkg } from '@flash/core/flashpkg';
import { parseAndValidateFamilyCatalog } from '@flash/core/sources';

export type ValidatedArtifactKind =
  'flashpkg' | 'csv' | 'family-catalog' | 'pack-catalog' | 'unknown';

export interface ValidateResult {
  valid: boolean;
  kind: ValidatedArtifactKind;
  fileName: string;
  summary: Record<string, unknown>;
  errors: string[];
}

export interface ValidateOptions {
  allowRelativePackUrls?: boolean;
}

/**
 * Validates a `.flashpkg` zip, `.csv`/`.tsv` deck file, Family Library `index.json`,
 * or static pack `packs.json` manifest against `@flash/content-schema` & `@flash/core`.
 */
export function validateArtifactBytes(
  fileName: string,
  bytes: Uint8Array,
  opts: ValidateOptions = {},
): ValidateResult {
  const name = basename(fileName).toLowerCase();
  const ext = extname(name);

  if (ext === '.flashpkg' || ext === '.zip') {
    try {
      const state = createEmptyState();
      const factory = createEventFactory('cli-validate', 0, createHlcState('cli-validate', 1000));
      const res = importFlashpkg(bytes, state, factory, { nowMs: 1000 });
      applyEvents(state, res.events);
      return {
        valid: true,
        kind: 'flashpkg',
        fileName: basename(fileName),
        summary: {
          packageId: res.manifest.package_id,
          name: res.manifest.name,
          version: res.manifest.version,
          decks: res.decksImported,
          notes: res.notesImported,
          pages: res.pagesImported,
          mediaFiles: res.extractedMedia.length,
          warnings: res.warnings.length,
        },
        errors: [],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const schemaDetails =
        err && typeof err === 'object' && 'errors' in err && Array.isArray(err.errors)
          ? err.errors.map((e: { path?: string; message?: string }) =>
              e.path ? `${e.path}: ${e.message ?? ''}` : (e.message ?? String(e)),
            )
          : [];
      return {
        valid: false,
        kind: 'flashpkg',
        fileName: basename(fileName),
        summary: {},
        errors: [msg, ...schemaDetails],
      };
    }
  }

  if (ext === '.csv' || ext === '.tsv') {
    const text = decodeUtf8(bytes);
    const parsed = parseDelimitedText(text, ext === '.tsv' ? { delimiter: '\t' } : undefined);
    const errors: string[] = [];
    if (parsed.headers.length === 0) {
      errors.push('CSV/TSV file has no header row.');
    }
    if (parsed.rows.length === 0) {
      errors.push('CSV/TSV file contains no data rows.');
    }
    return {
      valid: errors.length === 0,
      kind: 'csv',
      fileName: basename(fileName),
      summary: {
        delimiter: parsed.delimiter === '\t' ? 'tsv' : 'csv',
        headers: parsed.headers,
        rowCount: parsed.rows.length,
      },
      errors,
    };
  }

  if (ext === '.json') {
    const raw = decodeUtf8(bytes);
    let parsedObj: unknown;
    try {
      parsedObj = JSON.parse(raw);
    } catch (err) {
      return {
        valid: false,
        kind: 'unknown',
        fileName: basename(fileName),
        summary: {},
        errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    const isPackManifest =
      name.includes('packs') ||
      (typeof parsedObj === 'object' && parsedObj !== null && 'packs' in parsedObj);

    if (isPackManifest) {
      try {
        const catalog = parseAndValidatePackCatalog(raw, {
          ...(opts.allowRelativePackUrls !== undefined
            ? { allowRelativeUrls: opts.allowRelativePackUrls }
            : {}),
        });
        return {
          valid: true,
          kind: 'pack-catalog',
          fileName: basename(fileName),
          summary: {
            name: catalog.name,
            formatVersion: catalog.format_version,
            packCount: catalog.packs.length,
            packIds: catalog.packs.map((p) => p.id),
          },
          errors: [],
        };
      } catch (err) {
        return {
          valid: false,
          kind: 'pack-catalog',
          fileName: basename(fileName),
          summary: {},
          errors: [err instanceof Error ? err.message : String(err)],
        };
      }
    }

    try {
      const catalog = parseAndValidateFamilyCatalog(raw);
      return {
        valid: true,
        kind: 'family-catalog',
        fileName: basename(fileName),
        summary: {
          name: catalog.name,
          formatVersion: catalog.format_version,
          packageCount: catalog.packages.length,
          packageIds: catalog.packages.map((p) => p.package_id),
        },
        errors: [],
      };
    } catch (err) {
      return {
        valid: false,
        kind: 'family-catalog',
        fileName: basename(fileName),
        summary: {},
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  return {
    valid: false,
    kind: 'unknown',
    fileName: basename(fileName),
    summary: {},
    errors: [`Unsupported artifact extension "${ext || '(none)'}" for "${basename(fileName)}".`],
  };
}

export function validateFile(filePath: string, opts: ValidateOptions = {}): ValidateResult {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return {
      valid: false,
      kind: 'unknown',
      fileName: basename(filePath),
      summary: {},
      errors: [`File not found: ${filePath}`],
    };
  }
  const bytes = readFileSync(filePath);
  return validateArtifactBytes(filePath, bytes, opts);
}
