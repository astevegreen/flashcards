Audit one pull request. The material file holds its diff and the linked task spec, if any.
Judge it against AGENTS.md (its hard rules and Workflow) and `docs/design_blueprint.md`. Read surrounding code from
disk only where the diff is unclear.

Check:

- does the diff do what the pull request and its spec say, and nothing outside their scope
- `packages/core` purity: no React, DOM, IndexedDB/Dexie, `@flash/platform-web`, `@flash/ui` or `node:*` import
- events are the truth: every change appends an immutable event, state is derived by a deterministic `replay`,
  reviews sort by `(reviewed_at, hlc, review_id)`; nothing reads the clock, a random number or the device locale
  where replay or sync must give the same answer on every device
- string sorts use `compareCodeUnits`, never `localeCompare` (it differs by device locale and breaks replay)
- the §8 budget: initial study-screen JS stays within 160 KB gzipped (new screens and heavy modes load lazily), and
  no web font is added (system CJK font stacks only)
- §13 security: no raw HTML rendered from note or package content; URL schemes limited to `https:` and `media:`;
  `.flashpkg`, zip, backup and Anki imports keep their path-traversal, file-count and uncompressed-byte caps; tokens
  and keys never reach a log, an event, an export or a test snapshot
- local-first: no server, backend database or user account is added (the stateless `apps/token-helper` stores
  nothing); study, browse, edit and local imports still work offline
- new behaviour without a test that would fail if the change were reverted
- tests deleted, skipped or loosened

Answer with your findings, at most 10, most important first. Start each with `[blocker]` or `[note]`, then file:line
(or the spec section), what is wrong, and which rule or acceptance criterion it breaks.

- A blocker is wrong behaviour, a broken hard rule, a security gap, or new behaviour with no test. This audit is a
  merge gate: a blocker holds the change (one fix pass, then it waits), so call something a blocker only when it
  must not ship.
- A note is a real risk or a missing edge case. It never holds the change. No style comments.

If nothing is wrong, answer "No findings."
