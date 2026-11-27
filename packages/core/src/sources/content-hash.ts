import { sha256String } from './hash.ts';
import { compareCodeUnits } from '../compare.ts';

// Content hashes for imports and sources, kept apart from `hash.ts` (which Study needs for TTS
// cache keys) so they stay out of the initial study-screen chunk (§8).

/**
 * Computes a deterministic canonical content hash for a note's fields and tags.
 * Ignores empty/whitespace-only absent fields consistently so diffs are exact.
 */
export function computeNoteContentHash(
  fields: Readonly<Record<string, string>>,
  tags: readonly string[],
): string {
  // Own entries only, so a `constructor` or `toString` key is hashed like any other (S4).
  const entries = Object.entries(fields).sort((a, b) => compareCodeUnits(a[0], b[0]));
  const parts: string[] = ['F:'];
  for (const [key, val] of entries) {
    if (val === undefined || val === '') continue;
    parts.push(`${key.length}:${key}=${val.length}:${val};`);
  }
  const normalizedTags = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))].sort(
    compareCodeUnits,
  );
  parts.push('T:');
  for (const tag of normalizedTags) {
    parts.push(`${tag.length}:${tag},`);
  }
  return sha256String(parts.join(''));
}

/**
 * Computes a deterministic canonical content hash for a Page.
 */
export function computePageContentHash(page: {
  title: string;
  markdown: string;
  lang?: string;
  tags: readonly string[];
}): string {
  const normalizedTags = [
    ...new Set(page.tags.map((t) => t.trim()).filter((t) => t.length > 0)),
  ].sort(compareCodeUnits);
  const canonical = [
    `title:${page.title.length}:${page.title}`,
    `lang:${page.lang ?? ''}`,
    `tags:${normalizedTags.join('\u001f')}`,
    `md:${page.markdown.length}:${page.markdown}`,
  ].join('\u001e');
  return sha256String(canonical);
}
