/**
 * First-syllable sharding for dictionary packs too large for one static file (25 MiB on
 * Cloudflare Pages).
 *
 * A sharded pack is an **index** plus **shards**:
 * - The index (`format_version: 2`, at the catalog `url`) holds a *stub* of every entry: all the
 *   fields search, ranking and browse use (headword, Hanja, pronunciation, conjugations, glosses,
 *   per-sense English equivalents, POS, level, topics), without definitions, examples and links.
 *   So every query type (Korean, English → Korean, romanization, 초성, jamo, Hanja → word) and
 *   every browse list works from the index alone, exactly as on an unsharded pack.
 * - Each shard holds the full entries whose headword starts with a syllable in its range
 *   (`from`–`to`), plus their positions in the index, so a full row replaces its stub in place.
 *   Shards are cut at initial-consonant (초성) boundaries where possible.
 *
 * The builder lives here (pure, with the encoder injected) so the pack build and the tests make
 * packs the same way.
 */
import type {
  DictionaryEntry,
  DictionaryShardDescriptor,
  DictionaryShardingInfo,
  DictionarySense,
} from './types.ts';

export const DICTIONARY_SHARD_SCHEME = 'first-syllable-v1';
/** Pack `format_version` of a sharded pack's index and of its shard files. */
export const SHARDED_PACK_FORMAT_VERSION = 2;

const S_BASE = 0xac00;
const S_LAST = 0xd7a3;
const SYLLABLES_PER_INITIAL = 21 * 28;

/** An entry as stored in a pack file (before ids and search tokens are added). */
export type RawDictionaryEntry = Omit<DictionaryEntry, 'id' | 'packId' | 'searchTokens'>;

function firstSyllableCode(headword: string): number | undefined {
  const cp = headword.normalize('NFC').trim().codePointAt(0);
  return cp !== undefined && cp >= S_BASE && cp <= S_LAST ? cp : undefined;
}

function codeOf(syllable: string): number {
  return syllable.codePointAt(0) ?? 0;
}

/** The shard holding `headword`'s full entry, or `undefined` when no shard covers it. */
export function findShardForHeadword(
  sharding: Pick<DictionaryShardingInfo, 'shards'>,
  headword: string,
): DictionaryShardDescriptor | undefined {
  const cp = firstSyllableCode(headword);
  for (const shard of sharding.shards) {
    if (shard.from === undefined || shard.to === undefined) {
      if (cp === undefined) return shard;
    } else if (cp !== undefined && cp >= codeOf(shard.from) && cp <= codeOf(shard.to)) {
      return shard;
    }
  }
  return undefined;
}

function stubSense(sense: DictionarySense): DictionarySense {
  // Every sense stays (English ranking prefers earlier senses), but only a sense without English
  // equivalents keeps one definition, so the pack decoder doesn't drop it as empty.
  const keep: Partial<DictionarySense> = {};
  if (sense.equivalents.length === 0) {
    if (sense.definition) keep.definition = sense.definition;
    else if (sense.definitionNative) keep.definitionNative = sense.definitionNative;
  }
  return {
    equivalents: sense.equivalents,
    ...keep,
    ...(sense.source ? { source: sense.source } : {}),
  };
}

/**
 * The index row for one entry: the same search tokens, browse keys and ranking as the full
 * entry, without definitions, examples and related-word links.
 */
export function toDictionaryStubEntry(entry: RawDictionaryEntry): RawDictionaryEntry {
  const out: RawDictionaryEntry = { ...entry };
  delete out.browseKeys;
  delete out.stub;
  if (entry.senses) out.senses = entry.senses.map(stubSense);
  return out;
}

export interface DictionaryShardPlan {
  /** First and last syllable covered (inclusive); absent for the non-Hangul shard. */
  from?: string;
  to?: string;
  /** Positions of the shard's entries in the pack, ascending. */
  indices: number[];
}

type Member = readonly [cp: number, index: number];

/** Where to cut `members` (sorted by syllable) in two: an initial-consonant boundary if any. */
function chooseCut(members: readonly Member[]): number | undefined {
  const first = members[0];
  if (!first) return undefined;
  const blockOf = (cp: number): number => Math.floor((cp - S_BASE) / SYLLABLES_PER_INITIAL);
  const lastMember = members.at(-1);
  const spansInitials = lastMember !== undefined && blockOf(lastMember[0]) !== blockOf(first[0]);
  const candidates: number[] = [];
  for (const [cp] of members) {
    const cut = spansInitials ? S_BASE + blockOf(cp) * SYLLABLES_PER_INITIAL : cp;
    if (cut > first[0] && cut !== candidates.at(-1)) candidates.push(cut);
  }
  let best: number | undefined;
  let bestImbalance = Number.POSITIVE_INFINITY;
  let below = 0;
  for (const cut of candidates) {
    while (below < members.length && (members[below]?.[0] ?? 0) < cut) below++;
    const imbalance = Math.abs(below - (members.length - below));
    if (imbalance < bestImbalance) {
      best = cut;
      bestImbalance = imbalance;
    }
  }
  return best;
}

/**
 * Splits a pack's entries into shards of at most `maxShardBytes` (as `measure` reports for a
 * shard holding `indices`). Hangul ranges are halved recursively, at 초성 boundaries while a range
 * spans more than one initial consonant, then at syllable boundaries. Entries whose headword
 * doesn't start with a Hangul syllable go into one extra shard. Deterministic for a given input.
 */
export function planDictionaryShards(
  entries: readonly RawDictionaryEntry[],
  opts: { maxShardBytes: number; measure: (indices: readonly number[]) => number },
): DictionaryShardPlan[] {
  const plans: DictionaryShardPlan[] = [];
  const rest: number[] = [];
  const hangul: Member[] = [];
  entries.forEach((entry, index) => {
    const cp = firstSyllableCode(entry.headword);
    if (cp === undefined) rest.push(index);
    else hangul.push([cp, index]);
  });
  if (rest.length > 0) {
    if (opts.measure(rest) > opts.maxShardBytes) {
      throw new Error(
        `Cannot shard: the ${rest.length} entries not starting with a Hangul syllable exceed ${opts.maxShardBytes} bytes.`,
      );
    }
    plans.push({ indices: rest });
  }
  hangul.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const split = (lo: number, hi: number, members: readonly Member[]): void => {
    if (members.length === 0) return;
    const indices = members.map((m) => m[1]).sort((a, b) => a - b);
    if (opts.measure(indices) <= opts.maxShardBytes) {
      plans.push({ from: String.fromCodePoint(lo), to: String.fromCodePoint(hi), indices });
      return;
    }
    const cut = chooseCut(members);
    if (cut === undefined) {
      throw new Error(
        `Cannot shard: the ${members.length} entries starting with "${String.fromCodePoint(members[0]?.[0] ?? lo)}" alone exceed ${opts.maxShardBytes} bytes.`,
      );
    }
    split(
      lo,
      cut - 1,
      members.filter((m) => m[0] < cut),
    );
    split(
      cut,
      hi,
      members.filter((m) => m[0] >= cut),
    );
  };
  split(S_BASE, S_LAST, hangul);
  return plans;
}

/** One encoded pack file (gzipped JSON); sizes and the hash describe it in manifests. */
export interface EncodedPackFile {
  bytes: Uint8Array;
  compressed_bytes: number;
  uncompressed_bytes: number;
  /** SHA-256 of the uncompressed JSON (as for every pack, so HTTP content-encoding can't break it). */
  sha256: string;
}

export interface ShardedDictionaryPack {
  index: { file: string; encoded: EncodedPackFile; entryCount: number };
  shards: Array<{ descriptor: DictionaryShardDescriptor; encoded: EncodedPackFile }>;
  sharding: DictionaryShardingInfo;
}

/**
 * Builds a sharded dictionary pack: the shard files and the `format_version: 2` index whose
 * manifest lists them. `manifest` is the pack's ordinary (format 1) manifest.
 */
export function buildShardedDictionaryPack(input: {
  manifest: { id: string; version: string } & Record<string, unknown>;
  entries: readonly RawDictionaryEntry[];
  /** File name of the index (e.g. `dict-krdict.json.gz`); shards are named after it. */
  indexFile: string;
  maxShardBytes: number;
  encode: (payload: unknown) => EncodedPackFile;
}): ShardedDictionaryPack {
  const { manifest, entries } = input;
  const base = input.indexFile.replace(/\.json(\.gz)?$/, '');
  const shardPayload = (key: string, indices: readonly number[]) => ({
    shard: {
      format_version: SHARDED_PACK_FORMAT_VERSION,
      pack_id: manifest.id,
      version: manifest.version,
      key,
    },
    indices,
    entries: indices.map((i) => entries[i]),
  });

  const plans = planDictionaryShards(entries, {
    maxShardBytes: input.maxShardBytes,
    measure: (indices) => input.encode(shardPayload('s00', indices)).compressed_bytes,
  });

  let next = 1;
  const shards = plans.map((plan) => {
    const key = plan.from === undefined ? 's00' : `s${String(next++).padStart(2, '0')}`;
    const encoded = input.encode(shardPayload(key, plan.indices));
    const descriptor: DictionaryShardDescriptor = {
      key,
      file: `${base}.${key}.json.gz`,
      ...(plan.from !== undefined && plan.to !== undefined ? { from: plan.from, to: plan.to } : {}),
      entry_count: plan.indices.length,
      compressed_bytes: encoded.compressed_bytes,
      uncompressed_bytes: encoded.uncompressed_bytes,
      sha256: encoded.sha256,
    };
    return { descriptor, encoded };
  });

  const sharding: DictionaryShardingInfo = {
    scheme: DICTIONARY_SHARD_SCHEME,
    total_entries: entries.length,
    shards: shards.map((s) => s.descriptor),
  };
  const index = input.encode({
    manifest: { ...manifest, format_version: SHARDED_PACK_FORMAT_VERSION, sharding },
    entries: entries.map(toDictionaryStubEntry),
  });
  return {
    index: { file: input.indexFile, encoded: index, entryCount: entries.length },
    shards,
    sharding,
  };
}
