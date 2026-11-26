/** ASCII file-name slug: lower case, every other run of characters one `-`; `fallback` when empty. */
export function asciiSlug(name: string, fallback: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || fallback
  );
}
