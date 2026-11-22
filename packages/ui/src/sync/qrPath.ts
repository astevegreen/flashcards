/**
 * Turns a QR module matrix (`true` = dark) into one SVG path: a rectangle per horizontal run of
 * dark modules, in module units. Rendered as a React `<path d>` element, never as raw markup.
 */
export function qrMatrixToPath(matrix: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      parts.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  });
  return parts.join('');
}
