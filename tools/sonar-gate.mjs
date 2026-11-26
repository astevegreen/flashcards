// `node tools/sonar-gate.mjs <pr>`: SonarCloud's quality gate on a pull request, and on a failure what failed.
// The SonarCloud project is public, so its own API answers without a token. It only reads: every request is a GET.
// Exit 0 when the gate passes, 1 when it fails, 2 when the analysis of the pull request's head commit is not there
// yet (or SonarCloud could not be reached): a machine failure, so the caller runs it again later. A bad command
// line exits 1, like a failed gate, so it is never retried as if it were waiting on SonarCloud.
import { spawnSync } from 'node:child_process';

export const API = 'https://sonarcloud.io/api';
export const PROJECT = 'astevegreen_flashcards';
export const REPO = 'astevegreen/flashcards';
const USAGE = 'usage: node tools/sonar-gate.mjs <pull request number>';

// What a quality gate condition is about, in words; anything else is shown by its metric key.
const METRICS = {
  new_reliability_rating: 'reliability rating on new code',
  new_security_rating: 'security rating on new code',
  new_maintainability_rating: 'maintainability rating on new code',
  new_duplicated_lines_density: 'duplicated lines on new code (%)',
  new_security_hotspots_reviewed: 'security hotspots reviewed (%)',
  new_coverage: 'coverage on new code (%)',
};
// Sonar's ratings are 1..5 for A..E.
const RATING = /_rating$/;
const grade = (metric, value) =>
  RATING.test(metric) && /^[1-5]$/.test(value) ? '_ABCDE'[value] : value;
const COMPARATORS = { GT: 'at most', LT: 'at least' };

// One line per failing condition: what it measures, its value, and what the gate requires.
export function failingConditions(conditions = []) {
  return conditions
    .filter((c) => c.status === 'ERROR')
    .map((c) => {
      const name = METRICS[c.metricKey] ?? c.metricKey;
      const need = `${COMPARATORS[c.comparator] ?? c.comparator} ${grade(c.metricKey, c.errorThreshold)}`;
      return `${name}: ${grade(c.metricKey, c.actualValue)} (required ${need})`;
    });
}

// A file's path inside the repository, from Sonar's component key ("<project>:<path>").
const fileOf = (component = '') => component.slice(component.indexOf(':') + 1);

// One "path:line rule message" line per open issue. An issue on a whole file has no line.
export const issueLines = (issues = []) =>
  issues.map((i) => `${fileOf(i.component)}${i.line ? `:${i.line}` : ''} ${i.rule} ${i.message}`);

// One "path:line hotspot rule message" line per security hotspot still to review: they are not issues, so a failing
// hotspot condition would otherwise list nothing.
export const hotspotLines = (hotspots = []) =>
  hotspots.map(
    (h) =>
      `${fileOf(h.component)}${h.line ? `:${h.line}` : ''} hotspot ${h.ruleKey ?? h.securityCategory} ${h.message}`,
  );

// GETs one SonarCloud API path; { status, json }. fetch stands in for the network in the tests.
async function get(fetch, path) {
  const res = await fetch(`${API}/${path}`, { headers: { accept: 'application/json' } });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // A page that is not JSON: the status says what happened.
  }
  return { status: res.status, json };
}

// The pull request's head commit, from GitHub; null when gh can't say (the commit check is then skipped, and said so).
export function headCommit(n, spawn = spawnSync) {
  const r = spawn('gh', ['api', `repos/${REPO}/pulls/${n}`, '--jq', '.head.sha'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sha = r.status === 0 ? String(r.stdout ?? '').trim() : '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// The gate for pull request n: { code, lines }, the exit code and what to print.
export async function sonarGate(n, { fetch = globalThis.fetch, head = headCommit } = {}) {
  const pr = encodeURIComponent(String(n));
  const key = encodeURIComponent(PROJECT);
  const later = (why) => ({ code: 2, lines: [`Sonar: not ready: ${why}; run it again later.`] });

  let gate;
  try {
    gate = await get(fetch, `qualitygates/project_status?projectKey=${key}&pullRequest=${pr}`);
  } catch (err) {
    return later(`SonarCloud could not be reached (${err.message})`);
  }
  if (gate.status === 404) return later(`SonarCloud has no analysis of pull request #${n} yet`);
  if (gate.status !== 200 || !gate.json?.projectStatus)
    return later(
      `SonarCloud answered ${gate.status}${gate.json?.errors?.[0]?.msg ? `: ${gate.json.errors[0].msg}` : ''}`,
    );
  const { status, conditions } = gate.json.projectStatus;
  if (status !== 'OK' && status !== 'ERROR')
    return later(`the quality gate is ${status ?? 'not computed'}`);

  // A push after the last analysis leaves the old verdict in place until the new one lands: check which commit it is.
  const notes = [];
  const sha = head(n);
  if (sha) {
    let list;
    try {
      list = await get(fetch, `project_pull_requests/list?project=${key}`);
    } catch (err) {
      return later(`SonarCloud could not be reached (${err.message})`);
    }
    const analysed = list.json?.pullRequests?.find((p) => p.key === String(n))?.commit?.sha;
    if (analysed && analysed !== sha)
      return later(
        `the analysis is of ${analysed.slice(0, 7)}, but the pull request's head is ${sha.slice(0, 7)}`,
      );
    if (!analysed) notes.push('(SonarCloud did not say which commit it analysed.)');
  } else
    // CLAUDE.md merges on `Sonar: OK`, so an analysis that may be of an older commit is not an answer yet.
    return later("GitHub did not say the pull request's head commit, so the analysis may be older");

  if (status === 'OK') return { code: 0, lines: ['Sonar: OK', ...notes] };

  const lines = ['Sonar: ERROR', ...failingConditions(conditions).map((c) => `  failing: ${c}`)];
  try {
    const issues = await get(
      fetch,
      `issues/search?componentKeys=${key}&pullRequest=${pr}&resolved=false&ps=500`,
    );
    const open = issueLines(issues.json?.issues);
    const hotspots = await get(
      fetch,
      `hotspots/search?projectKey=${key}&pullRequest=${pr}&status=TO_REVIEW&ps=500`,
    );
    const review = hotspotLines(hotspots.json?.hotspots);
    if (open.length || review.length)
      lines.push('Open issues:', ...[...open, ...review].map((l) => `  ${l}`));
    else
      lines.push(
        'No open issues: the failing condition is a measure (duplication, coverage), not an issue.',
      );
  } catch (err) {
    lines.push(`(Could not list the open issues: ${err.message})`);
  }
  return { code: 1, lines: [...lines, ...notes] };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    const { code, lines } = await sonarGate(Number(args[0]));
    console.log(lines.join('\n'));
    process.exitCode = code;
  }
}
