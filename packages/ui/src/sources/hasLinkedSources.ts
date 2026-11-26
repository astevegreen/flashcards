import type { SourcesRegistry } from '@flash/platform';

/**
 * The launch check (§8): true when the saved registry lists any linked source, so the app loads
 * `sourceRunner` after first paint only then. Tolerates registries saved before a list existed.
 */
export function hasLinkedSources(saved: Partial<SourcesRegistry> | undefined): boolean {
  return (
    Boolean(saved?.googleSources?.length) ||
    Boolean(saved?.oneDriveSources?.length) ||
    Boolean(saved?.dropboxSources?.length) ||
    Boolean(saved?.googleDriveFiles?.length) ||
    Boolean(saved?.localFolders?.length) ||
    Boolean(saved?.packageSubscriptions?.length) ||
    Boolean(saved?.catalogs?.length)
  );
}
