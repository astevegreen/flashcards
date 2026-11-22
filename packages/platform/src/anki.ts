import type { AnkiRawPackage } from '@flash/core/anki';

/**
 * Phase 12 Anki `.apkg` reader. The web implementation unzips (with caps) and opens the SQLite
 * collection with `sql.js` WASM inside a Web Worker, then hands back plain rows + media bytes;
 * `@flash/core/anki` converts them into events on the main thread.
 */
export type AnkiPackageReadStage = 'reading';

export interface AnkiPackageReader {
  /** May take ownership of `bytes` (the web reader transfers them to its Worker). */
  read(
    bytes: Uint8Array,
    options?: {
      /** Copy the review log too (only needed when importing review history). */
      includeReviewHistory?: boolean;
      onStage?: (stage: AnkiPackageReadStage) => void;
    },
  ): Promise<AnkiRawPackage>;
}
