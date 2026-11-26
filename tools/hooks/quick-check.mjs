// PostToolUse (Edit|Write): fast checks on the one file just edited, so CI's lint and format:check
// failures show up at edit time. Lints code with the repo's ESLint and checks the file with the repo's
// Prettier. Silent when everything passes; otherwise up to 20 lines go back to Claude (exit 2).
// It never changes files.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readInput, repoRootFor, canonical, toPosix, limitLines } from './shared.mjs';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const PRETTIER = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|ya?ml)$/i;

const input = await readInput();
const file = input.tool_input?.file_path;
if (!file || !existsSync(file)) process.exit(0);

// Only files inside a git repository or worktree are checked; a scratchpad file is not the repo's to lint.
const root = repoRootFor(file);
if (!root) process.exit(0);
const rel = toPosix(path.relative(root, canonical(file)));
if (rel.startsWith('../') || path.isAbsolute(rel)) process.exit(0);
const problems = [];
const run = (script, args) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
  });

// 1. ESLint errors (warnings pass).
const eslint = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
if (CODE.test(file) && existsSync(eslint)) {
  const r = run(eslint, ['--format', 'json', '--no-warn-ignored', file]);
  try {
    for (const result of JSON.parse(r.stdout)) {
      for (const m of result.messages.filter((x) => x.severity === 2)) {
        problems.push(`${rel}:${m.line ?? 0} ${m.message}${m.ruleId ? ` (${m.ruleId})` : ''}`);
      }
    }
  } catch {
    if (r.status !== 0 && r.status !== 1) {
      problems.push(`${rel}: eslint failed to run: ${(r.stderr || '').trim().split('\n')[0]}`);
    }
  }
}

// 2. Prettier: the same check as `pnpm format:check`, on this file only (it honours .prettierignore).
const prettier = path.join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
if (PRETTIER.test(file) && existsSync(prettier)) {
  const r = run(prettier, ['--check', '--log-level', 'warn', file]);
  if (r.status === 1) {
    problems.push(`${rel} is not Prettier-formatted. Run: pnpm exec prettier --write "${rel}"`);
  } else if (r.status !== 0) {
    problems.push(`${rel}: prettier failed to run: ${(r.stderr || '').trim().split('\n')[0]}`);
  }
}

if (problems.length) {
  process.stderr.write(
    limitLines(`quick-check found problems in ${rel}:\n${problems.join('\n')}`, 20) + '\n',
  );
  process.exit(2);
}
