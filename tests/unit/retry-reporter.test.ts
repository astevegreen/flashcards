import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestCase } from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RetryReporter, { escapeCommandData } from '../e2e/reporters/retry-reporter';

/** The parts of a Playwright TestCase the reporter reads. */
function testCase(id: string, title: string[], attempts: number, outcome: 'flaky' | 'unexpected') {
  return {
    id,
    titlePath: () => ['', ...title],
    results: Array.from({ length: attempts }, () => ({})),
    outcome: () => outcome,
  } as unknown as TestCase;
}

describe('escapeCommandData', () => {
  it('escapes % first, then CR and LF, as GitHub workflow commands expect', () => {
    expect(escapeCommandData('100% done')).toBe('100%25 done');
    expect(escapeCommandData('a\r\nb')).toBe('a%0D%0Ab');
    expect(escapeCommandData('%0A')).toBe('%250A');
    expect(escapeCommandData('plain')).toBe('plain');
  });
});

describe('RetryReporter', () => {
  let dir: string;
  let lines: string[];
  const env = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'retry-reporter-'));
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...env };
    rmSync(dir, { recursive: true, force: true });
  });

  it('says so when no test needed a retry', () => {
    const reporter = new RetryReporter();
    reporter.onTestEnd(testCase('a', ['once'], 1, 'flaky'));
    reporter.onEnd();
    expect(lines).toEqual(['\nRetries: no test needed a retry.']);
  });

  it('on GitHub Actions, annotates each retried test with an escaped message and a summary row', () => {
    const summary = path.join(dir, 'summary.md');
    process.env['GITHUB_ACTIONS'] = 'true';
    process.env['GITHUB_STEP_SUMMARY'] = summary;
    const reporter = new RetryReporter();
    reporter.onTestEnd(testCase('a', ['spec', 'shows 100%\nwith | bars'], 2, 'flaky'));
    reporter.onTestEnd(testCase('b', ['spec', 'never passes'], 3, 'unexpected'));
    reporter.onTestEnd(testCase('c', ['spec', 'first try'], 1, 'flaky'));
    reporter.onEnd();
    const warnings = lines.filter((l) => l.startsWith('::warning'));
    expect(warnings).toEqual([
      '::warning title=E2E test needed a retry::flaky after 2 attempts: spec › shows 100%25%0Awith | bars',
      '::warning title=E2E test needed a retry::failed after 3 attempts: spec › never passes',
    ]);
    const table = readFileSync(summary, 'utf8');
    expect(table).toContain(String.raw`| flaky | 2 | spec › shows 100% with \| bars |`);
    expect(table).toContain('| failed | 3 | spec › never passes |');
    expect(table).not.toContain('first try');
  });

  it('prints no annotation off GitHub Actions', () => {
    delete process.env['GITHUB_ACTIONS'];
    const reporter = new RetryReporter();
    reporter.onTestEnd(testCase('a', ['spec', 'flaky one'], 2, 'flaky'));
    reporter.onEnd();
    expect(lines.some((l) => l.startsWith('::'))).toBe(false);
    expect(lines).toContain('  flaky after 2 attempts: spec › flaky one');
  });
});
