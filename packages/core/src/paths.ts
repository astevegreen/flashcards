/**
 * True when a relative path is unsafe to join onto a root: it holds a NUL, or a `..` segment with
 * `/` or `\` as the separator (§13). A name such as `a..b.csv` is fine. Callers add their own
 * rules on top (absolute paths, drive letters, `.` segments, empty paths).
 */
export function hasTraversalSegment(path: string): boolean {
  if (path.includes('\0')) return true;
  return path.split(/[/\\]/).includes('..');
}
