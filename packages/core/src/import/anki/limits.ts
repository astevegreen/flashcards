/**
 * The `.apkg` caps on their own, with no imports, so a picker can read them (`@flash/core/anki-limits`)
 * without pulling the converter into its chunk.
 */

/** Caps for untrusted `.apkg` files (§13). */
export interface AnkiImportLimits {
  maxFiles: number;
  maxTotalUncompressedBytes: number;
  maxSingleFileBytes: number;
  maxCompressedBytes: number;
  maxNotes: number;
  maxCards: number;
  maxRevlog: number;
}

export const ANKI_IMPORT_LIMITS: AnkiImportLimits = {
  maxFiles: 50_000,
  maxTotalUncompressedBytes: 400 * 1024 * 1024,
  maxSingleFileBytes: 200 * 1024 * 1024,
  maxCompressedBytes: 300 * 1024 * 1024,
  maxNotes: 100_000,
  maxCards: 300_000,
  maxRevlog: 2_000_000,
};
