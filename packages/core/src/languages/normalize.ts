/**
 * Maps a language tag to the code the app uses: `ja-JP` -> `ja`, `zh`/`zh-CN` -> `zh-Hans`.
 * Dependency-free so event replay can use it without an import cycle.
 */
export function normalizeLanguage(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return primary === 'zh' ? 'zh-Hans' : primary;
}
