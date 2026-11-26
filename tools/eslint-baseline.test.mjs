// REACT_COMPILER_BASELINE in eslint.config.js turns React Compiler checks off file by file for code
// that predates them. It may only shrink: these pins fail when an entry is added, and when one is
// removed, so the pin is lowered in the same change that fixes the file.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { REACT_COMPILER_BASELINE } from '../eslint.config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILES = 37;
const MAX_RULE_ENTRIES = 45;

test('the react-hooks baseline never grows (lower the pins when you fix a file)', () => {
  const files = Object.keys(REACT_COMPILER_BASELINE).length;
  const entries = Object.values(REACT_COMPILER_BASELINE).flat().length;
  assert.ok(files <= MAX_FILES, `baseline lists ${files} files, at most ${MAX_FILES}`);
  assert.ok(
    entries <= MAX_RULE_ENTRIES,
    `baseline has ${entries} rules, at most ${MAX_RULE_ENTRIES}`,
  );
  assert.equal(files, MAX_FILES, `baseline shrank to ${files} files: lower MAX_FILES to match`);
  assert.equal(entries, MAX_RULE_ENTRIES, `baseline shrank to ${entries}: lower MAX_RULE_ENTRIES`);
});

test('every baselined file still exists, so a renamed file is not silently exempt', () => {
  for (const file of Object.keys(REACT_COMPILER_BASELINE)) {
    assert.ok(existsSync(join(ROOT, 'packages', 'ui', 'src', file)), `${file} is gone: drop it`);
  }
});
