import { assertSafeHttpsUrl, sha256Hex } from '@flash/core/sources';
import type { ProcessedAudio } from '@flash/platform';
import { overCapText, readBodyCapped } from '../net/read-capped.ts';

export const AUDIO_PROCESSOR_LIMITS = {
  maxBytes: 10 * 1024 * 1024, // 10 MiB synced blob cap (matches SYNC_MEDIA_LIMITS.maxMediaBlobBytes)
} as const;

const ALLOWED_AUDIO_MIME_CANONICAL: Readonly<Record<string, { mime: string; ext: string }>> = {
  'audio/mpeg': { mime: 'audio/mpeg', ext: 'mp3' },
  'audio/x-mpeg': { mime: 'audio/mpeg', ext: 'mp3' },
  'audio/mpeg3': { mime: 'audio/mpeg', ext: 'mp3' },
  'audio/mp3': { mime: 'audio/mpeg', ext: 'mp3' },
  'audio/wav': { mime: 'audio/wav', ext: 'wav' },
  'audio/wave': { mime: 'audio/wav', ext: 'wav' },
  'audio/x-wav': { mime: 'audio/wav', ext: 'wav' },
  'audio/vnd.wave': { mime: 'audio/wav', ext: 'wav' },
  'audio/ogg': { mime: 'audio/ogg', ext: 'ogg' },
  'application/ogg': { mime: 'audio/ogg', ext: 'ogg' },
  'audio/mp4': { mime: 'audio/mp4', ext: 'm4a' },
  'audio/x-m4a': { mime: 'audio/mp4', ext: 'm4a' },
  'audio/m4a': { mime: 'audio/mp4', ext: 'm4a' },
  'video/mp4': { mime: 'audio/mp4', ext: 'm4a' },
};

/**
 * Generic binary MIME declarations that static CDNs / OS file pickers commonly serve for audio
 * files; these are accepted ONLY when strict magic-byte sniffing proves a valid audio container.
 */
const GENERIC_BINARY_MIMES = new Set(['application/octet-stream', 'binary/octet-stream']);

/** Non-audio ISO BMFF `ftyp` major brands (AVIF / HEIC / HEIF still images) to reject. */
const REJECTED_FTYP_IMAGE_BRANDS = new Set([
  'avif',
  'avis',
  'heic',
  'heix',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
]);

export class AudioProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioProcessError';
  }
}

/**
 * Sniffs safe audio formats (MP3, WAV, OGG, M4A/MP4) strictly from magic bytes (§13).
 * Rejects HTML, SVG, scripts, and arbitrary non-audio payloads.
 */
export function sniffAudioMime(bytes: Uint8Array): string | null {
  // MP3 with ID3v2 header: "ID3" (49 44 33)
  if (bytes.byteLength >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return 'audio/mpeg';
  }

  // Raw MPEG audio frame sync: 11 set bits (FF E0 mask), valid version (!= 01), valid layer (!= 00), valid bitrate (!= 15), valid sample rate (!= 3)
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    const b1 = bytes[1] ?? 0;
    const b2 = bytes[2] ?? 0;
    const versionBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    const bitrateBits = (b2 >> 4) & 0x0f;
    const sampleRateBits = (b2 >> 2) & 0x03;
    if (
      versionBits !== 0x01 &&
      layerBits !== 0x00 &&
      bitrateBits !== 0x0f &&
      sampleRateBits !== 0x03
    ) {
      return 'audio/mpeg';
    }
  }

  // WAV: "RIFF"...."WAVE"
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return 'audio/wav';
  }

  // OGG: "OggS"
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return 'audio/ogg';
  }

  // M4A / MP4 container: "ftyp" at offset 4 (rejecting AVIF/HEIC/HEIF image brands at offset 8..11)
  if (
    bytes.byteLength >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(
      bytes[8] ?? 0,
      bytes[9] ?? 0,
      bytes[10] ?? 0,
      bytes[11] ?? 0,
    ).toLowerCase();
    if (!REJECTED_FTYP_IMAGE_BRANDS.has(brand)) {
      return 'audio/mp4';
    }
  }

  return null;
}

export function resolveValidatedAudioMime(
  rawMime: string,
  bytes: Uint8Array,
): { mime: string; ext: string } {
  const normalized = rawMime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    normalized &&
    !ALLOWED_AUDIO_MIME_CANONICAL[normalized] &&
    !GENERIC_BINARY_MIMES.has(normalized)
  ) {
    throw new AudioProcessError(
      `Unsupported audio format "${normalized}". Allowed formats: MP3, WAV, OGG, M4A.`,
    );
  }

  const sniffed = sniffAudioMime(bytes);
  if (sniffed && ALLOWED_AUDIO_MIME_CANONICAL[sniffed]) {
    return ALLOWED_AUDIO_MIME_CANONICAL[sniffed];
  }

  throw new AudioProcessError(
    normalized
      ? `File bytes do not match a valid MP3, WAV, OGG, or M4A audio file (declared "${normalized}").`
      : 'Unrecognized or unsupported audio format. Allowed formats: MP3, WAV, OGG, M4A.',
  );
}

/**
 * Validates audio magic bytes, enforces the 10 MiB sync media cap, and returns content-hashed `ProcessedAudio`.
 */
export async function processAudioBytes(
  rawBytes: Uint8Array,
  rawMime: string,
  opts?: { maxBytes?: number },
): Promise<ProcessedAudio> {
  const maxBytes = opts?.maxBytes ?? AUDIO_PROCESSOR_LIMITS.maxBytes;

  if (rawBytes.byteLength === 0) {
    throw new AudioProcessError('Audio file is empty.');
  }
  if (rawBytes.byteLength > maxBytes) {
    throw new AudioProcessError(
      `Audio file exceeds maximum size (${Math.round(maxBytes / (1024 * 1024))} MiB).`,
    );
  }

  const { mime, ext } = resolveValidatedAudioMime(rawMime, rawBytes);
  const hash = sha256Hex(rawBytes);
  return {
    hash,
    ext,
    mime,
    size: rawBytes.byteLength,
    bytes: rawBytes,
  };
}

/**
 * Fetches a remote `https://` audio URL (when CORS permits), validates magic bytes and size cap,
 * and returns content-hashed `ProcessedAudio` for offline caching (`media:<sha256>`).
 */
export async function fetchAndProcessHttpsAudio(
  url: string,
  opts?: { maxBytes?: number; fetchImpl?: typeof fetch },
): Promise<ProcessedAudio> {
  const safeUrl = assertSafeHttpsUrl(url);
  const maxBytes = opts?.maxBytes ?? AUDIO_PROCESSOR_LIMITS.maxBytes;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);

  let res: Response;
  try {
    res = await fetchImpl(safeUrl, { mode: 'cors', credentials: 'omit' });
  } catch (err) {
    throw new AudioProcessError(
      `Could not fetch audio "${safeUrl}" (likely blocked by CORS on the remote host): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new AudioProcessError(`Remote audio request failed (${res.status}) for "${safeUrl}".`);
  }

  const bytes = await readBodyCapped(res, maxBytes, {
    tooLarge: (declared) =>
      new AudioProcessError(`Remote audio exceeds max size (${overCapText(declared, maxBytes)}).`),
  });
  const contentType = res.headers.get('content-type') ?? '';
  return processAudioBytes(bytes, contentType, { maxBytes });
}
