import {
  normalizeDictionaryQuery,
  rankDictionaryResults,
  type DictionaryEntry,
  type DictionaryPackId,
} from '@flash/core/dictionary';
import type {
  DictionarySearchOptions,
  DictionaryService,
  InstalledPackInfo,
} from '@flash/platform';
import type { DexiePackStorage } from '../packs/dexie-pack-storage.ts';

/**
 * Offline dictionary lookup & bidirectional search service over IndexedDB (`DexiePackStorage`, §6.3).
 */
export class WebDictionaryService implements DictionaryService {
  private readonly packStorage: DexiePackStorage;

  constructor(packStorage: DexiePackStorage) {
    this.packStorage = packStorage;
  }

  async listInstalledDictionaryPacks(): Promise<InstalledPackInfo[]> {
    const all = await this.packStorage.listInstalledPacks();
    return all.filter((p) => p.kind === 'dictionary');
  }

  async lookupCharacter(
    char: string,
    opts?: { packIds?: readonly DictionaryPackId[] },
  ): Promise<DictionaryEntry[]> {
    const trimmed = char.normalize('NFC').trim();
    if (!trimmed) return [];
    const direct = await this.packStorage.lookupDictionaryByHeadword(trimmed, opts?.packIds);
    const tokenMatches = await this.packStorage.queryDictionaryCandidates(
      [trimmed.toLowerCase()],
      opts?.packIds,
      100,
    );
    const seen = new Set<string>();
    const combined: DictionaryEntry[] = [];
    for (const entry of [...direct, ...tokenMatches]) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      combined.push(entry);
    }
    return rankDictionaryResults(combined, trimmed, {
      ...(opts?.packIds ? { packIds: opts.packIds } : {}),
      limit: 40,
    });
  }

  async search(query: string, opts: DictionarySearchOptions = {}): Promise<DictionaryEntry[]> {
    const q = normalizeDictionaryQuery(query);
    if (!q.raw) return [];

    const prefixTokens = new Set<string>();
    prefixTokens.add(q.lower);
    if (q.kanaFolded) prefixTokens.add(q.kanaFolded);
    if (q.latinStripped) {
      prefixTokens.add(q.latinStripped);
      for (const word of q.latinStripped.split(/\s+/)) {
        if (word.length >= 2) prefixTokens.add(word);
      }
    }
    if (q.latinCompact && q.latinCompact.length >= 2) {
      prefixTokens.add(q.latinCompact);
    }

    const [direct, candidates] = await Promise.all([
      this.packStorage.lookupDictionaryByHeadword(q.raw, opts.packIds),
      this.packStorage.queryDictionaryCandidates([...prefixTokens], opts.packIds, 450),
    ]);

    const seen = new Set<string>();
    const merged: DictionaryEntry[] = [];
    for (const entry of [...direct, ...candidates]) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }

    return rankDictionaryResults(merged, q.raw, {
      ...(opts.packIds ? { packIds: opts.packIds } : {}),
      limit: opts.limit ?? 50,
    });
  }
}
