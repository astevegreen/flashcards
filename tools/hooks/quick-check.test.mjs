import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHook, tempRepo, writeFiles } from './test-helpers.mjs';

// Stand-ins for the repo's ESLint and Prettier, so the tests need no install: ESLint reports an error
// for any file containing "BAD", and Prettier exits 1 (unformatted) for any file containing "UGLY".
const fakeTools = {
  'package.json': '{"name":"t","private":true}\n',
  'node_modules/eslint/bin/eslint.js': `
const fs = require("node:fs");
const file = process.argv[process.argv.length - 1];
const bad = fs.readFileSync(file, "utf8").includes("BAD");
process.stdout.write(JSON.stringify([{ messages: bad ? [{ severity: 2, line: 1, message: "Unexpected BAD", ruleId: "no-bad" }] : [] }]));
process.exit(bad ? 1 : 0);
`,
  'node_modules/prettier/bin/prettier.cjs': `
const fs = require("node:fs");
const file = process.argv[process.argv.length - 1];
process.exit(fs.readFileSync(file, "utf8").includes("UGLY") ? 1 : 0);
`,
  'node_modules/eslint/package.json': '{"type":"commonjs"}\n',
};
const repo = tempRepo(fakeTools);
const check = (rel, content) => {
  writeFiles(repo, { [rel]: content });
  return runHook('quick-check.mjs', {
    cwd: repo,
    tool_name: 'Write',
    tool_input: { file_path: path.join(repo, rel) },
  });
};

test('a clean file passes silently', () => {
  const r = check('packages/core/src/ok.ts', 'export const a = 1;\n');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('an ESLint error goes back to Claude with its line and rule', () => {
  const r = check('packages/core/src/bad.ts', 'BAD\n');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /packages\/core\/src\/bad\.ts:1 Unexpected BAD \(no-bad\)/);
});

test('an unformatted file goes back to Claude with the fix', () => {
  const r = check('docs/notes.md', 'UGLY\n');
  assert.equal(r.status, 2);
  assert.match(
    r.stderr,
    /docs\/notes\.md is not Prettier-formatted\. Run: pnpm exec prettier --write/,
  );
});

test('a deleted or missing file is ignored', () => {
  const r = runHook('quick-check.mjs', {
    cwd: repo,
    tool_input: { file_path: path.join(repo, 'nope.ts') },
  });
  assert.equal(r.status, 0);
});

test('a file outside any repository is ignored', () => {
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flash-outside-')));
  writeFiles(outside, { 'scratch.mjs': 'BAD UGLY\n' });
  const r = runHook(
    'quick-check.mjs',
    {
      cwd: outside,
      tool_name: 'Write',
      tool_input: { file_path: path.join(outside, 'scratch.mjs') },
    },
    { env: { GIT_CEILING_DIRECTORIES: path.dirname(outside) } },
  );
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});
