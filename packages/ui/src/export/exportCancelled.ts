/**
 * The user closed the save dialog (`Files.saveStream` returned no sink). Callers show it as a
 * status line, not as an error. Kept in its own tiny module so screens can test for it without
 * importing the export code.
 */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelledError';
  }
}

/** True for {@link ExportCancelledError} (checked by name, so it also holds across chunks). */
export function isExportCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExportCancelledError';
}
