// The Sonar gate, with SonarCloud's API and GitHub's head commit stood in for: no test touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT, failingConditions, headCommit, issueLines, sonarGate } from './sonar-gate.mjs';

const SHA = 'b58186de0ddf94eba442e5c02282444af569d1b6';
const OTHER = '0123456789abcdef0123456789abcdef01234567';

// What SonarCloud answered for pull request 64 on 25 Nov 2026 (trimmed), and a failing variant.
const condition = (metricKey, status, actualValue, errorThreshold, comparator = 'GT') => ({
  status,
  metricKey,
  comparator,
  errorThreshold,
  actualValue,
});
const OK_GATE = {
  projectStatus: {
    status: 'OK',
    conditions: [
      condition('new_reliability_rating', 'OK', '1', '1'),
      condition('new_duplicated_lines_density', 'OK', '2.5', '3'),
    ],
  },
};
const ERROR_GATE = {
  projectStatus: {
    status: 'ERROR',
    conditions: [
      condition('new_security_rating', 'ERROR', '3', '1'),
      condition('new_duplicated_lines_density', 'ERROR', '4.2', '3'),
      condition('new_security_hotspots_reviewed', 'OK', '100.0', '100', 'LT'),
    ],
  },
};
const ISSUE = {
  rule: 'typescript:S3776',
  component: `${PROJECT}:packages/ui/src/components/SourcesPanel.tsx`,
  line: 575,
  message: 'Refactor this function to reduce its Cognitive Complexity from 16 to the 15 allowed.',
};
const PRS = (sha = SHA) => ({
  pullRequests: [
    { key: '64', commit: { sha } },
    { key: '63', commit: { sha: OTHER } },
  ],
});

// A fetch that answers each API path from `routes` ({ path prefix: [status, json] }) and records what was asked.
function fakeFetch(routes) {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push(url);
    assert.equal(init?.method ?? 'GET', 'GET', 'the gate only reads');
    const pathAsked = url.replace('https://sonarcloud.io/api/', '');
    const hit = Object.entries(routes).find(([p]) => pathAsked.startsWith(p));
    if (!hit) throw new Error(`unexpected ${url}`);
    const [status, json] = hit[1];
    return { status, json: async () => (json instanceof Error ? Promise.reject(json) : json) };
  };
  return { fetch, asked };
}
const gate = (routes, sha = SHA) => {
  const f = fakeFetch(routes);
  return sonarGate(64, { fetch: f.fetch, head: () => sha }).then((r) => ({ ...r, asked: f.asked }));
};

test('the project key is the public SonarCloud project astevegreen_flashcards', () => {
  assert.equal(PROJECT, 'astevegreen_flashcards');
});

test('a passing gate on the head commit prints Sonar: OK and exits 0, asking for no issues', async () => {
  const r = await gate({ 'qualitygates/': [200, OK_GATE], 'project_pull_requests/': [200, PRS()] });
  assert.deepEqual([r.code, r.lines], [0, ['Sonar: OK']]);
  assert.match(
    r.asked[0],
    /qualitygates\/project_status\?projectKey=astevegreen_flashcards&pullRequest=64$/,
  );
  assert.ok(!r.asked.some((u) => u.includes('issues/search')));
});

test('a failing gate prints Sonar: ERROR, each failing condition, and the open issues as path:line rule message', async () => {
  const r = await gate({
    'qualitygates/': [200, ERROR_GATE],
    'project_pull_requests/': [200, PRS()],
    'issues/search': [
      200,
      { issues: [ISSUE, { ...ISSUE, line: undefined, rule: 'typescript:S1', message: 'm' }] },
    ],
    'hotspots/search': [200, { hotspots: [] }],
  });
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines, [
    'Sonar: ERROR',
    '  failing: security rating on new code: C (required at most A)',
    '  failing: duplicated lines on new code (%): 4.2 (required at most 3)',
    'Open issues:',
    '  packages/ui/src/components/SourcesPanel.tsx:575 typescript:S3776 Refactor this function to reduce its Cognitive Complexity from 16 to the 15 allowed.',
    '  packages/ui/src/components/SourcesPanel.tsx typescript:S1 m',
  ]);
  assert.ok(
    r.asked.some((u) =>
      u.endsWith(
        'issues/search?componentKeys=astevegreen_flashcards&pullRequest=64&resolved=false&ps=500',
      ),
    ),
  );
});

test('a failing gate with no issue says the failure is a measure, and lists hotspots still to review', async () => {
  const routes = {
    'qualitygates/': [200, ERROR_GATE],
    'project_pull_requests/': [200, PRS()],
    'issues/search': [200, { issues: [] }],
    'hotspots/search': [200, { hotspots: [] }],
  };
  assert.match(
    (await gate(routes)).lines.at(-1),
    /^No open issues: the failing condition is a measure/,
  );
  const hotspot = {
    component: `${PROJECT}:apps/web/src/a.ts`,
    line: 3,
    ruleKey: 'typescript:S5332',
    message: 'http',
  };
  const r = await gate({ ...routes, 'hotspots/search': [200, { hotspots: [hotspot] }] });
  assert.deepEqual(r.lines.slice(-2), [
    'Open issues:',
    '  apps/web/src/a.ts:3 hotspot typescript:S5332 http',
  ]);
});

test('no analysis yet (404), a gate not computed, or SonarCloud unreachable exits 2, so the caller retries', async () => {
  const missing = {
    errors: [{ msg: "Component 'astevegreen_flashcards' of pull request '64' not found" }],
  };
  const r404 = await gate({ 'qualitygates/': [404, missing] });
  assert.equal(r404.code, 2);
  assert.match(
    r404.lines[0],
    /^Sonar: not ready: SonarCloud has no analysis of pull request #64 yet/,
  );
  assert.equal(
    (await gate({ 'qualitygates/': [200, { projectStatus: { status: 'NONE' } }] })).code,
    2,
  );
  assert.equal((await gate({ 'qualitygates/': [503, new Error('not json')] })).code, 2);
  const down = await sonarGate(64, {
    fetch: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
    head: () => SHA,
  });
  assert.equal(down.code, 2);
  assert.match(down.lines[0], /could not be reached \(getaddrinfo ENOTFOUND\)/);
});

test("an analysis of an older commit than the pull request's head exits 2, even when it passed", async () => {
  const r = await gate({
    'qualitygates/': [200, OK_GATE],
    'project_pull_requests/': [200, PRS(OTHER)],
  });
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /the analysis is of 0123456, but the pull request's head is b58186d/);
});

test("when GitHub can't say the head commit, the gate still answers and says the commit was not checked", async () => {
  const r = await gate({ 'qualitygates/': [200, OK_GATE] }, null);
  assert.equal(r.code, 0);
  assert.match(r.lines[1], /Could not read the pull request's head commit/);
  assert.ok(!r.asked.some((u) => u.includes('project_pull_requests')));
});

test("the head commit is read from GitHub's REST API for astevegreen/flashcards", () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: `${SHA}\n` };
  };
  assert.equal(headCommit(64, spawn), SHA);
  assert.deepEqual(calls[0], [
    'gh',
    'api',
    'repos/astevegreen/flashcards/pulls/64',
    '--jq',
    '.head.sha',
  ]);
  assert.equal(
    headCommit(64, () => ({ status: 1, stdout: '' })),
    null,
  );
  assert.equal(
    headCommit(64, () => ({ error: new Error('ENOENT') })),
    null,
  );
});

test('conditions and issues are formatted on their own', () => {
  assert.deepEqual(failingConditions(ERROR_GATE.projectStatus.conditions).length, 2);
  assert.deepEqual(failingConditions([condition('new_coverage', 'ERROR', '62.0', '80', 'LT')]), [
    'coverage on new code (%): 62.0 (required at least 80)',
  ]);
  assert.deepEqual(failingConditions([condition('some_metric', 'ERROR', '9', '5')]), [
    'some_metric: 9 (required at most 5)',
  ]);
  assert.deepEqual(issueLines([ISSUE]), [
    `packages/ui/src/components/SourcesPanel.tsx:575 typescript:S3776 ${ISSUE.message}`,
  ]);
});

test('a bad command line prints the usage and exits 1, never 2', () => {
  const script = path.join(import.meta.dirname, 'sonar-gate.mjs');
  for (const args of [[], ['abc'], ['1', '2']]) {
    const r = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^usage: node tools\/sonar-gate\.mjs <pull request number>/);
  }
});
