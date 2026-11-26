import { hasTraversalSegment } from '@flash/core';

/**
 * True when a Dropbox or OneDrive path is unsafe to send: a NUL, a `..` segment, or a `.` segment,
 * with `/` or `\` as the separator. A name such as `a..b.csv` or `.hidden` is fine.
 */
export function isUnsafeCloudPath(path: string): boolean {
  return hasTraversalSegment(path) || path.split(/[/\\]/).includes('.');
}
