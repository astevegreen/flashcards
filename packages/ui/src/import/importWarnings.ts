/** Up to three import warnings after a status line, e.g. " 1 warning: Deck "A": …". */
export function describeImportWarnings(warnings: ReadonlyArray<{ message: string }>): string {
  if (warnings.length === 0) return '';
  const shown = warnings.slice(0, 3).map((w) => w.message);
  const more = warnings.length > 3 ? ` (+${warnings.length - 3} more)` : '';
  const label = warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`;
  return ` ${label}: ${shown.join(' ')}${more}`;
}
