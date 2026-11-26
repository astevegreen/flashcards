import { appendFileSync } from 'node:fs';
import type { Reporter, TestCase } from '@playwright/test/reporter';

/**
 * A workflow command's message, escaped as GitHub Actions reads it: `%` first (it starts every
 * escape), then CR and LF, so a test title can neither end the annotation early nor forge another.
 */
export function escapeCommandData(message: string): string {
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * Lists every test that needed a retry (§9: CI's `retries: 2` otherwise hides flakes). A test
 * that passed on a retry is "flaky"; one that failed every attempt is "failed". On GitHub
 * Actions each one also becomes a warning annotation and a row in the job summary.
 */
export default class RetryReporter implements Reporter {
  private readonly retried = new Map<string, TestCase>();

  onTestEnd(test: TestCase): void {
    if (test.results.length > 1) this.retried.set(test.id, test);
  }

  onEnd(): void {
    const rows = [...this.retried.values()].map((test) => ({
      title: test.titlePath().filter(Boolean).join(' › '),
      attempts: test.results.length,
      outcome: test.outcome() === 'flaky' ? 'flaky' : 'failed',
    }));
    if (rows.length === 0) {
      console.log('\nRetries: no test needed a retry.');
      return;
    }
    console.log(`\nRetries: ${rows.length} test(s) needed a retry:`);
    for (const row of rows) {
      console.log(`  ${row.outcome} after ${row.attempts} attempts: ${row.title}`);
    }
    if (process.env['GITHUB_ACTIONS'] !== 'true') return;
    for (const row of rows) {
      const message = `${row.outcome} after ${row.attempts} attempts: ${row.title}`;
      console.log(`::warning title=E2E test needed a retry::${escapeCommandData(message)}`);
    }
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    if (summary) {
      const table = rows.map(
        (row) =>
          `| ${row.outcome} | ${row.attempts} | ${row.title.replaceAll('|', String.raw`\|`).replaceAll(/\r?\n/g, ' ')} |`,
      );
      appendFileSync(
        summary,
        [
          '### E2E tests that needed a retry',
          '',
          '| Outcome | Attempts | Test |',
          '| --- | --- | --- |',
          ...table,
          '',
        ].join('\n'),
      );
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
