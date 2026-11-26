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

/**
 * Spreadsheet formula injection (CSV injection, OWASP): Excel, LibreOffice and Sheets run a cell
 * that starts with `=`, `+`, `-` or `@` as a formula, so `=HYPERLINK(…)` from an imported deck
 * would run when an exported file is opened (S6). Only the "for other apps" exports guard cells;
 * the app's own round-trip CSV keeps them as typed.
 *
 * The rule:
 * - leading spaces, tabs, CRs and LFs are skipped first, since spreadsheets trim them;
 * - `=`, `+` or `@` then always trigger;
 * - `-` triggers too, except for a Korean grammar entry: the first character after the `-` that
 *   is not punctuation or whitespace is Hangul (a letter or jamo), and the rest of the cell holds
 *   no ASCII letter or digit and none of `"&|!=+@$:`. A formula needs those for a function name,
 *   a string, a reference or a join, so it can't hide behind a Hangul start. `-(으)ㄴ`,
 *   `-아/어요` and `-기 때문에` stay as they are; `-("가"&HYPERLINK(…))` and `-(으)ㄴ (adj.)` are
 *   guarded.
 */
const FORMULA_START =
  /^[ \t\r\n]*(?:[=+@]|-(?!(?=[^A-Za-z0-9"&|!=+@$:]*$)[\p{P} \t\r\n]*\p{Script=Hangul}))/u;

/** True when a spreadsheet would read `value` as a formula (see the rule above). */
export function startsLikeFormula(value: string): boolean {
  return FORMULA_START.test(value);
}

/** `value` with a leading `'`, which spreadsheets read as "this cell is text", when it needs one. */
export function guardFormula(value: string): string {
  return startsLikeFormula(value) ? `'${value}` : value;
}
