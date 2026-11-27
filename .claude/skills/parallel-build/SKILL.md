---
name: parallel-build
description: Orchestrate two or more build agents at once in this repo (a batch of follow-ups, an overnight run, working the follow-ups down in rounds). Use before starting the second concurrent build agent, or when the owner asks for a batch.
---

You are the **orchestrator**: you dispatch work to build agents, get each pull request reviewed and merged, run further rounds on what the merges left behind, and end with a short report. You write no product code, and you keep your context small.

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
3. Send blockers back to the build agent with `SendMessage`; it still has its context. Two fix passes at most, then mark it **blocked** for the owner.
4. Merge as CLAUDE.md "Finishing a pull request" says, one at a time, in dependency order. After each merge, tell every agent with an open PR to merge `origin/main` into its branch, re-run `pnpm gate` and `pnpm size`, and push: each branch passes the size budget alone, but their sum can overflow it.

## Rounds

Fixing items raises new ones, so a run goes in **rounds**, 3 at most. Round 1 is the batch the owner asked for. A round ends when every one of its workstreams is merged or blocked (an agent that stops without a PR counts as blocked).

1. **Triage** every new item the round raised: reviewer and agy notes that did not block, Sonar issues left open, each PR's "Decisions needed", and anything an agent found out of scope. Put each in the ledger under its round as one of:
   - **fallout**: a bug, gap or missing test that a PR merged in this run introduced or left half-done;
   - **decision**: needs the owner (design, scope, money, identity, deleting data);
   - **backlog**: everything else, good ideas included.
2. **Count the round's net**: items closed (workstreams of this round whose PR merged; a blocked one does not count) minus new items of all three kinds.
3. **Start the next round** when the round just ended raised fallout, its net is above zero and fewer than 3 rounds have run. Its batch is that fallout alone; decisions and backlog wait for the finish, and a blocked workstream stays with the owner. Otherwise, finish: fallout not yet worked moves to backlog.

## Finish

1. One last small agent, in a docs PR, ticks the merged items off `docs/follow-ups.md`, adds the backlog items (unworked fallout included) under their areas, and adds a "Decisions needed (<batch>)" section listing every decision item and every default an agent picked.
2. Final message, short: merged PRs (number and title), open or blocked PRs with the reason, each round's closed, added and net counts, why the run stopped and the fallout it left unworked, decisions needed with your recommendation, and what is unverified (devices, signing, real services).
