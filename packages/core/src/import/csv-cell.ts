export interface CsvCellOptions {
  /**
   * Also quote a cell with leading or trailing whitespace. Import trims an unquoted cell, so this
   * keeps outer spaces on a round trip (C17).
   */
  quoteOuterSpace?: boolean;
  /**
   * Also quote a cell starting with `#`. Anki's CSV reader treats a line starting with `#` as a
   * comment and drops the row, and a base91 GUID re-exported from Anki can start with `#`.
   */
  quoteLeadingHash?: boolean;
}

/**
 * One CSV / TSV cell: quoted (inner quotes doubled) when it holds a quote, the delimiter or a line
 * break, or when an option asks for it; otherwise as it is.
 */
export function escapeDelimitedCell(
  value: string,
  delimiter: string,
  options: CsvCellOptions = {},
): string {
  if (
    value.includes('"') ||
    value.includes(delimiter) ||
    value.includes('\n') ||
    value.includes('\r') ||
    (options.quoteLeadingHash === true && value.startsWith('#')) ||
    (options.quoteOuterSpace === true && value !== value.trim())
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
