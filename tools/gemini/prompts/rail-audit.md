Rail audit of one pull request. The material file holds its diff and description. The diff touches a rail: the
agents' settings (`.claude/settings*.json`), agents or skills; a hook (`tools/hooks/`, `.githooks/`); CI or
repository config under `.github/`; this audit's own code (`tools/gemini/`, `tools/gemini-audit.mjs`) or the Sonar
gate (`tools/sonar-gate.mjs`); an instruction file every agent follows (AGENTS.md, CLAUDE.md, GEMINI.md,
`.agents/`); or a config whose loosening lets a broken change pass: `eslint.config.js` (it holds the
`packages/core` purity boundary), `.size-limit.json` and `scripts/check-no-fonts.mjs` (the §8 160 KB and
no-web-font budget), `vitest.config.ts`, `playwright.config.ts`, `.sonarcloud.properties`, `.prettierrc`,
`.prettierignore`, a root `tsconfig*.json`, or the root `package.json` (its scripts run the gate). Nobody reads
these changes line by line, so a rail loosened here would hide its own failure.

Answer one question: does this change loosen, bypass or disable any check, guard, gate, hook or required
review? That includes removing or skipping a step, a test or a job; making a check pass when it should fail;
widening what an allow rule, a guard or a hook lets through; dropping an `ask` or `deny` rule; turning a
failure into a warning; raising a budget or a threshold; excluding files from lint, tests, size, formatting,
type checks or SonarCloud; weakening a rule an agent must follow; and running a check on less than before.
Adding a check, or moving one without weakening it, is not loosening. Read the rail files on disk where the diff
alone is unclear.

Your first line is exactly `LOOSENS: yes` or `LOOSENS: no`. Then, in at most 8 lines of plain English for an
owner who doesn't read code: for yes, each thing it loosens (file:line, what passes now that didn't before);
for no, what the change does to the rails. The findings format of a pull request audit does not apply here.
