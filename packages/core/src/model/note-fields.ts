import type { Note } from './types.ts';

/**
 * `note.fields[key]`, reading own properties only. A field key such as `constructor` or `toString`
 * (an Anki field name, a `.flashpkg` key) would otherwise return an `Object.prototype` function
 * when the note leaves that field empty, and `.trim()` or the cloze scan then throws (S4).
 */
export function noteField(note: Pick<Note, 'fields'> | undefined, key: string): string | undefined {
  return note !== undefined && Object.hasOwn(note.fields, key) ? note.fields[key] : undefined;
}
