import type { Note } from './types.ts';

/**
 * `fields[key]` on a plain fields record, reading own properties only. A field key such as
 * `constructor` or `toString` (an Anki field name, a `.flashpkg` key, a CSV header) would
 * otherwise return an `Object.prototype` function when the record lacks that field (S4).
 */
export function ownField(
  fields: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(fields, key) ? fields[key] : undefined;
}

/**
 * `note.fields[key]`, reading own properties only. A field key such as `constructor` or `toString`
 * (an Anki field name, a `.flashpkg` key) would otherwise return an `Object.prototype` function
 * when the note leaves that field empty, and `.trim()` or the cloze scan then throws (S4).
 */
export function noteField(note: Pick<Note, 'fields'> | undefined, key: string): string | undefined {
  return note === undefined ? undefined : ownField(note.fields, key);
}
