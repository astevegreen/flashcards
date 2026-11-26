/**
 * The file name a downloaded upstream zip entry is extracted to, or `undefined` to skip the entry.
 * Entries are flattened to their last path segment. Both separators count, so a Windows-style
 * `..\..\evil.xml` is a traversal too; a name such as `a..b.xml` is fine. A name with a `:` is skipped
 * anywhere in it: on Windows `C:evil.xml` is drive-relative and `a.xml:hidden` writes an NTFS
 * alternate data stream. A NUL byte is skipped too.
 */
export function safeZipEntryBaseName(name) {
  if (/[:\0]/.test(name)) return undefined;
  const segments = name.split(/[\\/]/);
  if (segments.includes('..')) return undefined;
  const base = segments.at(-1);
  return base ? base : undefined;
}
