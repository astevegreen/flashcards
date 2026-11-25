import { describe, expect, it } from 'vitest';
import { withSourcesLock } from '../src/sources/sourceRunner.ts';

describe('withSourcesLock (D8)', () => {
  it('runs tasks one at a time, in call order', async () => {
    const log: string[] = [];
    const task = (name: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        log.push(`${name}:start`);
        setTimeout(() => {
          log.push(`${name}:end`);
          resolve(name);
        }, ms);
      });
    const results = await Promise.all([
      withSourcesLock(task('refresh', 20)),
      withSourcesLock(task('link', 1)),
    ]);
    expect(results).toEqual(['refresh', 'link']);
    expect(log).toEqual(['refresh:start', 'refresh:end', 'link:start', 'link:end']);
  });

  it('keeps the queue moving after a task throws', async () => {
    const failed = withSourcesLock(async () => {
      throw new Error('offline');
    });
    await expect(failed).rejects.toThrow('offline');
    await expect(withSourcesLock(async () => 'next')).resolves.toBe('next');
  });
});
