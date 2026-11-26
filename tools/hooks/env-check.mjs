// SessionStart (startup): check this machine and worktree are set up the way the project expects.
// Problems are shown to the owner (systemMessage), never added to Claude's context.
// Ported from Terminal Dusk's tools/hooks/env-check.mjs, plus the fresh-worktree install check.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readInput, git } from './shared.mjs';

function run(cmd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, { shell: true, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      p.kill();
      resolve(false);
    }, 10_000);
    p.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const input = await readInput();
const problems = [];

if (process.env.ANTHROPIC_API_KEY) {
  problems.push(
    'ANTHROPIC_API_KEY is set, so Claude Code bills the API instead of your plan. Remove it from your environment variables.',
  );
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 24)
  problems.push(`Node ${process.versions.node} is too old; install Node 24 or newer.`);

// A new worktree starts without node_modules, so the gate and the edit checks would not run.
const root = git(['rev-parse', '--show-toplevel'], input.cwd ?? process.cwd());
if (
  root &&
  existsSync(path.join(root, 'package.json')) &&
  !existsSync(path.join(root, 'node_modules'))
) {
  problems.push('This worktree has no node_modules yet. Run: pnpm install --frozen-lockfile');
}

const [pnpm, gh, ghAuth] = await Promise.all([
  run('pnpm --version'),
  run('gh --version'),
  run('gh auth status'),
]);
if (!pnpm) problems.push('pnpm was not found. Install it, then restart the Claude app.');
if (!gh) problems.push('The GitHub CLI (gh) was not found. Install it from cli.github.com.');
else if (!ghAuth) problems.push("The GitHub CLI isn't signed in. Run: gh auth login");

if (problems.length) {
  process.stdout.write(
    JSON.stringify({ systemMessage: `Flashcards setup:\n- ${problems.join('\n- ')}` }),
  );
}
