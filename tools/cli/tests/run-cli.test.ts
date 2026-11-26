import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/index.ts';

// §9: `runCli` (the command dispatch and exit codes) and `runMcpStdioServer` (the stdio loop).
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flash-run-cli-'));
  tempDirs.push(dir);
  return dir;
}

/** Runs `flash-cli` in this process, capturing what it writes. */
async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => out.push(String(chunk)) > 0);
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => err.push(String(chunk)) > 0);
  try {
    const code = await runCli(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe('runCli', () => {
  it('prints usage and exits 0 for no command, --help and -h', async () => {
    for (const argv of [[], ['--help'], ['-h']]) {
      const res = await cli(...argv);
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/^Usage: flash-cli <command>/);
      expect(res.stderr).toBe('');
    }
  });

  it('exits 2 with usage on stderr for an unknown command', async () => {
    const res = await cli('frobnicate');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Unknown command "frobnicate"');
    expect(res.stderr).toContain('Usage: flash-cli');
    expect(res.stdout).toBe('');
  });

  it('exits 2 when a command misses its path, and for an unsupported audio provider', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['validate'], /validate requires a file path/],
      [['build'], /build requires an input directory/],
      [['audio'], /audio requires an input \.flashpkg/],
      [['inbox', '--lang', 'ko'], /inbox requires a directory path/],
      [['audio', 'x.flashpkg', '--provider', 'polly'], /Unsupported audio provider "polly"/],
    ];
    for (const [argv, message] of cases) {
      const res = await cli(...argv);
      expect(res.code, argv.join(' ')).toBe(2);
      expect(res.stderr).toMatch(message);
    }
  });

  it('build writes a package that validate accepts (exit 0) and validate rejects junk (exit 1)', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'basics.csv'), 'Word,Meaning\n물,water\n불,fire\n');
    const outPath = join(dir, 'out', 'basics.flashpkg');

    const built = await cli('build', dir, '-o', outPath, '--name', 'Basics', '--lang', 'ko');
    expect(built.code).toBe(0);
    expect(JSON.parse(built.stdout)).toMatchObject({ outPath, decksCount: 1, notesCount: 2 });
    expect(existsSync(outPath)).toBe(true);

    const valid = await cli('validate', outPath);
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ valid: true, kind: 'flashpkg' });

    const junk = join(dir, 'junk.flashpkg');
    writeFileSync(junk, 'not a zip');
    const invalid = await cli('validate', junk);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ valid: false });
  });
});

const bin = fileURLToPath(new URL('../bin/flash-cli.mjs', import.meta.url));

/** How long the server may take to answer and exit before it is killed, and the test's own limit above it. */
const MCP_KILL_AFTER_MS = 10_000;
const MCP_TEST_TIMEOUT_MS = 20_000;

/**
 * Starts `flash-cli mcp` as a real process, writes `lines` to its stdin, then closes it. A server
 * that has not exited after MCP_KILL_AFTER_MS is killed and the promise rejects, so a hung child
 * fails the test instead of outliving it.
 */
function runMcpProcess(
  lines: readonly string[],
): Promise<{ code: number | null; responses: unknown[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`flash-cli mcp did not exit within ${MCP_KILL_AFTER_MS} ms; killed it`));
    }, MCP_KILL_AFTER_MS);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const responses = stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown);
      resolve({ code, responses, stderr });
    });
    child.stdin.end(lines.map((line) => `${line}\n`).join(''));
  });
}

describe('runMcpStdioServer (flash-cli mcp)', () => {
  it(
    'answers one JSON line per request, survives bad input, and exits 0 when stdin closes',
    async () => {
      const { code, responses, stderr } = await runMcpProcess([
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {} },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        '',
        '{"jsonrpc":"2.0","id":2,',
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
        JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
        JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'no/such/method' }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'list_decks' },
        }),
      ]);
      expect(stderr).toBe('');
      expect(code).toBe(0);

      // The notification and the blank line get no reply; the cut-off line gets a parse error.
      const ids = responses.map((r) => (r as { id: unknown }).id);
      expect(ids).toEqual([1, null, 3, 4, 5, 6]);
      const [init, parse, list, ping, unknown, call] = responses as Array<{
        result?: Record<string, unknown>;
        error?: { code: number };
      }>;
      expect(init?.result?.['serverInfo']).toMatchObject({ name: 'flashcards-local-mcp' });
      expect(parse?.error?.code).toBe(-32700);
      const tools = (list?.result?.['tools'] as Array<{ name: string }> | undefined) ?? [];
      expect(tools.map((t) => t.name)).toContain('list_decks');
      expect(ping?.result).toEqual({});
      expect(unknown?.error?.code).toBe(-32601);
      // No --mirror: the tool runs on an empty collection rather than failing the server.
      expect(call?.error).toBeUndefined();
      expect(call?.result).toBeDefined();
    },
    MCP_TEST_TIMEOUT_MS,
  );
});
