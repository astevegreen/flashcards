import { describe, expect, it } from 'vitest';
import { hasDotSegment, hasTraversalSegment } from '../src/paths.ts';

describe('hasDotSegment', () => {
  it('flags a `.` segment with either separator, and nothing else', () => {
    for (const path of ['.', './a', 'a/.', 'a/./b', 'a\\.\\b', '/.']) {
      expect(hasDotSegment(path), path).toBe(true);
    }
    for (const path of ['', 'a.b', '.hidden/x', 'a/..', '...', 'a/b.']) {
      expect(hasDotSegment(path), path).toBe(false);
    }
  });
});

describe('hasTraversalSegment (§13)', () => {
  it('flags a `..` segment with either separator, and any NUL', () => {
    for (const path of [
      '..',
      '../x',
      'a/..',
      'a/../b',
      '/a/../b',
      'a\\..\\b',
      'a/..\\b',
      'a//../b',
      'a\0b',
      '\0',
    ]) {
      expect(hasTraversalSegment(path), path).toBe(true);
    }
  });

  it('accepts names that only contain dots inside a segment', () => {
    for (const path of [
      'a..b.csv',
      'sync/v1/a..b/seg..1.json',
      '...',
      '..a/b..',
      '.',
      'a/./b',
      '',
    ]) {
      expect(hasTraversalSegment(path), path).toBe(false);
    }
  });
});
