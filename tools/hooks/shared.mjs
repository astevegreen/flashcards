// Helpers shared by the Claude Code hook scripts. Node built-ins only.
// Ported from Terminal Dusk's tools/hooks/shared.mjs (the parts these hooks use).
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function toPosix(p) {
  return p.replace(/\\/g, '/');
}

export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Resolve symlinks and Windows short names (C:\Users\RUNNER~1) in the part of `p` that exists,
// so paths compare equal to the long form git reports.
export function canonical(p) {
  let dir = path.resolve(p);
  const rest = [];
  while (!existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) break;
    rest.unshift(path.basename(dir));
    dir = up;
  }
  try {
    dir = realpathSync.native(dir);
  } catch {
    // keep the unresolved path
  }
  return path.join(dir, ...rest);
}

function existingDir(p) {
  let dir = path.resolve(p);
  while (!(existsSync(dir) && statSync(dir).isDirectory())) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dir;
}

// The git root that owns `target`: the worktree's own root inside a worktree, or null outside any repository.
export function repoRootFor(target) {
  const root = git(['rev-parse', '--show-toplevel'], existingDir(target));
  return root ? canonical(root) : null;
}

export function limitLines(text, max) {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length <= max) return lines.join('\n');
  return [...lines.slice(0, max - 1), `... (${lines.length - max + 1} more lines)`].join('\n');
}
