# Flashcards: Gemini

`AGENTS.md` is the rulebook for every agent in this repository, you included: read it in full before you change anything. `docs/design_blueprint.md` is the source of truth for architecture and scope.

You work here in two roles:

- **Author (Antigravity):** you build features like any other agent, on your own branch and worktree, following AGENTS.md "Workflow". Open the pull request and stop there: a Claude Code session runs the reviewer and audit, then merges.
- **Reviewer (headless `agy -p`, the second look on a pull request):** every command is blocked in a headless run and ends it with no answer, so read files only and answer in the reply, in the format the prompt gives.
