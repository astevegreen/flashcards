import { assertSafeHttpsUrl, sha256Hex } from '@flash/core/sources';
import type { ImageProcessOptions, ProcessedImage } from '@flash/platform';

export const IMAGE_PROCESSOR_LIMITS = {
  maxInputBytes: 20 * 1024 * 1024, // 20 MiB raw input cap
  maxOutputBytes: 10 * 1024 * 1024, // 10 MiB synced blob cap
  defaultMaxDimension: 1200,
  defaultWebpQuality: 0.82,
  defaultJpegQuality: 0.85,
} as const;

const ALLOWED_IMAGE_MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export class ImageProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageProcessError';
  }
}

/**
 * Sniffs common safe raster image MIME types from magic bytes so files lacking an explicit MIME type
 * (or mislabeled by OS file pickers) are validated safely. Never allows SVG/HTML (§13).
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A (8 bytes)
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF (3 bytes)
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: GIF87a or GIF89a (6 bytes)
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP (12 bytes)
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export function resolveValidatedImageMime(rawMime: string, bytes: Uint8Array): string {
  const normalized = rawMime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized && !ALLOWED_IMAGE_MIME_TO_EXT[normalized]) {
    throw new ImageProcessError(
      `Unsupported image format "${normalized}". Allowed formats: PNG, JPEG, WebP, GIF.`,
    );
  }

  // Always verify actual magic bytes so spoofed SVG/HTML/text masquerading as `image/png` is rejected (§13).
  const sniffed = sniffImageMime(bytes);
  if (sniffed && ALLOWED_IMAGE_MIME_TO_EXT[sniffed]) {
    return sniffed;
  }

  throw new ImageProcessError(
    normalized
      ? `File bytes do not match a valid PNG, JPEG, WebP, or GIF image (declared "${normalized}").`
      : 'Unrecognized or unsupported image format. Allowed formats: PNG, JPEG, WebP, GIF.',
  );
}

/**
 * Computes resized integer target dimensions preserving aspect ratio without upscaling.
 */
export function computeTargetDimensions(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number; resized: boolean } {
  if (width <= 0 || height <= 0) {
    return { width: 1, height: 1, resized: false };
  }
  const longest = Math.max(width, height);
  if (longest <= maxDimension) {
    return { width: Math.round(width), height: Math.round(height), resized: false };
  }
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

async function encodeCanvasToBytes(
  bitmap: ImageBitmap,
  targetW: number,
  targetH: number,
  quality: number,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  // 1. Prefer OffscreenCanvas
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      for (const candidate of [
        { mime: 'image/webp', q: quality },
        { mime: 'image/jpeg', q: Math.min(0.92, quality + 0.03) },
      ]) {
        try {
          const blob = await canvas.convertToBlob({ type: candidate.mime, quality: candidate.q });
          if (blob && blob.size > 0 && ALLOWED_IMAGE_MIME_TO_EXT[blob.type]) {
            const buf = await blob.arrayBuffer();
            return { bytes: new Uint8Array(buf), mime: blob.type };
          }
        } catch {
          // Try next encoder
        }
      }
    }
  }

  // 2. Fallback to HTMLCanvasElement
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      for (const candidate of [
        { mime: 'image/webp', q: quality },
        { mime: 'image/jpeg', q: Math.min(0.92, quality + 0.03) },
      ]) {
        const blob = await new Promise<Blob | null>((resolve) => {
          try {
            canvas.toBlob((b) => resolve(b), candidate.mime, candidate.q);
          } catch {
            resolve(null);
          }
        });
        if (blob && blob.size > 0 && ALLOWED_IMAGE_MIME_TO_EXT[blob.type]) {
          const buf = await blob.arrayBuffer();
          return { bytes: new Uint8Array(buf), mime: blob.type };
        }
      }
    }
  }

  return null;
}

/**
 * Validates, resizes/compresses (when browser canvas APIs are available), and SHA-256 content-hashes
 * an image for local storage (`media:<sha256>`) and cross-device sync (§4.2, §13).
 */
export async function processImageBytes(
  rawBytes: Uint8Array,
  rawMime: string,
  opts?: ImageProcessOptions,
): Promise<ProcessedImage> {
  const maxInputBytes = opts?.maxInputBytes ?? IMAGE_PROCESSOR_LIMITS.maxInputBytes;
  const maxDimension = opts?.maxDimension ?? IMAGE_PROCESSOR_LIMITS.defaultMaxDimension;
  const quality = opts?.quality ?? IMAGE_PROCESSOR_LIMITS.defaultWebpQuality;

  if (rawBytes.byteLength === 0) {
    throw new ImageProcessError('Image file is empty.');
  }
  if (rawBytes.byteLength > maxInputBytes) {
    throw new ImageProcessError(
      `Image exceeds maximum input size (${Math.round(maxInputBytes / (1024 * 1024))} MiB).`,
    );
  }

  const validatedMime = resolveValidatedImageMime(rawMime, rawBytes);
  let finalBytes: Uint8Array = rawBytes;
  let finalMime = validatedMime;

  // Preserve GIFs untouched (avoid stripping animation frames) and skip canvas re-encoding when unavailable
  if (
    validatedMime !== 'image/gif' &&
    typeof createImageBitmap === 'function' &&
    typeof Blob !== 'undefined'
  ) {
    try {
      const copy = new Uint8Array(rawBytes.byteLength);
      copy.set(rawBytes);
      const inputBlob = new Blob([copy], { type: validatedMime });
      const bitmap = await createImageBitmap(inputBlob);
      try {
        const dims = computeTargetDimensions(bitmap.width, bitmap.height, maxDimension);
        const shouldReencode = dims.resized || rawBytes.byteLength > 256 * 1024;
        if (shouldReencode) {
          const encoded = await encodeCanvasToBytes(bitmap, dims.width, dims.height, quality);
          if (encoded && (dims.resized || encoded.bytes.byteLength < rawBytes.byteLength)) {
            finalBytes = encoded.bytes;
            finalMime = encoded.mime;
          }
        }
      } finally {
        bitmap.close();
      }
    } catch {
      // If bitmap decoding fails (e.g., headless test fixture or minimal PNG), keep validated original bytes
    }
  }

  if (finalBytes.byteLength > IMAGE_PROCESSOR_LIMITS.maxOutputBytes) {
    throw new ImageProcessError(
      `Processed image exceeds maximum storage size (${Math.round(IMAGE_PROCESSOR_LIMITS.maxOutputBytes / (1024 * 1024))} MiB).`,
    );
  }

  const ext = ALLOWED_IMAGE_MIME_TO_EXT[finalMime] ?? 'png';
  const hash = sha256Hex(finalBytes);
  return {
    hash,
    ext,
    mime: finalMime,
    size: finalBytes.byteLength,
    bytes: finalBytes,
  };
}

/**
 * Option 1 (§13 + R7): Fetches a remote `https:` image URL (when CORS permits), validates/resizes it,
 * and returns a content-hashed `ProcessedImage` ready to store locally as `media:<sha256>`.
 */
export async function fetchAndProcessHttpsImage(
  url: string,
  opts?: ImageProcessOptions,
): Promise<ProcessedImage> {
  const safeUrl = assertSafeHttpsUrl(url);
  const maxInputBytes = opts?.maxInputBytes ?? IMAGE_PROCESSOR_LIMITS.maxInputBytes;

  let res: Response;
  try {
    res = await fetch(safeUrl, { mode: 'cors', credentials: 'omit' });
  } catch (err) {
    throw new ImageProcessError(
      `Could not fetch image "${safeUrl}" (likely blocked by CORS on the remote host): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new ImageProcessError(`Remote image request failed (${res.status}) for "${safeUrl}".`);
  }

  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxInputBytes) {
      throw new ImageProcessError(
        `Remote image exceeds max size (${declared} > ${maxInputBytes} bytes).`,
      );
    }
  }

  const contentType = res.headers.get('content-type') ?? '';
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  return processImageBytes(bytes, contentType, opts);
}
