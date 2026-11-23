import type { AnkiRawPackage } from '@flash/core/anki';
import type { AnkiCollectionPlan } from '@flash/core/anki-export';

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
  /**
   * `.apkg` export: writes the SQLite collection (`collection.anki2`) from the rows
   * `@flash/core/anki-export` plans. It lives on the reader (the same lazy sql.js service) rather
   * than behind its own platform getter, so the export adds nothing to the study-screen bundle.
   */
  writeCollection?(plan: AnkiCollectionPlan): Promise<Uint8Array>;
}
