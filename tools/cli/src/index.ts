import { resolve } from 'node:path';
import * as process from 'node:process';
import { runAudioFileEnrichment, type AudioProviderKind } from './commands/audio.ts';
import { buildPackageFromDirectory } from './commands/build.ts';
import { processInboxFolder } from './commands/inbox.ts';
import { validateFile } from './commands/validate.ts';
import { runMcpStdioServer } from './mcp.ts';

export * from './commands/audio.ts';
export * from './commands/build.ts';
export * from './commands/inbox.ts';
export * from './commands/validate.ts';
export * from './mcp.ts';

/** Flags that never take a value, so they cannot swallow the positional after them (C28). */
const BOOLEAN_FLAGS = new Set(['allow-relative', 'ai', 'overwrite', 'key-stdin']);

/** Environment variable `audio` reads its provider key from (S11). */
export const AUDIO_KEY_ENV = 'FLASH_TTS_API_KEY';

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok) continue;
    if (tok.startsWith('--')) {
      const eqIdx = tok.indexOf('=');
      if (eqIdx > 2) {
        flags[tok.slice(2, eqIdx)] = tok.slice(eqIdx + 1);
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (tok === '-o' && argv[i + 1]) {
      flags['out'] = argv[i + 1] ?? '';
      i += 1;
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

function flagString(
  flags: Record<string, string | boolean>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const val = flags[k];
    if (typeof val === 'string' && val.trim().length > 0) return val.trim();
  }
  return undefined;
}

/** The parts of `process.stdin` / `process.stderr` that `readKeyFromStdin` uses. */
export interface KeyPromptIo {
  stdin: AsyncIterable<unknown> & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };
  stderr: { write(text: string): unknown };
}

/** Shown on stderr when `--key-stdin` reads from a terminal rather than a pipe. */
export const KEY_STDIN_PROMPT = 'Paste the TTS API key, then press Enter: ';

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACES = new Set(['\u007f', '\b']);
const ESC = '\u001b';
/** What follows `ESC`: `[` opens a CSI sequence, `O` an SS3 one; anything else ends it. */
const ESCAPE_NEXT: Readonly<Record<string, 'csi' | 'ss3'>> = { '[': 'csi', O: 'ss3' };

/**
 * Drops terminal escape sequences from raw-mode input: CSI (`ESC [ … final`, e.g. arrow keys and
 * the bracketed-paste markers `ESC [200~` / `ESC [201~`), SS3 (`ESC O x`) and two-byte `ESC x`.
 * Returns whether `ch` is part of one.
 */
function escapeSkipper(): (ch: string) => boolean {
  let state: 'text' | 'esc' | 'csi' | 'ss3' = 'text';
  return (ch) => {
    if (state === 'text') {
      if (ch !== ESC) return false;
      state = 'esc';
    } else if (state === 'esc') {
      state = ESCAPE_NEXT[ch] ?? 'text';
    } else if (state === 'csi') {
      // Parameter and intermediate bytes continue; a final byte (0x40–0x7E) ends the sequence.
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) state = 'text';
    } else {
      state = 'text';
    }
    return true;
  };
}

/** C0 controls and DEL (Tab, Escape and the like): never part of a key. */
function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/**
 * Reads one line at a terminal in raw mode, so the terminal never echoes the key: nothing is
 * printed per key press, Backspace deletes, Enter or Ctrl-D ends the line, Ctrl-C cancels.
 * Escape sequences (arrow keys, bracketed-paste markers) and other control characters are dropped.
 */
async function readHiddenLine(
  stdin: KeyPromptIo['stdin'],
  setRawMode: (raw: boolean) => unknown,
  stderr: KeyPromptIo['stderr'],
): Promise<string> {
  const decoder = new TextDecoder();
  const inEscape = escapeSkipper();
  let key = '';
  setRawMode(true);
  try {
    for await (const chunk of stdin) {
      const text =
        typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
      for (const ch of text) {
        if (inEscape(ch)) continue;
        if (ch === CTRL_C) throw new Error('Cancelled: no key was read.');
        if (ch === '\r' || ch === '\n' || ch === CTRL_D) return `${key}\n`;
        if (BACKSPACES.has(ch)) key = key.slice(0, -1);
        else if (!isControl(ch)) key += ch;
      }
    }
    return `${key}\n`;
  } finally {
    setRawMode(false);
    stderr.write('\n');
  }
}

/**
 * Reads the first line of standard input. At a terminal it first prints a prompt to stderr, so
 * `--key-stdin` never sits waiting in silence, and reads in raw mode so the key is never echoed;
 * from a pipe it stays quiet.
 */
export async function readKeyFromStdin(
  io: KeyPromptIo = { stdin: process.stdin, stderr: process.stderr },
): Promise<string> {
  if (io.stdin.isTTY) io.stderr.write(KEY_STDIN_PROMPT);
  const { stdin } = io;
  const setRawMode = stdin.setRawMode;
  if (stdin.isTTY && typeof setRawMode === 'function') {
    return readHiddenLine(stdin, (raw) => setRawMode.call(stdin, raw), io.stderr);
  }
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of io.stdin) {
    text +=
      typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    if (text.includes('\n')) break;
  }
  return text + decoder.decode();
}

/**
 * The `audio` provider key (S11): `--key-stdin` reads its first line from standard input, `--key`
 * takes it inline (which leaves it in shell history), otherwise `FLASH_TTS_API_KEY`.
 */
export async function resolveAudioApiKey(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined> = process.env,
  readStdin: () => Promise<string> = readKeyFromStdin,
): Promise<string | undefined> {
  if (flags['key-stdin'] === true) {
    const line = (await readStdin()).split(/\r?\n/, 1)[0]?.trim() ?? '';
    return line.length > 0 ? line : undefined;
  }
  const inline = flagString(flags, 'key');
  if (inline) return inline;
  const fromEnv = env[AUDIO_KEY_ENV]?.trim();
  return fromEnv ? fromEnv : undefined;
}

function usageText(): string {
  return [
    'Usage: flash-cli <command> [args]',
    '',
    'Commands:',
    '  validate <file> [--allow-relative]',
    '  build <input-dir> [-o <out.flashpkg>] [--name <name>] [--lang <lang>] [--ai]',
    '  audio <input.flashpkg> --provider <google|azure|mock> [--key-stdin | --key <key>] [--region <region>] [--overwrite] [-o <out.flashpkg>]',
    `        (or set ${AUDIO_KEY_ENV}; --key leaves the key in shell history)`,
    '  inbox <inbox-dir> [-o <out.flashpkg>] [--lang <lang>] [--ai]',
    '  mcp [--mirror <sync-dir-or-flashpkg>] [--inbox <inbox-dir>]',
  ].join('\n');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(usageText() + '\n');
    return 0;
  }

  const { positional, flags } = parseArgs(rest);

  if (cmd === 'validate') {
    const target = positional[0];
    if (!target) {
      process.stderr.write('validate requires a file path.\n');
      return 2;
    }
    const res = validateFile(resolve(target), {
      allowRelativePackUrls: Boolean(flags['allow-relative']),
    });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return res.valid ? 0 : 1;
  }

  if (cmd === 'build') {
    const inputDir = positional[0];
    if (!inputDir) {
      process.stderr.write('build requires an input directory.\n');
      return 2;
    }
    const outPath = flagString(flags, 'out');
    const name = flagString(flags, 'name');
    const version = flagString(flags, 'version');
    const language = flagString(flags, 'lang', 'language');
    const res = buildPackageFromDirectory(resolve(inputDir), {
      ...(outPath ? { outPath: resolve(outPath) } : {}),
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(language ? { language } : {}),
      aiProvenance: Boolean(flags['ai']),
    });
    process.stdout.write(
      JSON.stringify(
        {
          packageId: res.packageId,
          outPath: res.outPath,
          decksCount: res.decksCount,
          notesCount: res.notesCount,
          pagesCount: res.pagesCount,
          mediaCount: res.mediaCount,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  if (cmd === 'audio') {
    const inFile = positional[0];
    if (!inFile) {
      process.stderr.write('audio requires an input .flashpkg file path.\n');
      return 2;
    }
    const providerRaw = flagString(flags, 'provider') ?? 'google';
    if (providerRaw !== 'google' && providerRaw !== 'azure' && providerRaw !== 'mock') {
      process.stderr.write(`Unsupported audio provider "${providerRaw}".\n`);
      return 2;
    }
    const provider: AudioProviderKind = providerRaw;
    const outPath = flagString(flags, 'out') ?? inFile;
    const apiKey = await resolveAudioApiKey(flags);
    const azureRegion = flagString(flags, 'region');
    const res = await runAudioFileEnrichment(resolve(inFile), resolve(outPath), {
      provider,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(azureRegion !== undefined ? { azureRegion } : {}),
      overwriteExisting: Boolean(flags['overwrite']),
    });
    process.stdout.write(
      JSON.stringify(
        {
          outPath: res.outPath,
          generatedCount: res.generatedCount,
          reusedCount: res.reusedCount,
          skippedCount: res.skippedCount,
          totalMediaCount: res.totalMediaCount,
          ...(res.failure ? { failure: res.failure } : {}),
        },
        null,
        2,
      ) + '\n',
    );
    if (res.failure) {
      process.stderr.write(
        `Synthesis stopped at note ${res.failure.noteId}: ${res.failure.message}\nThe clips made so far are saved; run the command again to finish the rest.\n`,
      );
      return 1;
    }
    return 0;
  }

  if (cmd === 'inbox') {
    const inboxDir = positional[0];
    if (!inboxDir) {
      process.stderr.write('inbox requires a directory path.\n');
      return 2;
    }
    const outPackagePath = flagString(flags, 'out');
    const language = flagString(flags, 'lang', 'language');
    const res = processInboxFolder(resolve(inboxDir), {
      ...(outPackagePath ? { outPackagePath: resolve(outPackagePath) } : {}),
      ...(language ? { language } : {}),
      aiProvenance: Boolean(flags['ai']),
    });
    if (!outPackagePath && res.processed.length > 0) {
      process.stderr.write(
        'Nothing was written and the files stay in the inbox. Pass -o <out.flashpkg> to save the import (the files then move to imported/).\n',
      );
    }
    process.stdout.write(
      JSON.stringify(
        {
          processed: res.processed,
          failed: res.failed,
          eventsEmitted: res.events.length,
          ...(res.outPackagePath ? { outPackagePath: res.outPackagePath } : {}),
          archived: res.archived,
        },
        null,
        2,
      ) + '\n',
    );
    return res.failed.length > 0 ? 1 : 0;
  }

  if (cmd === 'mcp') {
    const mirrorPath = flagString(flags, 'mirror');
    const inboxDir = flagString(flags, 'inbox');
    await runMcpStdioServer({
      ...(mirrorPath ? { mirrorPath: resolve(mirrorPath) } : {}),
      ...(inboxDir ? { inboxDir: resolve(inboxDir) } : {}),
    });
    return 0;
  }

  process.stderr.write(`Unknown command "${cmd}".\n${usageText()}\n`);
  return 2;
}
