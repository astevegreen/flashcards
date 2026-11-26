/** The picker refused a file over its `maxBytes` (P8): what to tell the user, or `null`. */

/** A byte cap in whole megabytes, as the messages show it ("300 MB"). */
export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * The message for a file the picker would not read, or `null` when it was read. `purpose` ends
 * the sentence's first half: "to import", "to restore", "for a dictionary pack".
 */
export function tooLargeMessage(
  picked: { name: string; tooLarge?: true },
  maxBytes: number,
  purpose: string,
): string | null {
  if (!picked.tooLarge) return null;
  return `"${picked.name}" is too large ${purpose} (the limit is ${formatMegabytes(maxBytes)}).`;
}
