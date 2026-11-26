// agy's second look on one pull request: hands Gemini (agy, headless) read-only material and posts its answer to
// GitHub itself. Gemini never gets GitHub access or write permission; a failed run posts one "skipped" line.
// Usage: node tools/gemini-audit.mjs pr <n> [--dry-run]
// It is the merge gate (tools/gemini/rails.mjs): it audits the pull request, adds the rail audit when the diff
// touches a rail, posts both, and prints one line of JSON with the verdict (merge, fix, hold or retry).
// Ported from terminal-dusk/tools/gemini-audit.mjs (its `pr <n>` mode only).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  askFirstAvailable,
  askModel,
  buildPrompt,
  byLine,
  diffStats,
  pickDepth,
  reviewModels,
} from './gemini/agy.mjs';
import { CUT_LINE, NO_API, apiFor } from './gemini/gemini-api.mjs';
import {
  DEEP_PATHS,
  decide,
  railHits,
  readVerdict,
  reusableVerdict,
  verdictMarker,
} from './gemini/rails.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const REPO = 'astevegreen/flashcards';
const MARKER = '<!-- gemini-audit -->';
const MAX_DIFF = 200_000;
const USAGE = 'usage: node tools/gemini-audit.mjs pr <n> [--dry-run]';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const [mode, ...numbers] = argv.filter((a) => a !== '--dry-run');
// Made on first use, so importing this file (the tests do) leaves nothing behind.
let tmp;
const tmpDir = () => (tmp ??= mkdtempSync(path.join(os.tmpdir(), 'gemini-audit-')));

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 11 * 60_000,
  });
}
function gh(...args) {
  const r = run('gh', args);
  if (r.status !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`,
    );
  return r.stdout;
}

// --- GitHub, through REST (`gh api`) -----------------------------------------------------------------------------
// `gh pr view`, `gh issue view` and `gh pr comment` use GraphQL, which cloud sessions can't reach (HTTP 403); REST
// works everywhere gh is signed in. Each returns the shape the GraphQL commands gave. (TD keeps these in
// tools/github-rest.mjs and tools/github-trust.mjs; Flashcards has only this one caller.)

// The fields the audit needs: number, body, head commit, and whether the branch is in a fork.
export function pullRequest(ghRun, n) {
  const p = JSON.parse(ghRun('api', `repos/${REPO}/pulls/${n}`));
  // A deleted fork has no head repository: that fails closed, as a fork.
  const head = p.head?.repo?.full_name;
  return {
    number: p.number,
    body: p.body ?? '',
    headRefOid: p.head?.sha,
    fromFork: !head || head !== p.base?.repo?.full_name,
  };
}

// Every comment on an issue or pull request, oldest first, as { author: { login }, body }. `tojson` prints each
// one on its own line even where gh would pretty-print.
export function comments(ghRun, n) {
  const out = ghRun(
    'api',
    '--paginate',
    `repos/${REPO}/issues/${n}/comments?per_page=100`,
    '--jq',
    '.[] | tojson',
  );
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .map((c) => ({ author: { login: c.user?.login ?? '' }, body: c.body ?? '' }));
}

// An issue's number, title and body.
function issue(ghRun, n) {
  const i = JSON.parse(ghRun('api', `repos/${REPO}/issues/${n}`));
  return { number: i.number, title: i.title ?? '', body: i.body ?? '' };
}

// The login gh is signed in as: the account this script posts its audits under.
function signedIn() {
  return gh('api', 'user', '--jq', '.login').trim();
}

// --- agy ---------------------------------------------------------------------------------------------------------

// The models agy offers, asked of `agy models` once per run however many audits it makes (agy.mjs, reviewModels).
let listing;
const agyModels = (args) => (listing ??= run('agy', args));

// what: what is reviewed, for pickDepth; deepPaths: the path prefixes that make it a deep review (rails.mjs); order:
// which of agy.mjs's ORDERS asks, instead of the depth's (the rail audit's "rail"); api: askModel's `api`, instead
// of apiFor(what.kind) (the rail audit's NO_API). Returns { model, response, passed, depth, why, note }, so the
// comment can say which model answered and why it was chosen, and name a Gemini model nobody has sorted yet.
function askGemini(
  promptName,
  material,
  what,
  { deepPaths = DEEP_PATHS, order, api = apiFor(what.kind) } = {},
) {
  const text = readFileSync(
    path.join(ROOT, 'tools', 'gemini', 'prompts', `${promptName}.md`),
    'utf8',
  );
  let file;
  if (material) {
    file = path.join(tmpDir(), 'material.md');
    writeFileSync(file, material);
  }
  const prompt = buildPrompt(text, file);
  const pick = pickDepth(what, deepPaths);
  const picked = reviewModels(agyModels, order ?? pick.depth);
  const answer = askFirstAvailable(picked.models, (model) =>
    askModel((args) => run('agy', args), prompt, model, ['--add-dir', tmpDir()], api),
  );
  return { ...answer, ...pick, note: picked.note };
}

function post(number, text) {
  const body = `${MARKER}\n${text}\n`;
  if (DRY) return console.log(`--- would comment on pr #${number} ---\n${body}`);
  const file = path.join(tmpDir(), `comment-pr-${number}.md`);
  writeFileSync(file, body);
  gh('api', '--method', 'POST', `repos/${REPO}/issues/${number}/comments`, '-F', `body=@${file}`);
}

// The answering model may be a Claude model (agy.mjs, ORDERS); the by-line names it. The model-list note (agy lists
// a Gemini model nobody has sorted, or none of the fast ones) is quoted under the by-line, line by line, so a note of
// two lines stays two lines; TD's, YODC's and the course's audits post it the same way.
export const report = (label, answer) =>
  [
    `**Gemini audit: ${label}**`,
    `_${byLine(answer)}_`,
    ...(answer.note
      ? [
          answer.note
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        ]
      : []),
    '',
    answer.response,
  ].join('\n');
const skipped = (err) => `Gemini audit skipped: ${err.message}`;

// The linked task spec, description and diff of pull request `pr`, as one material file.
function prMaterial(pr, diff, ghRun) {
  const linked = /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(pr.body ?? '')?.[1];
  const spec = linked
    ? (({ number, title, body }) => `# #${number} ${title}\n\n${body}\n`)(issue(ghRun, linked))
    : 'No linked task spec (no "Closes #n" in the pull request).\n';
  const cut = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n${CUT_LINE}\n` : diff;
  return `# Task spec\n\n${spec}\n# Pull request #${pr.number}\n\n${pr.body ?? ''}\n\n# Diff\n\n\`\`\`diff\n${cut}\`\`\`\n`;
}

// The merge gate for one pull request: agy's review, plus the deep rail audit when the diff touches a rail. A
// verdict this script already posted for the same commit is reused, unless it was a retry (rails.mjs,
// reusableVerdict). io stands in for gh, agy, the comment and the signed-in login in the tests.
export function auditPr(number, io = { gh, ask: askGemini, post, me: signedIn }) {
  const pr = pullRequest(io.gh, number);
  // The repository is public: a stranger's diff and description never reach agy, and get no verdict.
  if (pr.fromFork)
    throw new Error(`pull request #${pr.number} is from a fork, so it is not audited`);
  pr.comments = comments(io.gh, number);
  // Who this script posts as is asked only when a comment carries a verdict, so a first audit costs no extra call.
  const marked = pr.comments.some((c) => readVerdict(c.body));
  const old = marked ? reusableVerdict(pr.comments, pr.headRefOid, io.me()) : null;
  if (old) return { pr: pr.number, ...old, reused: true };
  const diff = io.gh('pr', 'diff', String(number), '--repo', REPO);
  const what = { kind: 'change', ...diffStats(diff) };
  const hits = railHits(diff);
  const material = prMaterial(pr, diff, io.gh);
  const ask = (prompt, opts) => {
    try {
      return { ok: true, ...io.ask(prompt, material, what, opts) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
  const review = ask('pr-audit');
  // Opus or Gemini's fast models may answer a rail audit, never Sonnet (agy.mjs, ORDERS.rail); with none of them
  // available it can't run, and the verdict is retry. It never goes to the Gemini API, which sees only the diff and
  // the rules files: rails wait for agy (owner, 7 Nov: "Rails wait for the PC").
  const rail = hits.length
    ? ask('rail-audit', { deepPaths: hits.map((h) => h.file), order: 'rail', api: NO_API })
    : null;
  const verdict = { sha: pr.headRefOid, ...decide({ review, rail, hits }) };
  const parts = [
    verdictMarker(verdict),
    review.ok ? report('pull request', review) : skipped(new Error(review.error)),
  ];
  if (rail) {
    const label = `rail audit (${hits.map((h) => h.file).join(', ')})`;
    parts.push(rail.ok ? report(label, rail) : `Gemini ${label} skipped: ${rail.error}`);
  }
  parts.push(`**Verdict: ${verdict.verdict}**: ${verdict.why}.`);
  io.post(pr.number, parts.join('\n\n'));
  return { pr: pr.number, ...verdict, rails: hits.map((h) => h.file) };
}

if (import.meta.main) {
  try {
    if (mode === 'pr' && /^\d+$/.test(numbers[0] ?? '') && numbers.length === 1)
      console.log(JSON.stringify(auditPr(Number(numbers[0]))));
    else throw new Error(USAGE);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
