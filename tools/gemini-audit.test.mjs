// The audit script: its command line (these runs stop before any gh or agy call), and auditPr with gh, agy and
// the comment stood in for. The merge gate's rules are tested in tools/gemini/rails.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO, auditPr, report } from './gemini-audit.mjs';
import { ORDERS, buildPrompt } from './gemini/agy.mjs';
import { NO_API, apiPrompt } from './gemini/gemini-api.mjs';
import { verdictMarker } from './gemini/rails.mjs';

const SCRIPT = path.join(import.meta.dirname, 'gemini-audit.mjs');
const run = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true });

test('the usage names the pr <n> merge gate, and every other mode is refused', () => {
  for (const args of [[], ['weekly'], ['specs', '3'], ['prs']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^usage: node tools\/gemini-audit\.mjs pr <n>/, args.join(' '));
  }
});

test('pr needs one pull request number', () => {
  for (const args of [['pr'], ['pr', 'abc'], ['pr', '1', '2']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /usage:/);
  }
});

// --- auditPr, with gh, agy, the comment and the signed-in login stood in for ------------------------------------

const SHA = 'abc123';
const ME = 'astevegreen';
const diffOf = (file) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
const marked = (login, v, sha = SHA) => ({
  author: { login },
  body: `<!-- gemini-audit -->\n${verdictMarker({ sha, blockers: [], notes: [], why: 'x', ...v })}\n`,
});

// GitHub's REST answers for pull request 7 and its comments, as `gh api` prints them (the comments one per line).
const BASE = { full_name: REPO };
const restPr = ({ fork, body = '' }) => ({
  number: 7,
  body,
  head: { sha: SHA, repo: fork ? { full_name: 'stranger/flashcards' } : BASE },
  base: { repo: BASE },
});
const restComments = (comments) =>
  comments
    .map((c) => JSON.stringify({ user: c.author, author_association: 'OWNER', body: c.body }))
    .join('\n');

// answers: the reply to each prompt, or an Error when agy can't answer it. issues: the REST answer for each issue.
function fake({
  comments = [],
  diff = diffOf('packages/ui/src/x.ts'),
  answers = {},
  fork = false,
  body,
  issues = {},
} = {}) {
  const calls = { ask: [], post: [], me: 0, gh: [] };
  const io = {
    gh: (...args) => {
      calls.gh.push(args);
      if (args[0] === 'pr' && args[1] === 'view')
        throw new Error('HTTP 403: GitHub GraphQL is not available');
      if (args[0] === 'api' && args[1] === `repos/${REPO}/pulls/7`)
        return JSON.stringify(restPr({ fork, body }));
      if (args[0] === 'api' && args[2] === `repos/${REPO}/issues/7/comments?per_page=100`)
        return restComments(comments);
      const n = new RegExp(String.raw`^repos/${REPO}/issues/(\d+)$`).exec(args[1] ?? '')?.[1];
      if (args[0] === 'api' && issues[n]) return JSON.stringify(issues[n]);
      if (args[0] === 'pr' && args[1] === 'diff' && args[2] === '7' && args[4] === REPO)
        return diff;
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
    ask: (prompt, material, what, opts = {}) => {
      calls.ask.push({ prompt, opts, material, what });
      const a = answers[prompt] ?? 'No findings.';
      if (a instanceof Error) throw a;
      return { model: 'm', response: a, passed: [], depth: 'deep', why: 'x' };
    },
    post: (n, body) => calls.post.push({ n, body }),
    me: () => {
      calls.me++;
      return ME;
    },
  };
  return { io, calls };
}

test('the audit reads and posts on astevegreen/flashcards', () => {
  assert.equal(REPO, 'astevegreen/flashcards');
});

test('auditPr reuses a verdict its own account posted for this commit, without asking agy again', () => {
  const { io, calls } = fake({ comments: [marked(ME, { verdict: 'merge' })] });
  const r = auditPr(7, io);
  assert.equal(r.verdict, 'merge');
  assert.equal(r.reused, true);
  assert.equal(calls.ask.length, 0);
  assert.equal(calls.post.length, 0);
  assert.equal(calls.me, 1);
});

test("auditPr ignores a verdict marker in anyone else's comment: agy reviews again", () => {
  const { io, calls } = fake({
    comments: [marked('someone-else', { verdict: 'merge' })],
    answers: { 'pr-audit': '[blocker] a.ts:1 wrong' },
  });
  const r = auditPr(7, io);
  assert.equal(r.reused, undefined);
  assert.equal(r.verdict, 'fix');
  assert.deepEqual(r.blockers, ['a.ts:1 wrong']);
  assert.equal(calls.post.length, 1);
  assert.match(calls.post[0].body, /^<!-- gemini-verdict /);
});

test('auditPr never reuses a retry, or a verdict for another commit', () => {
  for (const c of [marked(ME, { verdict: 'retry' }), marked(ME, { verdict: 'merge' }, 'older')]) {
    const { io, calls } = fake({ comments: [c] });
    assert.equal(auditPr(7, io).reused, undefined);
    assert.equal(calls.ask.length, 1);
  }
});

test('auditPr asks who it is signed in as only when a comment carries a verdict', () => {
  const { io, calls } = fake();
  auditPr(7, io);
  assert.equal(calls.me, 0);
});

test("auditPr's rail audit asks the rail order (Opus, then Gemini's fast models, never Sonnet); none answering is retry", () => {
  const { io, calls } = fake({
    diff: diffOf('.github/workflows/ci.yml'),
    answers: {
      'rail-audit': new Error('no model answered: Claude Opus 5.5 (high) is out of usage'),
    },
  });
  const r = auditPr(7, io);
  const rail = calls.ask.find((a) => a.prompt === 'rail-audit');
  const review = calls.ask.find((a) => a.prompt === 'pr-audit');
  assert.equal(rail.opts.order, 'rail');
  assert.ok(Object.hasOwn(ORDERS, rail.opts.order));
  assert.deepEqual(rail.opts.deepPaths, ['.github/workflows/ci.yml'], 'the rail audit is deep');
  assert.equal(review.opts?.order, undefined, "the review keeps its depth's order");
  assert.equal(rail.opts.api, NO_API, 'a rail audit never goes to the Gemini API');
  assert.equal(review.opts?.api, undefined, 'the review may');
  assert.equal(r.verdict, 'retry');
  assert.deepEqual(r.rails, ['.github/workflows/ci.yml']);
  assert.match(calls.post[0].body, /Gemini rail audit \(\.github\/workflows\/ci\.yml\) skipped/);
  assert.match(calls.post[0].body, /\*\*Verdict: retry\*\*/);
});

test('auditPr: a rail audit that says no merges, one that says yes holds', () => {
  const diff = diffOf('.size-limit.json');
  const no = fake({ diff, answers: { 'rail-audit': 'LOOSENS: no\nAdds an entry.' } });
  assert.equal(auditPr(7, no.io).verdict, 'merge');
  const yes = fake({
    diff,
    answers: { 'rail-audit': 'LOOSENS: yes\nRaises the budget to 200 KB.' },
  });
  const held = auditPr(7, yes.io);
  assert.equal(held.verdict, 'hold');
  assert.match(held.why, /Raises the budget/);
});

test("auditPr: agy's review can't run on a change that touches no rail, so it retries and never merges", () => {
  const { io, calls } = fake({ answers: { 'pr-audit': new Error('agy is not installed') } });
  const r = auditPr(7, io);
  assert.equal(r.verdict, 'retry');
  assert.equal(calls.ask.length, 1, 'no rail, no rail audit');
  assert.match(calls.post[0].body, /Gemini audit skipped: agy is not installed/);
});

test('auditPr reads the pull request, its comments and its linked task spec through REST, never GraphQL', () => {
  const spec = { number: 12, title: 'The spec', body: 'Do the thing.' };
  const { io, calls } = fake({ body: 'Closes #12', issues: { 12: spec } });
  const r = auditPr(7, io);
  assert.equal(r.verdict, 'merge');
  assert.match(calls.ask[0].material, /# #12 The spec\n\nDo the thing\./);
  assert.ok(
    calls.gh.every((a) => a[0] === 'api' || (a[0] === 'pr' && a[1] === 'diff')),
    JSON.stringify(calls.gh),
  );
});

test("auditPr passes the diff's files and size to pickDepth", () => {
  const { io, calls } = fake({ diff: diffOf('packages/core/src/sync/engine.ts') });
  auditPr(7, io);
  assert.deepEqual(calls.ask[0].what, {
    kind: 'change',
    files: ['packages/core/src/sync/engine.ts'],
    lines: 2,
  });
});

// --- the repository is public: what strangers write never reaches agy --------------------------------------------

test("auditPr refuses a fork's pull request before agy sees it, and posts nothing", () => {
  const { io, calls } = fake({ fork: true });
  assert.throws(() => auditPr(7, io), /#7 is from a fork, so it is not audited/);
  assert.deepEqual([calls.ask.length, calls.post.length], [0, 0]);
});

test('a diff too long to send whole is cut with the line the Gemini API refuses, so it never reviews part of it', () => {
  const { io, calls } = fake({
    diff: `${diffOf('packages/ui/src/x.ts')}+${'x'.repeat(200_001)}\n`,
  });
  auditPr(7, io);
  const { material } = calls.ask[0];
  const read = (file) => (file === 'm.md' ? material : '');
  assert.throws(() => apiPrompt(buildPrompt('Review this.', 'm.md'), read, []), /truncated diff/);
  const whole = fake();
  auditPr(7, whole.io);
  const readWhole = (file) => (file === 'm.md' ? whole.calls.ask[0].material : '');
  assert.doesNotThrow(() => apiPrompt(buildPrompt('Review this.', 'm.md'), readWhole, []));
});

// --- report: the comment the audit posts -------------------------------------------------------------------------

const answer = (note) => ({
  model: 'gemini-4-hydrogen-high',
  depth: 'standard',
  why: 'x',
  note,
  response: 'All clear.',
});

test('the model-list note is quoted under the by-line, one quoted line per line of the note', () => {
  const comment = report(
    'pull request',
    answer('New Gemini model in agy: gemini-5-helium-high.\nSecond line.'),
  );
  assert.match(
    comment,
    /^_Gemini 4 Hydrogen.*_\n> New Gemini model in agy: gemini-5-helium-high\.\n> Second line\.\n\nAll clear\.$/m,
  );
});

test('with no model-list note, the comment is the title, the by-line and the answer', () => {
  const comment = report('pull request', answer(''));
  assert.doesNotMatch(comment, /^>/m);
  assert.match(
    comment,
    /^\*\*Gemini audit: pull request\*\*\n_Gemini 4 Hydrogen.*_\n\nAll clear\.$/,
  );
});
