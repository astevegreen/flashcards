---
name: parallel-build
description: Orchestrate two or more build agents at once in this repo (a batch of follow-ups, an overnight run). Use before starting the second concurrent build agent, or when the owner asks for a batch.
---

You are the **orchestrator**: you dispatch work to build agents, get each pull request reviewed and merged, and end with a short report. You write no product code, and you keep your context small.

## Dispatch

- **Start each workstream** as its own session (`start_session`, `context: "fresh"`, `use_worktree: true`), or, when the owner is on Remote Control (it refuses `start_session`), as a background `Agent` call that makes its own worktree off `origin/main`. Name a `model` and `effort` on every one: Opus medium for engine, sync, import and native work; Sonnet medium for UI copy, docs and content.
- **At most 4 code-writing agents at once.** Research-only agents don't count. Two workstreams that touch the same files run one after the other.
- **Give each agent a distinct `E2E_PORT`** (4401, 4402, …) **and its own scratch subfolder**: subagents share the session scratchpad, and one agent's PR body has overwritten another's.
- **Send the child rules below** with every brief.
- **Keep a ledger** at `<scratchpad>/ledger.md`: per workstream, its session or agent id, branch, PR, state (queued / running / PR open / in review / fixing / merged / blocked) and a one-line note. Update it after every event; after a compaction, read it before anything else.
- **Don't poll.** A session that ends a turn wakes you; a background agent notifies you when done.

## Child rules (send with every brief)

> Read `AGENTS.md` first and follow its "Workflow" section. Your `E2E_PORT` is <port> and your scratch folder is <path>. Done means: the change is built with unit tests (e2e where there is UI); `pnpm gate`, `pnpm build` and `pnpm size` pass locally; a PR against `main` is open with what changed, the bundle size before and after, and what could not be verified; and CI is green. Don't edit `docs/follow-ups.md` (the orchestrator does, once, at the end). Add no content or data under share-alike or unclear licences. A product decision you hit: pick the least-committal, reversible option, ship it, and list it under "Decisions needed" in the PR. Don't merge your PR or touch other PRs. Stuck after two real attempts: stop and report what blocks you. Your final message: the PR URL, a 3–5 line summary, and an "unverified" list.

## Review and merge, per pull request

1. Check CI yourself with `gh pr checks <n>`, not the agent's word.
2. Run a fresh `reviewer` agent on the PR (only the PR number and the item it builds, never your opinion), then `node tools/gemini-audit.mjs pr <n>` and `node tools/sonar-gate.mjs <n>`. Reviewers find real must-fixes in about half of PRs here.
3. Send blockers back to the build agent with `SendMessage`; it still has its context. Two rounds at most, then mark it **blocked** for the owner.
4. Merge as CLAUDE.md "Finishing a pull request" says, one at a time, in dependency order. After each merge, tell every agent with an open PR to merge `origin/main` into its branch, re-run `pnpm gate` and `pnpm size`, and push: each branch passes the size budget alone, but their sum can overflow it.

## Finish

1. One last small agent ticks the merged items off `docs/follow-ups.md` and adds a "Decisions needed (<batch>)" section listing every default an agent picked, in a docs PR.
2. Final message, short: merged PRs (number and title), open or blocked PRs with the reason, decisions needed with your recommendation, and what is unverified (devices, signing, real services).
