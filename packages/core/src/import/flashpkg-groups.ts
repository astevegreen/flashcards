import type {
  PackageDeckEntry,
  PackageFolder,
  PackageManifest,
  PackagePreset,
} from '@flash/content-schema';
import {
  buildDeckFolderSavedPayload,
  buildDeckPresetSavedPayload,
  getDeckOrganization,
  getDeckOrganizationHistory,
  listDeckFolders,
  listDeckPresets,
  nextPresetParamsVersion,
  normalizeDeckGroupName,
  PRESET_SETTING_KEYS,
  validWeights,
  type DeckPreset,
} from '../decks/organization.ts';
import {
  resolveDeckFsrsConfig,
  type CollectionState,
  type EventFactory,
} from '../events/replay.ts';
import type { KnownEvent } from '../events/types.ts';
import { DEFAULT_DECK_SETTINGS, type Deck } from '../model/types.ts';
import { compareCodeUnits } from '../compare.ts';
import { clipFSRS6Parameters, migrateFSRS6Parameters } from 'ts-fsrs/models/fsrs-6';

/**
 * Shared option presets and deck folders in `.flashpkg` packages.
 *
 * Export writes the live presets and folders the exported decks use into the manifest
 * (`presets`, `folders`) and points each deck entry at them (`preset_id`, `folder_id`).
 *
 * Import never overwrites a preset or folder the user has. Each package preset (and folder) is
 * resolved once, in this order:
 * 1. a live one with the same id: used as it is (the user's values win, nothing is written);
 * 2. else a live one with the same name (after trimming, exact code units; the first by name then
 *    id): used as it is;
 * 3. else, when this collection once had that id and deleted it: none (a delete is final), so the
 *    deck keeps its own settings or stays unfiled;
 * 4. else a new one with the package's id and values (`DeckPresetSaved` / `DeckFolderSaved`).
 * Saves an import writes are marked `from_package`, so the user's own edits to the same preset or
 * folder win over them on every device, even edits this device has not synced yet.
 * A deck the import creates joins the resolved preset and folder; joining copies the preset into
 * the deck like the Library does (`DeckSettingsChanged`, and `DeckFSRSParamsChanged` for shared
 * weights). A deck that already exists never joins a package preset (that would overwrite the
 * limits, retention and weights the user tuned), and joins a folder only when it never had a
 * folder assignment, even a cleared one, so a package never moves a deck the user placed.
 */

export interface PackageGroups {
  presets?: PackagePreset[];
  folders?: PackageFolder[];
  /** deck id -> package preset id / folder id. */
  presetByDeck: Map<string, string>;
  folderByDeck: Map<string, string>;
}

/** The presets and folders `decks` use, for the manifest (sorted by id). */
export function packageGroupsForDecks(
  state: CollectionState,
  decks: readonly Deck[],
): PackageGroups {
  const org = getDeckOrganization(state);
  const presets = new Map<string, PackagePreset>();
  const folders = new Map<string, PackageFolder>();
  const presetByDeck = new Map<string, string>();
  const folderByDeck = new Map<string, string>();
  for (const deck of decks) {
    const presetId = org.presetByDeck.get(deck.id);
    const preset = presetId === undefined ? undefined : org.presets.get(presetId);
    if (preset) {
      presetByDeck.set(deck.id, preset.id);
      presets.set(preset.id, {
        id: preset.id,
        name: preset.name,
        settings: { ...preset.settings },
        ...(preset.w ? { w: [...preset.w] } : {}),
      });
    }
    const folderId = org.folderByDeck.get(deck.id);
    const folder = folderId === undefined ? undefined : org.folders.get(folderId);
    if (folder) {
      folderByDeck.set(deck.id, folder.id);
      folders.set(folder.id, { id: folder.id, name: folder.name });
    }
  }
  const byId = <T extends { id: string }>(a: T, b: T) => compareCodeUnits(a.id, b.id);
  return {
    ...(presets.size > 0 ? { presets: [...presets.values()].sort(byId) } : {}),
    ...(folders.size > 0 ? { folders: [...folders.values()].sort(byId) } : {}),
    presetByDeck,
    folderByDeck,
  };
}

/** The package's settings without `undefined` entries (validated by the payload builder). */
function definedSettings(raw: PackagePreset['settings']): Partial<DeckPreset['settings']> {
  const out: Partial<DeckPreset['settings']> = {};
  for (const key of PRESET_SETTING_KEYS) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * A package preset's weights, or `undefined` when they are not a 17, 19 or 21 vector inside the
 * FSRS-6 model bounds (after migrating shorter vectors as ts-fsrs does). Out-of-range weights are
 * dropped, not clipped: the preset still comes in, and its decks keep their own weights (§13).
 */
export function packageWeights(raw: readonly number[] | undefined): number[] | undefined {
  const w = raw === undefined ? undefined : validWeights([...raw]);
  if (!w) return undefined;
  const migrated = migrateFSRS6Parameters(w);
  const clipped = clipFSRS6Parameters(migrated, 0, false);
  return clipped.every((x, i) => x === migrated[i]) ? w : undefined;
}

type ResolvedPreset = Pick<DeckPreset, 'id' | 'settings' | 'w'>;

export interface PackageGroupImporter {
  /**
   * Events that put the deck in the package's preset and folder (and create those when needed,
   * see the module comment). `existing` is false for a deck this import creates.
   */
  eventsForDeck(deckId: string, entry: PackageDeckEntry, existing: boolean): KnownEvent[];
}

export function createPackageGroupImporter(
  state: CollectionState,
  manifest: PackageManifest,
  eventFactory: EventFactory,
  nowMs: number,
): PackageGroupImporter {
  const org = getDeckOrganization(state);
  const history = getDeckOrganizationHistory(state);
  const livePresets = listDeckPresets(state);
  const liveFolders = listDeckFolders(state);
  const pkgPresets = new Map((manifest.presets ?? []).map((p) => [p.id, p] as const));
  const pkgFolders = new Map((manifest.folders ?? []).map((f) => [f.id, f] as const));
  const presetCache = new Map<string, ResolvedPreset | null>();
  const folderCache = new Map<string, string | null>();

  function resolvePreset(pkgId: string, out: KnownEvent[]): ResolvedPreset | null {
    const cached = presetCache.get(pkgId);
    if (cached !== undefined) return cached;
    let resolved: ResolvedPreset | null = null;
    const pkg = pkgPresets.get(pkgId);
    if (pkg) {
      const name = normalizeDeckGroupName(pkg.name);
      const live =
        org.presets.get(pkg.id) ??
        (name === undefined ? undefined : livePresets.find((p) => p.name === name));
      if (live) {
        resolved = live;
      } else if (!history.deletedPresetIds.has(pkg.id)) {
        const weights = packageWeights(pkg.w);
        const payload = buildDeckPresetSavedPayload({
          presetId: pkg.id,
          name: pkg.name,
          settings: definedSettings(pkg.settings),
          ...(weights ? { w: weights } : {}),
        });
        if (payload) {
          out.push(
            eventFactory.create('DeckPresetSaved', { ...payload, from_package: true }, nowMs),
          );
          resolved = {
            id: pkg.id,
            settings: {
              new_cards_per_day: DEFAULT_DECK_SETTINGS.new_cards_per_day,
              max_reviews_per_day: DEFAULT_DECK_SETTINGS.max_reviews_per_day,
              target_retention: DEFAULT_DECK_SETTINGS.target_retention,
              ...payload.settings,
            },
            ...(payload.w ? { w: payload.w } : {}),
          };
        }
      }
    }
    presetCache.set(pkgId, resolved);
    return resolved;
  }

  function resolveFolder(pkgId: string, out: KnownEvent[]): string | null {
    const cached = folderCache.get(pkgId);
    if (cached !== undefined) return cached;
    let resolved: string | null = null;
    const pkg = pkgFolders.get(pkgId);
    if (pkg) {
      const name = normalizeDeckGroupName(pkg.name);
      const live =
        org.folders.get(pkg.id) ??
        (name === undefined ? undefined : liveFolders.find((f) => f.name === name));
      if (live) {
        resolved = live.id;
      } else if (!history.deletedFolderIds.has(pkg.id)) {
        const payload = buildDeckFolderSavedPayload(pkg.id, pkg.name);
        if (payload) {
          out.push(
            eventFactory.create('DeckFolderSaved', { ...payload, from_package: true }, nowMs),
          );
          resolved = pkg.id;
        }
      }
    }
    folderCache.set(pkgId, resolved);
    return resolved;
  }

  /** Copies the preset into a deck this import creates (default settings, no FSRS versions). */
  function copyPresetIntoNewDeck(deckId: string, preset: ResolvedPreset): KnownEvent[] {
    const out = [
      eventFactory.create(
        'DeckSettingsChanged',
        { deck_id: deckId, settings: { ...preset.settings } },
        nowMs,
      ),
    ];
    if (preset.w) {
      out.push(
        eventFactory.create(
          'DeckFSRSParamsChanged',
          {
            deck_id: deckId,
            params_version: nextPresetParamsVersion(state, deckId, nowMs, eventFactory.deviceId),
            effective_from: nowMs,
            params: {
              ...resolveDeckFsrsConfig(state, deckId, nowMs),
              request_retention: preset.settings.target_retention,
              w: [...preset.w],
            },
          },
          nowMs,
        ),
      );
    }
    return out;
  }

  return {
    eventsForDeck(deckId, entry, existing) {
      const out: KnownEvent[] = [];
      const grouping: { deck_id: string; preset_id?: string; folder_id?: string } = {
        deck_id: deckId,
      };
      let preset: ResolvedPreset | null = null;
      // Only a deck this import creates joins a preset: joining copies the preset's limits,
      // retention and weights, which would overwrite what the user tuned on an existing deck.
      if (entry.preset_id !== undefined && !existing) {
        preset = resolvePreset(entry.preset_id, out);
        if (preset && org.presetByDeck.get(deckId) !== preset.id) grouping.preset_id = preset.id;
      }
      if (
        entry.folder_id !== undefined &&
        !(existing && history.decksWithFolderHistory.has(deckId))
      ) {
        const folderId = resolveFolder(entry.folder_id, out);
        if (folderId !== null && org.folderByDeck.get(deckId) !== folderId) {
          grouping.folder_id = folderId;
        }
      }
      if (grouping.preset_id !== undefined || grouping.folder_id !== undefined) {
        out.push(eventFactory.create('DeckGroupingChanged', grouping, nowMs));
      }
      if (grouping.preset_id !== undefined && preset) {
        out.push(...copyPresetIntoNewDeck(deckId, preset));
      }
      return out;
    },
  };
}
