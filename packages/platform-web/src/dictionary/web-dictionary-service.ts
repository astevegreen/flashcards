import {
  planDictionarySearch,
  rankDictionaryResults,
  type DictionaryBrowsePage,
  type DictionaryBrowseQuery,
  type DictionaryBrowseSummary,
  type DictionaryEntry,
  type DictionaryPackId,
} from '@flash/core/dictionary';
import type {
  DictionarySearchOptions,
  DictionaryService,
  InstalledPackInfo,
} from '@flash/platform';
import type { DexiePackStorage } from '../packs/dexie-pack-storage.ts';
import { DictionaryShardLoader } from '../packs/dictionary-shards.ts';

export interface WebDictionaryServiceOptions {
  allowRelativeUrls?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Sharded packs: how many of the best results get their full rows, and how many shards one
 * search or browse page may download for them. A Korean query's results share its first
 * syllable, so they nearly always need one shard; an English query's top results can sit in
 * several, and the rest stay stubs (headword, glosses, POS, level) until opened or added.
 */
const HYDRATE_TOP_RESULTS = 12;
const MAX_SHARDS_PER_LOOKUP = 3;

/**
 * Offline dictionary lookup & bidirectional search service over IndexedDB (`DexiePackStorage`, §6.3).
 */
export class WebDictionaryService implements DictionaryService {
  private readonly packStorage: DexiePackStorage;
  private readonly shards: DictionaryShardLoader;

  constructor(packStorage: DexiePackStorage, options: WebDictionaryServiceOptions = {}) {
    this.packStorage = packStorage;
    this.shards = new DictionaryShardLoader({ packStorage, ...options });
  }

  /** Replaces the stub rows among the first results with full rows (sharded packs only). */
  private async hydrateTop(entries: DictionaryEntry[]): Promise<DictionaryEntry[]> {
    const top = entries.slice(0, HYDRATE_TOP_RESULTS);
    if (!top.some((e) => e.stub)) return entries;
    const full = await this.shards.loadFullEntries(top, { maxShards: MAX_SHARDS_PER_LOOKUP });
    return [...full, ...entries.slice(top.length)];
  }

  loadFullEntries(entries: readonly DictionaryEntry[]): Promise<DictionaryEntry[]> {
    return this.shards.loadFullEntries(entries);
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
    return this.hydrateTop(
      rankDictionaryResults(combined, trimmed, {
        ...(opts?.packIds ? { packIds: opts.packIds } : {}),
        limit: 40,
      }),
    );
  }

  async search(query: string, opts: DictionarySearchOptions = {}): Promise<DictionaryEntry[]> {
    // Core plans the lookups: prefix tokens (incl. 초성 / jamo / English reverse-index keys) plus
    // exact headword candidates from Korean deinflection and romanization, validated by fetching them.
    const plan = planDictionarySearch(query, opts.direction);
    const q = plan.query;
    if (!q.raw) return [];

    const [direct, lemmas, candidates] = await Promise.all([
      this.packStorage.lookupDictionaryByHeadword(q.raw, opts.packIds),
      this.packStorage.lookupDictionaryByHeadwords(plan.headwordCandidates, opts.packIds),
      this.packStorage.queryDictionaryCandidates(plan.prefixTokens, opts.packIds, 450),
    ]);

    const seen = new Set<string>();
    const merged: DictionaryEntry[] = [];
    for (const entry of [...direct, ...lemmas, ...candidates]) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }

    return this.hydrateTop(
      rankDictionaryResults(merged, q.raw, {
        ...(opts.packIds ? { packIds: opts.packIds } : {}),
        limit: opts.limit ?? 50,
        ...(opts.direction ? { direction: opts.direction } : {}),
      }),
    );
  }

  async browse(query: DictionaryBrowseQuery): Promise<DictionaryBrowsePage> {
    // Browse lists come from the index's stub rows, so they never wait for every shard.
    const page = await this.packStorage.browseDictionary(query);
    const entries = await this.hydrateTop(page.entries);
    return page.next ? { entries, next: page.next } : { entries };
  }

  getBrowseSummary(packId: DictionaryPackId): Promise<DictionaryBrowseSummary> {
    return this.packStorage.getBrowseSummary(packId);
  }
}
