const MAX_LISTED_ISSUES = 8;

interface IssueLike {
  path?: unknown;
  message?: unknown;
}

/**
 * Turns an import failure into user-facing text. `.flashpkg` schema failures carry a
 * machine-readable `errors[]` (`{ path, code, message }`); list each one on its own line so the
 * user can see which file and field broke instead of only "Invalid manifest.json".
 * Duck-typed so the UI doesn't pull `@flash/core/flashpkg` into the initial bundle.
 */
export function describeImportError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const issues = (err as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(issues) || issues.length === 0) return base;

  const lines = (issues as IssueLike[]).slice(0, MAX_LISTED_ISSUES).map((issue) => {
    const path = typeof issue.path === 'string' && issue.path !== '' ? issue.path : '(root)';
    const message = typeof issue.message === 'string' ? issue.message : 'invalid value';
    return `• ${path}: ${message}`;
  });
  if (issues.length > MAX_LISTED_ISSUES) {
    lines.push(`• …and ${issues.length - MAX_LISTED_ISSUES} more`);
  }
  return `${base}\n${lines.join('\n')}`;
}
