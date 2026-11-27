// agy's second look as a merge gate (owner's policy, 28 Oct 2026): which changes touch a rail, how a review's
// findings and the rail audit's answer are read, and what the pull request does next. Pure functions; the audit
// itself runs in tools/gemini-audit.mjs (`pr <n>`).
//   P3: a [blocker] from agy holds like a reviewer blocker (one fix pass first); notes never hold.
//   P4: a change touching a rail gets a deep audit asking whether it loosens, bypasses or disables a check, guard,
//       gate, hook or required review. Yes holds it for the owner; no merges it like any other change.
//   P2: an audit that could not run is a machine failure: it retries by itself and never waits for the owner.
// The rails: where a loosened check hides its own failure. In Flashcards they are the agents' own settings, hooks,
// agents and skills; this audit and the Sonar gate; git hooks and everything under .github; the instruction files
// every agent follows; and the configs whose loosening lets a broken change pass: lint (the core purity boundary),
// the §8 size and font budget, the test runners, SonarCloud, Prettier, TypeScript, and the root package.json,
// whose scripts are the gate.
const under = (dir) => (f) => f.startsWith(dir);
const oneOf =
  (...names) =>
  (f) =>
    names.includes(f);
export const RAILS = [
  { test: (f) => /^\.claude\/settings[^/]*\.json$/.test(f), what: '.claude/settings*.json' },
  { test: under('.claude/agents/'), what: 'a Claude Code agent' },
  { test: under('.claude/skills/'), what: 'a Claude Code skill' },
  { test: under('tools/hooks/'), what: 'tools/hooks' },
  {
    test: (f) => f.startsWith('tools/gemini/') || f === 'tools/gemini-audit.mjs',
    what: "agy's audit",
  },
  { test: (f) => /^tools\/sonar-gate(\.test)?\.mjs$/.test(f), what: 'the Sonar gate' },
  { test: under('.githooks/'), what: 'git hooks' },
  { test: under('.github/'), what: '.github (CI workflows and repository config)' },
  { test: oneOf('AGENTS.md', 'CLAUDE.md', 'GEMINI.md'), what: 'an agent instruction file' },
  { test: under('.agents/'), what: "Antigravity's rules" },
  {
    test: oneOf('eslint.config.js'),
    what: 'the ESLint config, which holds the core purity boundary',
  },
  {
    test: oneOf('.size-limit.json', 'scripts/check-no-fonts.mjs'),
    what: 'the §8 size and font budget',
  },
  { test: oneOf('vitest.config.ts', 'playwright.config.ts'), what: "a test runner's config" },
  { test: oneOf('.sonarcloud.properties'), what: "SonarCloud's settings" },
  { test: oneOf('.prettierrc', '.prettierignore'), what: 'the Prettier config' },
  {
    test: oneOf('pnpm-workspace.yaml', '.npmrc'),
    what: "pnpm's settings, which hold the minimum release age Dependabot relies on",
  },
  { test: (f) => /^tsconfig[^/]*\.json$/.test(f), what: 'a root TypeScript config' },
  {
    test: oneOf('packages/core/tsconfig.json'),
    what: "core's tsconfig, whose lib (no DOM) holds the core purity boundary",
  },
  {
    test: oneOf('scripts/install-git-hooks.mjs'),
    what: 'the script that switches the git hooks on',
  },
  { test: oneOf('package.json'), what: 'the root package.json, whose scripts run the gate' },
];

// Where a mistake costs most in Flashcards, as path prefixes (agy.mjs, pickDepth): events and deterministic replay,
// with the clocks and the review sort that order them; the sync engine, its transports and their sign-ins; offline
// licensing and the purchase that issues a license; untrusted archives (.flashpkg and other imports, zip, backups,
// Anki packages); and the token helper, the one piece that runs on a server. A change touching one gets the deep
// review; tools/gemini-audit.mjs passes this list to pickDepth.
export const DEEP_PATHS = [
  'packages/core/src/events/',
  'packages/core/src/hlc',
  'packages/core/src/study/queue.ts',
  'packages/core/src/sync/',
  'packages/core/src/license/',
  'packages/core/src/import/',
  'packages/core/src/backup/',
  'packages/platform-web/src/sync/',
  'packages/platform-web/src/auth/',
  'packages/platform-web/src/purchase/',
  'packages/platform-web/src/anki/',
  'apps/token-helper/',
];

// The models that audit a rail, in order: Opus, then Gemini's fast models, newest first (agy.mjs, ORDERS.rail;
// tools/gemini-audit.mjs asks for that order). It is the owner's 28 Oct 2026 order (Argon, Opus, then Flash) without
// Argon, whose usage is too small (owner, 19 Nov 2026). Never Sonnet: the Claude reviewer already covers that family.
// When none of them is available the audit can't run, and the pull request retries (P2).

// Each file a unified diff changes, with its added and removed lines (without the leading + or -). A rename or copy
// also carries `from`, the old path: from its `rename from` / `copy from` line, else the `a/` path of the header.
export function diffFiles(diff) {
  const files = [];
  for (const raw of String(diff).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    const moved = /^(?:rename|copy) from (.+)$/.exec(line);
    if (head) {
      const entry = { file: head[2], changed: [] };
      if (head[1] !== head[2]) entry.from = head[1];
      files.push(entry);
    } else if (moved && files.length && !files.at(-1).changed.length) files.at(-1).from = moved[1];
    else if (files.length && /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line))
      files.at(-1).changed.push(line.slice(1));
  }
  return files;
}

// The rails a diff touches: [{ file, what }], empty when it touches none. Both sides of a rename count: moving a rail
// out of its folder (.githooks/pre-push to docs/) removes it, so it is audited like any other change to it.
export function railHits(diff) {
  const hits = [];
  for (const { file, from } of diffFiles(diff)) {
    for (const path of from === undefined ? [file] : [from, file]) {
      const rail = RAILS.find((r) => r.test(path));
      if (rail) {
        hits.push({ file: path, what: rail.what });
        break;
      }
    }
  }
  return hits;
}

// Whether an untagged line asserts a blocker: "Blocker: <something>" or "Blockers: <something>", maybe bold
// ("**Blockers**: x"), where the whole answer is not none/n/a/no. Clean prose ("No blocker.", "No blockers found.",
// "Blockers: none") and negations are not assertions.
function assertsBlocker(line) {
  // The negation test is deliberately left as it was: widening it would clear lines that read as blockers before.
  return /(?<![a-z])blockers?\**\s*[:—-]\s*(?!(?:none|n\/a|no)\s*[.!]?\s*$)\S/i.test(line)
    ? !/(?:no|not|without)\s+blockers?\s*[:—-]/i.test(line)
    : false;
}

// A review's findings in the format prompts/pr-audit.md asks for: "[blocker] file:line …" or "[note] …", maybe
// numbered or bulleted.
export function findings(response) {
  const out = { blockers: [], notes: [], untaggedBlockers: [] };
  for (const line of String(response ?? '').split(/\r?\n/)) {
    // Trimmed first, and no two neighbouring parts match the same text, so the pattern can't backtrack.
    const m = /^(?:[-*]|\d+[.)])?[ \t]*\**\[(blocker|note|minor)\]\**:?(.*)$/i.exec(line.trim());
    if (m) (m[1].toLowerCase() === 'blocker' ? out.blockers : out.notes).push(m[2].trim());
    // An untagged line that names a blocker (mid-line "Blocker: ...") may be one the tag format missed.
    else if (assertsBlocker(line)) out.untaggedBlockers.push(line.trim());
  }
  return out;
}

// Whether a review is the clean answer the prompt asks for when nothing is wrong: "No findings.", maybe bold or
// quoted. A review with no tagged line that says anything else is unreadable, not clean (decide retries it).
export const saysNoFindings = (response) =>
  /^["'*_`\s]*no findings\.?["'*_`\s]*$/i.test(String(response ?? ''));

// The rail audit's answer: its first "LOOSENS: yes|no" line, and the reason after it. loosens is null when the
// answer says neither.
export function railAnswer(response) {
  const text = String(response ?? '');
  // Line by line: a multiline pattern whose \W* can cross newlines backtracks on a long answer.
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^[^\w\n]*LOOSENS:[^\w\n]*(?:yes|no)\b/i.test(l));
  if (at < 0) return { loosens: null, reason: text.trim().slice(0, 800) };
  const yes = /^[^\w\n]*LOOSENS:[^\w\n]*yes\b/i.test(lines[at]);
  const rest = lines
    .slice(at + 1)
    .join('\n')
    .trim();
  return { loosens: yes, reason: rest.slice(0, 800) || 'no reason given' };
}

// What the pull request does next, from the review and the rail audit (null when no rail was touched). Each is
// { ok: true, response } or { ok: false, error }.
//   merge: no agy blocker and no loosened rail; the notes go on the pull request and hold nothing
//   fix:   agy found blockers; one fix pass, then audit again (blockers left after it: held)
//   hold:  the rail audit says the change loosens a rail, or gave no clear answer: held for the owner
//   retry: agy's review or the rail audit could not run, or the review can't be read (no tagged line and not
//          "No findings."); the pull request waits for it and retries by itself, never for the owner (P2), and
//          never merges unaudited
export function decide({ review, rail = null, hits = [] }) {
  const { blockers, notes, untaggedBlockers } = review.ok
    ? findings(review.response)
    : { blockers: [], notes: [], untaggedBlockers: [] };
  const where = hits.map((h) => h.file).join(', ');
  if (rail && !rail.ok)
    return {
      verdict: 'retry',
      blockers,
      notes,
      why: `the rail audit could not run (${rail.error}); a change to ${where} waits for it and retries by itself`,
    };
  if (rail) {
    const answer = railAnswer(rail.response);
    if (answer.loosens === true)
      return {
        verdict: 'hold',
        blockers,
        notes,
        why: `the rail audit says it loosens a rail: ${answer.reason}`,
      };
    if (answer.loosens === null)
      return {
        verdict: 'hold',
        blockers,
        notes,
        why: `the rail audit gave no clear yes or no about ${where}, so it waits for the owner`,
      };
  }
  if (!review.ok)
    return {
      verdict: 'retry',
      blockers,
      notes,
      why: `agy's second look could not run (${review.error}); the pull request waits for it and retries by itself`,
    };
  if (!blockers.length && !notes.length && !saysNoFindings(review.response))
    return {
      verdict: 'retry',
      blockers,
      notes,
      why: `agy's second look has no [blocker] or [note] line and is not "No findings.", so it can't be read; the pull request retries by itself`,
    };
  // Tagged notes alone read as notes-only, but an untagged "Blocker: ..." line next to them means agy may have
  // flagged a blocker the format missed: retry rather than merge past it.
  if (!blockers.length && untaggedBlockers.length)
    return {
      verdict: 'retry',
      blockers,
      notes,
      why: `agy's second look has an untagged line that names a blocker (${untaggedBlockers[0].slice(0, 120)}), so it can't be read as notes only; the pull request retries by itself`,
    };
  if (blockers.length)
    return { verdict: 'fix', blockers, notes, why: `agy found ${blockers.length} blocker(s)` };
  return {
    verdict: 'merge',
    blockers,
    notes,
    why: rail ? 'no agy blocker, and the rail audit found nothing loosened' : 'no agy blocker',
  };
}

// The verdict travels in the audit comment, so a second `pr <n>` on the same commit reuses it instead of asking
// agy again. Base64 keeps "-->" in a finding from ending the HTML comment early.
const VERDICT = '<!-- gemini-verdict ';
export const verdictMarker = (v) =>
  `${VERDICT}${Buffer.from(JSON.stringify(v)).toString('base64')} -->`;
export function readVerdict(body) {
  const m = new RegExp(String.raw`${VERDICT}([A-Za-z0-9+/=]+) -->`).exec(String(body ?? ''));
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// The verdict a second `pr <n>` may reuse instead of asking agy again: the newest one for this commit, in a comment
// the audit's own account posted. `me` is the login gh is signed in as. A marker in anyone else's comment is
// ignored. Only a verdict that stops the merge (fix, hold) is reused: the agents post comments as that same login,
// so a pasted `merge` marker could otherwise merge a pull request agy never saw. A merge or a retry is never reused:
// the audit runs again. comments: { author: { login }, body }, oldest first.
export function reusableVerdict(comments, sha, me) {
  if (!me) return null;
  const mine = (c) => String(c.author?.login ?? '').toLowerCase() === me.toLowerCase();
  const v = comments
    .filter(mine)
    .map((c) => readVerdict(c.body))
    .filter((x) => x?.sha === sha)
    .at(-1);
  return v && v.verdict !== 'retry' && v.verdict !== 'merge' ? v : null;
}
