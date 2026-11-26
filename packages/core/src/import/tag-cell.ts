/**
 * Splits a Tags / Category cell on `,` and `;`. `\,` `\;` and `\\` stand for the character itself,
 * so a tag that contains a separator (from `.flashpkg` or Anki) survives `exportCsv` (C17). Every
 * reader of a category cell uses it: the CSV importer, the mapping preview and linked files.
 */
export function splitTagCell(value: string): string[] {
  const tags: string[] = [];
  let tag = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const next = value[i + 1];
    if (ch === '\\' && (next === ',' || next === ';' || next === '\\')) {
      tag += next;
      i += 1;
    } else if (ch === ',' || ch === ';') {
      tags.push(tag);
      tag = '';
    } else {
      tag += ch;
    }
  }
  tags.push(tag);
  return tags;
}
