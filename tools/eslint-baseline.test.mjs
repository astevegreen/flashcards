// REACT_COMPILER_BASELINE in eslint.config.js turns React Compiler checks off file by file for code
// that predates them. It may only shrink: it must equal PINNED below, entry for entry, so adding a
// file or a rule, or swapping one file for another, fails. Fixing a file means deleting its rule
// (or its line) both there and here, in the same change. Never add to either list.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { REACT_COMPILER_BASELINE } from '../eslint.config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** packages/ui/src file and the react-hooks rules off in it, as of 25 Nov 2026 (review T3). */
const PINNED = new Map([
  ['FlashcardsApp.tsx', ['refs']],
  ['layout/ShellNotices.tsx', ['purity']],
  ['screens/BrowseScreen.tsx', ['incompatible-library']],
  ['screens/LibraryScreen.tsx', ['purity', 'set-state-in-effect']],
  ['screens/StatsScreen.tsx', ['purity']],
  ['screens/StudyScreen.tsx', ['purity', 'set-state-in-effect']],
  ['state/AppContext.tsx', ['refs']],
  ['study/answerModes/ChoiceMode.tsx', ['set-state-in-effect']],
  ['study/answerModes/ClozeMode.tsx', ['set-state-in-effect']],
  ['study/answerModes/DrawMode.tsx', ['set-state-in-effect']],
  ['study/answerModes/TypedAnswerPanel.tsx', ['set-state-in-effect']],
]);

test('the react-hooks baseline is exactly the pinned list: nothing added or swapped in', () => {
  for (const [file, rules] of Object.entries(REACT_COMPILER_BASELINE)) {
    const allowed = PINNED.get(file);
    assert.ok(allowed, `${file} is not in the pinned baseline: fix the file instead`);
    for (const rule of rules) {
      assert.ok(allowed.includes(rule), `${file}: ${rule} is not pinned: fix the file instead`);
    }
  }
  for (const [file, rules] of PINNED) {
    const listed = REACT_COMPILER_BASELINE[file] ?? [];
    for (const rule of rules) {
      assert.ok(listed.includes(rule), `${file}: ${rule} was fixed: delete it from PINNED too`);
    }
  }
});

test('every baselined file still exists, so a renamed file is not silently exempt', () => {
  for (const file of Object.keys(REACT_COMPILER_BASELINE)) {
    assert.ok(existsSync(join(ROOT, 'packages', 'ui', 'src', file)), `${file} is gone: drop it`);
  }
});
