// The tracked git hooks (.githooks/) and the prepare script that switches them on (scripts/install-git-hooks.mjs).
// Each test makes a throwaway repository with a bare remote and lets git run the real hooks, so git's own sh runs
// them the way it does for every agent and person (Claude Code, Antigravity, the owner).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanEnv, sh, tempRepo, writeFiles } from './test-helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOOKS_DIR = path.join(ROOT, '.githooks');
const INSTALL = path.join(ROOT, 'scripts', 'install-git-hooks.mjs');

const git = (args, cwd) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: cleanEnv() });

// A repository on main with a bare `origin` that already has main, and the real hooks switched on. It has no
// node_modules, so pre-push skips `pnpm gate` and pre-commit skips Prettier unless a test adds a stand-in.
function repoWithRemote() {
  const dir = tempRepo();
  const remote = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flash-hook-remote-')));
  sh('git', ['init', '-q', '--bare', remote], dir);
  sh('git', ['remote', 'add', 'origin', remote], dir);
  sh('git', ['push', '-q', 'origin', 'main'], dir); // before the hooks are on
  sh('git', ['config', 'core.hooksPath', HOOKS_DIR], dir);
  return dir;
}

test('pre-push refuses main however the push names it', () => {
  const dir = repoWithRemote();
  sh('git', ['switch', '-q', '-c', 'feat/x'], dir);
  writeFiles(dir, { 'a.md': 'a\n' });
  sh('git', ['add', 'a.md'], dir);
  sh('git', ['commit', '-q', '-m', 'a'], dir);
  for (const args of [
    ['push', 'origin', 'HEAD:main'],
    ['push', 'origin', 'HEAD:refs/heads/main'],
    ['push', 'origin', ':main'],
  ]) {
    const r = git(args, dir);
    assert.notEqual(r.status, 0, `git ${args.join(' ')} went through`);
    assert.match(r.stderr, /main takes no direct pushes/, args.join(' '));
  }
  sh('git', ['switch', '-q', 'main'], dir);
  sh('git', ['merge', '-q', '--ff-only', 'feat/x'], dir);
  const onMain = git(['push', 'origin', 'HEAD'], dir);
  assert.notEqual(onMain.status, 0, 'git push origin HEAD on main went through');
  assert.match(onMain.stderr, /main takes no direct pushes/);
});

test('pre-push lets a branch through, and says why the gate was skipped without node_modules', () => {
  const dir = repoWithRemote();
  sh('git', ['switch', '-q', '-c', 'feat/y'], dir);
  const r = git(['push', '-q', '-u', 'origin', 'feat/y'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /pnpm gate was skipped/);
});

test('pre-commit checks only the staged files with Prettier, and blocks the commit when one fails', () => {
  const dir = repoWithRemote();
  // A stand-in for Prettier: fails when any file argument's name holds "bad".
  writeFiles(dir, {
    'node_modules/prettier/bin/prettier.cjs': [
      "const files = process.argv.slice(2).filter((a) => !a.startsWith('-') && a !== 'warn');",
      "process.exit(files.some((f) => f.includes('bad')) ? 1 : 0);",
    ].join('\n'),
    'good.md': 'good\n',
    'bad.md': 'bad\n',
  });
  sh('git', ['add', 'good.md'], dir);
  const ok = git(['commit', '-q', '-m', 'good'], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(sh('git', ['show', '-s', '--format=%s'], dir), 'good');

  sh('git', ['add', 'bad.md'], dir);
  const blocked = git(['commit', '-q', '-m', 'bad'], dir);
  assert.notEqual(blocked.status, 0, 'a commit with an unformatted file went through');
  assert.match(blocked.stderr, /not Prettier-formatted/);
  assert.equal(sh('git', ['show', '-s', '--format=%s'], dir), 'good');
});

test('pre-commit skips with a note when the worktree has no node_modules', () => {
  const dir = repoWithRemote();
  writeFiles(dir, { 'b.md': 'b\n' });
  sh('git', ['add', 'b.md'], dir);
  const r = git(['commit', '-q', '-m', 'b'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /format check was skipped/);
});

test('the prepare script points core.hooksPath at .githooks inside a checkout, and does nothing outside one', () => {
  const dir = tempRepo();
  const r = spawnSync(process.execPath, [INSTALL], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: cleanEnv(),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sh('git', ['config', '--get', 'core.hooksPath'], dir), '.githooks');

  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flash-no-repo-')));
  const o = spawnSync(process.execPath, [INSTALL], {
    cwd: outside,
    encoding: 'utf8',
    windowsHide: true,
    env: cleanEnv({ GIT_CEILING_DIRECTORIES: path.dirname(outside) }),
  });
  assert.equal(o.status, 0, o.stderr);
  assert.equal(o.stderr, '');
});

test('pre-push runs pnpm gate with no GIT_* repository variables, so the tool tests never touch the real repo', () => {
  // Agents push from worktrees, where git hands its hooks an absolute GIT_DIR. The gate's tool tests run git in
  // throwaway repositories; with GIT_DIR inherited, their `git config`, `add` and `commit` would hit this one.
  const main = repoWithRemote();
  const wt = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flash-hook-wt-'))), 'wt');
  sh('git', ['worktree', 'add', '-q', '-b', 'feat/z', wt], main);
  // A stand-in `pnpm` on PATH that records the repository variables the hook passes to the gate.
  const bin = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flash-hook-bin-')));
  const out = path.join(bin, 'env.txt');
  const outPosix = out.replaceAll(path.sep, '/');
  writeFiles(bin, { pnpm: `#!/bin/sh\nenv | grep '^GIT_' > '${outPosix}'\nexit 0\n` });
  chmodSync(path.join(bin, 'pnpm'), 0o755);
  writeFiles(wt, { 'node_modules/.keep': '' });
  const r = spawnSync('git', ['push', '-q', '-u', 'origin', 'feat/z'], {
    cwd: wt,
    encoding: 'utf8',
    windowsHide: true,
    env: cleanEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }),
  });
  assert.equal(r.status, 0, r.stderr);
  const seen = readFileSync(out, 'utf8');
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
    assert.doesNotMatch(seen, new RegExp(`^${name}=`, 'm'), `${name} reached pnpm gate`);
});
