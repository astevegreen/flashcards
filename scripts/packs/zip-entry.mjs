/**
 * The file name a downloaded upstream zip entry is extracted to, or `undefined` to skip the entry.
 * Entries are flattened to their last path segment. Both separators count, so a Windows-style
 * `..\..\evil.xml` is a traversal too; a name such as `a..b.xml` is fine.
 */
export function safeZipEntryBaseName(name) {
  const segments = name.split(/[\\/]/);
  if (segments.includes('..')) return undefined;
  const base = segments.at(-1);
  return base ? base : undefined;
}
