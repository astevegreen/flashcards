/**
 * The pack caps on their own, with no imports, so a picker can read them (`@flash/core/pack-limits`)
 * without pulling the pack codec into its chunk.
 */
export const PACK_SECURITY_LIMITS = {
  maxCatalogBytes: 1 * 1024 * 1024, // 1 MB
  maxCompressedBytes: 50 * 1024 * 1024, // 50 MB
  maxUncompressedBytes: 150 * 1024 * 1024, // 150 MB (supports full JMdict)
  maxEntries: 400_000,
} as const;
