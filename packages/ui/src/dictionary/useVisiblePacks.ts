import { isPackForActiveLanguages } from '@flash/core';
import type { DictionaryBrowseSummary } from '@flash/core/dictionary';
import type { DictionaryPackId, InstalledPackInfo } from '@flash/platform';
import { useMemo } from 'react';
import { useShowAllLanguages } from '../packs/ShowAllLanguagesSwitch.tsx';
import { useActiveLanguages } from '../state/useActiveLanguages.ts';

export type PackFilter = DictionaryPackId | 'all';

export interface VisiblePacks {
  /** Installed packs for the languages in use (all of them while "Show all languages" is on). */
  visiblePacks: InstalledPackInfo[];
  hiddenPackCount: number;
  /** The chosen filter, or `all` when the chosen pack is hidden. */
  packFilter: PackFilter;
  /**
   * Stable key of the pack ids a search covers for `all`: `undefined` = every installed pack,
   * otherwise the visible ids joined by newlines (possibly empty).
   */
  allPackIdsKey: string | undefined;
  showAllLanguages: boolean;
  setShowAllLanguages: (on: boolean) => void;
}

/** UX #2: dictionary pack filters (and "All") cover the languages in use unless shown all. */
export function useVisiblePacks(
  installedPacks: readonly InstalledPackInfo[],
  selectedPack: PackFilter,
): VisiblePacks {
  const { languages } = useActiveLanguages();
  const [showAllLanguages, setShowAllLanguages] = useShowAllLanguages();
  const visiblePacks = useMemo(
    () =>
      showAllLanguages
        ? [...installedPacks]
        : installedPacks.filter((p) => isPackForActiveLanguages(languages, p)),
    [languages, installedPacks, showAllLanguages],
  );
  const hiddenPackCount = installedPacks.length - visiblePacks.length;
  const selectedVisible = visiblePacks.some((p) => p.id === selectedPack);
  return {
    visiblePacks,
    hiddenPackCount,
    packFilter: selectedVisible ? selectedPack : 'all',
    allPackIdsKey: hiddenPackCount > 0 ? visiblePacks.map((p) => p.id).join('\n') : undefined,
    showAllLanguages,
    setShowAllLanguages,
  };
}

/**
 * Pack ids a search should cover: the one chosen pack, or for `all` the visible packs
 * (`undefined` = no restriction; `[]` = nothing to search).
 */
export function searchPackIds(
  filter: PackFilter,
  allPackIdsKey: string | undefined,
): DictionaryPackId[] | undefined {
  if (filter !== 'all') return [filter];
  if (allPackIdsKey === undefined) return undefined;
  return allPackIdsKey.split('\n').filter(Boolean) as DictionaryPackId[];
}

/** Browse summaries for the home screen under the current filter. */
export function homeSummariesFor(
  summaries: readonly DictionaryBrowseSummary[],
  filter: PackFilter,
  visiblePacks: readonly InstalledPackInfo[],
): DictionaryBrowseSummary[] {
  if (filter !== 'all') return summaries.filter((x) => x.packId === filter);
  return summaries.filter((x) => visiblePacks.some((p) => p.id === x.packId));
}
