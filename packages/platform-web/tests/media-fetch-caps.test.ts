import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioProcessError, fetchAndProcessHttpsAudio } from '../src/media/audio-processor.ts';
import { fetchAndProcessHttpsImage, ImageProcessError } from '../src/media/image-processor.ts';
import { declaredBody, streamedBody } from './helpers/oversized-body.ts';

/**
 * Per-call-site caps (P8) of the remote image and audio fetches: a declared `Content-Length` over
 * the cap is refused before the body is read, and a streamed body is cut off once it passes the
 * cap, so a lying or missing header can't make the app buffer the whole download.
 */

const CAP = 2048;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAndProcessHttpsAudio cap', () => {
  it('refuses a declared Content-Length over the cap', async () => {
    const fetchImpl = vi.fn(async () => declaredBody(CAP + 1, { 'content-type': 'audio/mpeg' }));
    const err = await fetchAndProcessHttpsAudio('https://cdn.example/a.mp3', {
      maxBytes: CAP,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AudioProcessError);
    expect(String(err)).toContain(`${CAP + 1} > ${CAP} bytes`);
  });

  it('stops reading a streamed body once it passes the cap', async () => {
    const body = streamedBody(CAP * 100, 512, { 'content-type': 'audio/mpeg' });
    const err = await fetchAndProcessHttpsAudio('https://cdn.example/a.mp3', {
      maxBytes: CAP,
      fetchImpl: async () => body.response,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AudioProcessError);
    expect(String(err)).toContain(`more than ${CAP} bytes`);
    expect(body.cancelled).toBe(true);
    expect(body.pulled).toBeLessThan(CAP * 4);
  });
});

describe('fetchAndProcessHttpsImage cap', () => {
  it('refuses a declared Content-Length over the cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => declaredBody(CAP + 1, { 'content-type': 'image/png' })),
    );
    const err = await fetchAndProcessHttpsImage('https://cdn.example/a.png', {
      maxInputBytes: CAP,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageProcessError);
    expect(String(err)).toContain(`${CAP + 1} > ${CAP} bytes`);
  });

  it('stops reading a streamed body once it passes the cap', async () => {
    const body = streamedBody(CAP * 100, 512, { 'content-type': 'image/png' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => body.response),
    );
    const err = await fetchAndProcessHttpsImage('https://cdn.example/a.png', {
      maxInputBytes: CAP,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageProcessError);
    expect(String(err)).toContain(`more than ${CAP} bytes`);
    expect(body.cancelled).toBe(true);
    expect(body.pulled).toBeLessThan(CAP * 4);
  });
});
