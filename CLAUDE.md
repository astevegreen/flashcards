@AGENTS.md

## Claude Code

AGENTS.md above is shared with Antigravity; keep shared rules there and only Claude-specific ones here.

- **Parallel builds:** run the `parallel-build` skill before starting two or more build agents at once.
- **Search** with the `scout` agent ("where is X"); keep file dumps out of the main context.
- `.claude/settings.json` hooks check each edited file (ESLint, Prettier) and run `pnpm gate` before you finish. Fix the change, not the check.

## Finishing a pull request

Nothing waits for the owner's code review: CI, the `reviewer` agent and agy decide, and `git revert` is the net.

1. Run the `reviewer` agent on the branch and `node tools/gemini-audit.mjs pr <n>` (agy's second look; it adds a deep rail audit when the diff touches settings, hooks, agents, skills, workflows, git hooks, lint or size config, or these instruction files). Fix their blockers once, then run both again.
2. Verdict `merge`, no reviewer blocker, and `node tools/sonar-gate.mjs <n>` prints `Sonar: OK`: `gh pr merge <n> --auto --squash`. Minor concerns and agy's notes go in a PR comment, or in `docs/follow-ups.md` when they are real work.
3. A blocker left after the fix pass: comment the blockers, label the PR `held` and leave auto-merge off. Verdict `hold` (the rail audit says the change loosens a check): the same, with a comment starting `Held: rail audit:`, for the owner, unless the owner asked for that loosening in their own words in chat; then quote them in the comment and merge. Verdict `retry` or Sonar exit 2: a machine failure, so run it again later and say so.

End with what changed (behaviour, one bullet each), what proves it, follow-ups added, and anything you could not settle.
