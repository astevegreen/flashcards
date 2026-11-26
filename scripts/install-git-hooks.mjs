// `pnpm install` (prepare): point git at the tracked hooks in .githooks/, for every agent and person
// working in this clone. core.hooksPath is relative, so each worktree runs its own checkout's hooks,
// and a worktree on a branch without .githooks/ runs none. Outside a git checkout (a tarball, a Docker
// build) it does nothing.
import { spawnSync } from 'node:child_process';

const git = (args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true }); // NOSONAR (javascript:S4036)
if (git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() !== 'true') process.exit(0);
const current = git(['config', '--get', 'core.hooksPath']).stdout?.trim();
if (current !== '.githooks') {
  const r = git(['config', 'core.hooksPath', '.githooks']);
  if (r.status !== 0) console.warn(`Could not set core.hooksPath: ${r.stderr.trim()}`);
  else {
    const was = current ? ` (was ${current})` : '';
    console.log(
      `Git hooks: core.hooksPath set to .githooks${was}, for every worktree of this clone.`,
    );
  }
}
