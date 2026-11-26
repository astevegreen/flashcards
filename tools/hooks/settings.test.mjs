// Tests for the permission rules and hook wiring in .claude/settings.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

function settings() {
  try {
    return JSON.parse(read('.claude/settings.json'));
  } catch (err) {
    throw new Error(
      `.claude/settings.json is not strict JSON, so Claude Code would ignore it: ${err.message}`,
      { cause: err },
    );
  }
}
const { permissions, hooks } = settings();

// A rule like `Bash(git push * main)` matches a command when the pattern, with `*` as any run of
// characters, covers the whole command. Close enough to Claude Code's prefix/wildcard matching to
// catch a rule that no longer covers the command it was written for.
function matches(rule, tool, command) {
  const m = new RegExp(`^${tool}\\((.*)\\)$`).exec(rule);
  if (!m) return false;
  const re = m[1].split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${re.join('.*')}$`).test(command);
}
const verdict = (tool, command) => {
  if (permissions.deny.some((r) => matches(r, tool, command))) return 'deny';
  if (permissions.ask.some((r) => matches(r, tool, command))) return 'ask';
  if (permissions.allow.some((r) => matches(r, tool, command))) return 'allow';
  return 'none';
};

test('pushing a branch for a pull request runs without asking', () => {
  for (const cmd of ['git push -u origin feat/study-gestures', 'git push origin fix/sonar-58'])
    assert.equal(verdict('Bash', cmd), 'allow', cmd);
});

test('main takes no direct pushes, in Bash and PowerShell (AGENTS.md "Workflow")', () => {
  for (const cmd of [
    'git push origin main',
    'git push -u origin main',
    'git push origin HEAD:main',
    'git push origin main --tags',
    'git push origin HEAD:refs/heads/main',
    'git -C ../Korean push origin main',
  ]) {
    assert.equal(verdict('Bash', cmd), 'deny', `Bash ${cmd}`);
    assert.equal(verdict('PowerShell', cmd), 'deny', `PowerShell ${cmd}`);
  }
});

test('force-pushes, rebases and history rewrites are denied', () => {
  for (const cmd of [
    'git push --force origin feat/x',
    'git push -f origin feat/x',
    'git push origin feat/x -f',
    'git push origin +feat/x',
    'git push origin feat/x --force-with-lease',
    'git rebase origin/main',
    'git reset --hard origin/main',
    'git clean -fdx',
    'git filter-repo --path x',
  ]) {
    assert.equal(verdict('Bash', cmd), 'deny', `Bash ${cmd}`);
    assert.equal(verdict('PowerShell', cmd), 'deny', `PowerShell ${cmd}`);
  }
});

test('git stash is denied: the stash list is shared by every worktree', () => {
  for (const cmd of ['git stash', 'git stash pop', 'git stash push -m wip', 'git -C x stash'])
    assert.equal(verdict('Bash', cmd), 'deny', cmd);
  assert.equal(verdict('PowerShell', 'git stash'), 'deny');
});

test('changing the remote or the repository is denied', () => {
  for (const cmd of ['git remote set-url origin https://x', 'gh repo edit --visibility private'])
    assert.equal(verdict('Bash', cmd), 'deny', cmd);
});

test('skipping git hooks always asks the owner, in Bash and PowerShell', () => {
  for (const cmd of [
    'git commit --no-verify -m x',
    'git commit -n -m x',
    'git commit -m x -n -q',
    'git push --no-verify origin feat/x',
    'git config core.hooksPath /dev/null',
  ]) {
    assert.equal(verdict('Bash', cmd), 'ask', `Bash ${cmd}`);
    assert.equal(verdict('PowerShell', cmd), 'ask', `PowerShell ${cmd}`);
  }
});

test("deleting a branch or a worktree asks: it may be another agent's work (AGENTS.md Workflow)", () => {
  for (const cmd of [
    'git branch -D feat/x',
    'git branch -d feat/x',
    'git branch --delete feat/x',
    'git worktree remove --force ../Korean-other',
    'git push origin --delete feat/x',
    'git push origin -d feat/x',
    'git push origin :feat/x',
  ]) {
    assert.equal(verdict('Bash', cmd), 'ask', `Bash ${cmd}`);
    assert.equal(verdict('PowerShell', cmd), 'ask', `PowerShell ${cmd}`);
  }
  for (const cmd of [
    'git branch --show-current',
    'git worktree list',
    'git worktree add ../K -b x',
  ])
    assert.equal(verdict('Bash', cmd), 'allow', cmd);
});

test('a push the settings cannot read as main is left to .githooks/pre-push (githooks.test.mjs)', () => {
  // `git push origin HEAD` while on main names no branch, so only the pre-push hook sees it is main.
  assert.equal(verdict('Bash', 'git push origin HEAD'), 'allow');
});

test('pnpm --filter runs package scripts without asking, but an arbitrary command through it asks', () => {
  assert.equal(verdict('Bash', 'pnpm --filter @flash/core test'), 'allow');
  for (const cmd of [
    'pnpm --filter @flash/web exec git stash',
    'pnpm --filter @flash/web dlx some-tool',
  ])
    assert.equal(verdict('Bash', cmd), 'ask', cmd);
});

test('opening, readying and auto-merging a pull request run without asking', () => {
  for (const cmd of [
    'gh pr create --fill',
    'gh pr ready 70',
    'gh pr merge 70 --auto --squash',
    'pnpm gate',
  ])
    assert.equal(verdict('Bash', cmd), 'allow', cmd);
  assert.equal(verdict('Bash', 'gh pr merge 70 --squash'), 'none', 'a merge without --auto');
});

test('settings and the hooks they wire ask before an edit, and every wired script exists', () => {
  assert.ok(permissions.ask.includes('Edit(/.claude/settings.json)'));
  assert.ok(permissions.ask.includes('Edit(/tools/hooks/**)'));
  const wired = [...JSON.stringify(hooks).matchAll(/CLAUDE_PROJECT_DIR\}\/([^"]+)/g)];
  assert.ok(wired.length > 0);
  for (const [, script] of wired) {
    assert.ok(
      script.startsWith('tools/hooks/'),
      `${script} is not covered by Edit(/tools/hooks/**)`,
    );
    assert.ok(existsSync(path.join(ROOT, script)), `${script} does not exist`);
  }
});

test('the Stop hook runs a gate script that package.json defines', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.gate, 'package.json has no gate script');
  assert.match(JSON.stringify(hooks.Stop), /tools\/hooks\/gate\.mjs/);
});

test("CI's required verify check aggregates checks, never skips, and checks runs the whole gate", () => {
  const ci = read('.github/workflows/ci.yml');
  const verify = ci.slice(ci.indexOf('\n  verify:'), ci.indexOf('\n  starter-decks:'));
  const checks = ci.slice(ci.indexOf('\n  checks:'), ci.indexOf('\n  verify:'));
  assert.match(verify, /needs: \[checks\]/);
  // A skipped required check counts as passed, so verify runs (and fails) even when checks was cancelled.
  assert.match(verify, /if: \$\{\{ always\(\) \}\}/);
  for (const step of [
    'typecheck',
    'lint',
    'format:check',
    'test',
    'test:tools',
    'build',
    'size',
    'test:e2e',
  ])
    assert.match(checks, new RegExp(`run: pnpm ${step}\n`), step);
});
