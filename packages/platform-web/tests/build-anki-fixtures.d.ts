/** Types for the one helper the Anki import test takes from `scripts/build-anki-fixtures.mjs`. */
declare module '*/scripts/build-anki-fixtures.mjs' {
  export function buildZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array;
}
