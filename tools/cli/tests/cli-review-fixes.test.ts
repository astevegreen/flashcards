import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_KEY_ENV,
  buildPackageFromSpec,
  enrichPackageWithAudio,
  KEY_STDIN_PROMPT,
  parseArgs,
  readKeyFromStdin,
  resolveAudioApiKey,
  runCli,
  type AudioSynthesizeFn,
} from '../src/index.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe('--key-stdin at a terminal (S11)', () => {
  async function* lines(...chunks: string[]) {
    for (const c of chunks) yield new TextEncoder().encode(c);
  }

  it('prompts on stderr at a TTY and reads only the first line', async () => {
    const written: string[] = [];
    const stdin = Object.assign(lines('key-from-tty\n', 'never read'), { isTTY: true });
    const text = await readKeyFromStdin({ stdin, stderr: { write: (t) => written.push(t) } });
    expect(written).toEqual([KEY_STDIN_PROMPT]);
    expect(text).toBe('key-from-tty\n');
  });

  /** A TTY stdin that records raw-mode switches, fed one key press per chunk. */
  function rawTty(...keys: string[]) {
    const modes: boolean[] = [];
    const stdin = Object.assign(lines(...keys), {
      isTTY: true,
      setRawMode: (raw: boolean) => {
        modes.push(raw);
      },
    });
    return { stdin, modes };
  }

  it('reads the key in raw mode at a TTY, so the terminal never echoes it', async () => {
    const written: string[] = [];
    const { stdin, modes } = rawTty('s', 'e', 'c', 'x', '\u007f', 'r', 'et', '\r', 'after');
    const text = await readKeyFromStdin({ stdin, stderr: { write: (t) => written.push(t) } });
    expect(text).toBe('secret\n');
    expect(modes).toEqual([true, false]);
    // Only the prompt and the closing newline reach the terminal: no key character.
    expect(written).toEqual([KEY_STDIN_PROMPT, '\n']);
  });

  it('drops escape sequences, Tab and other control characters from the key', async () => {
    const { stdin } = rawTty(
      '\u001b[200~', // bracketed-paste start
      'ab',
      '\u001b[D', // left arrow
      '\t',
      'c\u001bOA', // SS3 up arrow
      '\u001bx', // a two-byte escape
      'd\u0001',
      '\u001b[201~', // bracketed-paste end
      '\r',
    );
    expect(await readKeyFromStdin({ stdin, stderr: { write: () => true } })).toBe('abcd\n');
  });

  it('drops a lone Esc without swallowing the key after it', async () => {
    const read = (...keys: string[]) =>
      readKeyFromStdin({ stdin: rawTty(...keys).stdin, stderr: { write: () => true } });
    // Esc in its own chunk, then a printable key, then Enter.
    expect(await read('ab', '\u001b', 'c', '\r')).toBe('abc\n');
    // Esc then Enter, in one chunk or two: Enter still ends the line.
    expect(await read('ab', '\u001b', '\r', 'late')).toBe('ab\n');
    expect(await read('ab\u001b\r', 'late')).toBe('ab\n');
    // Esc then Backspace still deletes; Esc Esc then a key keeps the key.
    expect(await read('ab', '\u001b\u007f', '\r')).toBe('a\n');
    expect(await read('a', '\u001b\u001b', 'b', '\r')).toBe('ab\n');
    // A whole sequence after a lone Esc is still dropped.
    expect(await read('a\u001b', '\u001b[D', 'b\r')).toBe('ab\n');
  });

  it('cancels at Ctrl-C right after a lone Esc', async () => {
    const { stdin, modes } = rawTty('ab', '\u001b', '\u0003', 'c\r');
    await expect(readKeyFromStdin({ stdin, stderr: { write: () => true } })).rejects.toThrow(
      /Cancelled/,
    );
    expect(modes).toEqual([true, false]);
    await expect(
      readKeyFromStdin({ stdin: rawTty('ab\u001b\u0003').stdin, stderr: { write: () => true } }),
    ).rejects.toThrow(/Cancelled/);
  });

  it('leaves raw mode and reads nothing when Ctrl-C cancels', async () => {
    const { stdin, modes } = rawTty('ab', '\u0003', 'c\r');
    await expect(readKeyFromStdin({ stdin, stderr: { write: () => true } })).rejects.toThrow(
      /Cancelled/,
    );
    expect(modes).toEqual([true, false]);
  });

  it('ends the key at Ctrl-D or end of input in raw mode', async () => {
    expect(
      await readKeyFromStdin({
        stdin: rawTty('k1', '\u0004').stdin,
        stderr: { write: () => true },
      }),
    ).toBe('k1\n');
    expect(
      await readKeyFromStdin({ stdin: rawTty('k2').stdin, stderr: { write: () => true } }),
    ).toBe('k2\n');
  });

  it('stays quiet when the key is piped in', async () => {
    const written: string[] = [];
    const text = await readKeyFromStdin({
      stdin: lines('piped', '-key\n'),
      stderr: { write: (t) => written.push(t) },
    });
    expect(written).toEqual([]);
    expect(text).toBe('piped-key\n');
  });
});

describe('flash-cli audio exit code (C28)', () => {
  it('exits 1 and still writes the clips made before a failed request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flash-audio-cli-'));
    try {
      const inFile = join(dir, 'in.flashpkg');
      const outFile = join(dir, 'out.flashpkg');
      writeFileSync(inFile, threeNotePackage());
      vi.stubEnv(AUDIO_KEY_ENV, 'env-key');
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? new Response(JSON.stringify({ audioContent: 'SUQz' }), { status: 200 })
            : new Response('quota', { status: 429 });
        }),
      );
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(
        (chunk: string | Uint8Array) => stderr.push(String(chunk)) > 0,
      );
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const code = await runCli(['audio', inFile, '--provider', 'google', '-o', outFile]);
      expect(code).toBe(1);
      expect(stderr.join('')).toMatch(/Synthesis stopped at note .*429/s);

      // The saved package keeps the first clip: a rerun pays only for the other two notes.
      let rerun = 0;
      await enrichPackageWithAudio(readFileSync(outFile), {
        provider: 'google',
        apiKey: 'k',
        synthesizeFn: async () => {
          rerun += 1;
          return { bytes: new Uint8Array([rerun]), mime: 'audio/mpeg', ext: 'mp3', voiceId: 'v' };
        },
      });
      expect(rerun).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
