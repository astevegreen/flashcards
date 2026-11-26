import { describe, expect, it } from 'vitest';
import {
  AUDIO_KEY_ENV,
  buildPackageFromSpec,
  enrichPackageWithAudio,
  parseArgs,
  resolveAudioApiKey,
  type AudioSynthesizeFn,
} from '../src/index.ts';

function threeNotePackage(): Uint8Array {
  return buildPackageFromSpec({
    packageId: 'pkg:audio-review',
    name: 'Audio Review',
    nowMs: 2000,
    decks: [
      {
        name: 'Korean',
        language: 'ko',
        notes: [
          { id: 'k1', fields: { word: '사랑', meaning: 'love' } },
          { id: 'k2', fields: { word: '감사', meaning: 'gratitude' } },
          { id: 'k3', fields: { word: '학교', meaning: 'school' } },
        ],
      },
    ],
  }).bytes;
}

describe('flash-cli audio key handling (S11)', () => {
  it('sends the Google key as X-Goog-Api-Key, never in the URL', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ audioContent: 'SUQz' }), { status: 200 });
    };
    await enrichPackageWithAudio(threeNotePackage(), {
      provider: 'google',
      apiKey: 'AIzaSecret',
      fetchImpl,
      nowMs: 3000,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).not.toContain('AIzaSecret');
      expect(call.url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
      expect(call.headers.get('X-Goog-Api-Key')).toBe('AIzaSecret');
    }
  });

  it('reads the key from stdin, --key, or the environment', async () => {
    const noStdin = async () => {
      throw new Error('stdin should not be read');
    };
    expect(await resolveAudioApiKey({}, { [AUDIO_KEY_ENV]: ' env-key ' }, noStdin)).toBe('env-key');
    expect(await resolveAudioApiKey({ key: 'inline' }, { [AUDIO_KEY_ENV]: 'env' }, noStdin)).toBe(
      'inline',
    );
    expect(
      await resolveAudioApiKey({ 'key-stdin': true }, {}, async () => 'piped-key\nignored\n'),
    ).toBe('piped-key');
    expect(await resolveAudioApiKey({ 'key-stdin': true }, {}, async () => '\n')).toBeUndefined();
    expect(await resolveAudioApiKey({}, {}, noStdin)).toBeUndefined();
  });
});

describe('flash-cli review fixes (C28)', () => {
  it('boolean flags do not swallow the positional after them', () => {
    expect(parseArgs(['--ai', 'decks/'])).toEqual({ positional: ['decks/'], flags: { ai: true } });
    expect(parseArgs(['--allow-relative', 'pack.json']).positional).toEqual(['pack.json']);
    expect(parseArgs(['--overwrite', 'in.flashpkg', '--provider', 'mock'])).toEqual({
      positional: ['in.flashpkg'],
      flags: { overwrite: true, provider: 'mock' },
    });
    expect(parseArgs(['--key-stdin', 'in.flashpkg']).positional).toEqual(['in.flashpkg']);
    // Value flags still take the next token.
    expect(parseArgs(['--lang', 'ko', 'dir']).flags['lang']).toBe('ko');
  });

  it('audio keeps the clips already synthesized when a later request fails', async () => {
    let n = 0;
    const synthesizeFn: AudioSynthesizeFn = async (input) => {
      n += 1;
      if (n === 2) throw new Error('quota exceeded');
      return {
        bytes: new TextEncoder().encode(`ID3:${input.text}`),
        mime: 'audio/mpeg',
        ext: 'mp3',
        voiceId: 'mock:ko',
      };
    };
    const res = await enrichPackageWithAudio(threeNotePackage(), {
      provider: 'google',
      apiKey: 'k',
      synthesizeFn,
      nowMs: 3000,
    });
    expect(res.generatedCount).toBe(1);
    expect(res.totalMediaCount).toBe(1);
    expect(res.failure?.message).toBe('quota exceeded');
    expect(n).toBe(2);
    expect(res.bytes.byteLength).toBeGreaterThan(0);

    // A rerun on the saved package pays only for the notes still missing audio.
    let rerun = 0;
    const again = await enrichPackageWithAudio(res.bytes, {
      provider: 'google',
      apiKey: 'k',
      synthesizeFn: async (input) => {
        rerun += 1;
        return synthesizeFn(input);
      },
      nowMs: 4000,
    });
    expect(again.failure).toBeUndefined();
    expect(rerun).toBe(2);
    expect(again.skippedCount).toBe(1);
  });
});
