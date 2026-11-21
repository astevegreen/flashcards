import { describe, expect, it } from 'vitest';
import {
  computeTargetDimensions,
  ImageProcessError,
  processImageBytes,
  resolveValidatedImageMime,
  sniffImageMime,
} from '../src/media/image-processor.ts';

const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const VALID_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const VALID_GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
]);

describe('Web image processor (§4.2, §13)', () => {
  it('sniffs PNG, JPEG, GIF magic bytes and rejects SVG/HTML/unknown', () => {
    expect(sniffImageMime(VALID_PNG_BYTES)).toBe('image/png');
    expect(sniffImageMime(VALID_JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageMime(VALID_GIF_BYTES)).toBe('image/gif');
    expect(sniffImageMime(new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toBeNull();

    expect(resolveValidatedImageMime('', VALID_PNG_BYTES)).toBe('image/png');
    expect(() =>
      resolveValidatedImageMime('image/svg+xml', new TextEncoder().encode('<svg></svg>')),
    ).toThrow(ImageProcessError);
    expect(() =>
      resolveValidatedImageMime('text/html', new TextEncoder().encode('<script>x</script>')),
    ).toThrow(ImageProcessError);

    // §13 Security: spoofed MIME (`image/png`) wrapping SVG/HTML/text MUST be rejected via magic bytes
    expect(() =>
      resolveValidatedImageMime(
        'image/png',
        new TextEncoder().encode('<svg onload="alert(1)"></svg>'),
      ),
    ).toThrow(ImageProcessError);
    expect(() =>
      resolveValidatedImageMime(
        'image/jpeg',
        new TextEncoder().encode('<html><script>alert(1)</script></html>'),
      ),
    ).toThrow(ImageProcessError);
  });

  it('rejects spoofed SVG payload even when processImageBytes receives declared image/png MIME', async () => {
    const spoofedSvg = new TextEncoder().encode('<svg onload="alert(1)"><rect/></svg>');
    await expect(processImageBytes(spoofedSvg, 'image/png')).rejects.toThrow(ImageProcessError);
  });

  it('computes resized target dimensions preserving aspect ratio without upscaling', () => {
    expect(computeTargetDimensions(2400, 1200, 1200)).toEqual({
      width: 1200,
      height: 600,
      resized: true,
    });
    expect(computeTargetDimensions(800, 600, 1200)).toEqual({
      width: 800,
      height: 600,
      resized: false,
    });
    expect(computeTargetDimensions(600, 2400, 1200)).toEqual({
      width: 300,
      height: 1200,
      resized: true,
    });
  });

  it('rejects empty and oversized images, and returns deterministic SHA-256 content hash', async () => {
    await expect(processImageBytes(new Uint8Array(0), 'image/png')).rejects.toThrow(
      ImageProcessError,
    );
    await expect(
      processImageBytes(VALID_PNG_BYTES, 'image/png', { maxInputBytes: 8 }),
    ).rejects.toThrow(ImageProcessError);

    const p1 = await processImageBytes(VALID_PNG_BYTES, '');
    const p2 = await processImageBytes(VALID_PNG_BYTES, 'image/png');
    expect(p1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p1.hash).toBe(p2.hash);
    expect(p1.ext).toBe('png');
    expect(p1.mime).toBe('image/png');
    expect(p1.size).toBe(VALID_PNG_BYTES.byteLength);
  });
});
