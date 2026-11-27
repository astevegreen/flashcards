import { PACK_SECURITY_LIMITS } from '@flash/core/pack-limits';

/**
 * The largest local pack file the pack picker reads. The codec refuses any pack file, gzip or
 * plain JSON, over the compressed (file-size) cap, so the picker refuses a bigger one before
 * reading it (P8). The uncompressed cap applies after gunzip.
 */
export const MAX_PACK_PICK_BYTES = PACK_SECURITY_LIMITS.maxCompressedBytes;
