import { describe, expect, it } from 'vitest';
import { isUnsafeCloudPath } from '../src/sync/cloud-path.ts';

describe('isUnsafeCloudPath (Dropbox and OneDrive alike)', () => {
  it('flags `..` and `.` segments with either separator, and any NUL', () => {
    for (const path of [
      '..',
      'a/../b',
      'a\\..',
      '.',
      './a',
      'a/.',
      'a/./b',
      'a\\.\\b',
      '/.',
      'a\0b',
    ]) {
      expect(isUnsafeCloudPath(path), path).toBe(true);
    }
  });

  it('accepts dots inside a segment', () => {
    for (const path of ['', 'a.b', '.hidden/x', 'a..b.csv', '...', 'a/b.', 'sync/v1/seg..1.json']) {
      expect(isUnsafeCloudPath(path), path).toBe(false);
    }
  });
});
