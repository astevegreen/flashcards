import {
  isSafePackUrl,
  PackIdSchema,
  validateDictionarySharding,
  validatePackCatalog,
  type SchemaValidationError,
} from '@flash/content-schema';
import { Gunzip } from 'fflate';
import { isValidHanziStrokeData } from '../drawing/kanjivg.ts';
import { decodeUtf8 } from '../utf8-decode.ts';
import { sha256Hex } from '../sources/hash.ts';
import type {
  DecodedPackPayload,
  DictionaryEntry,
  DictionaryExample,
  DictionaryRelation,
  DictionaryLevel,
  DictionaryPackId,
  DictionaryPackManifest,
  DictionarySense,
  DictionarySenseSource,
  DictionaryShardDescriptor,
  DictionaryShardingInfo,
  PackCatalog,
  StrokePackId,
  StrokePackManifest,
} from './types.ts';
import { buildEntryBrowseKeys } from './browse.ts';
import { buildEntrySearchTokens } from './search.ts';
import {
  findShardForHeadword,
  SHARDED_PACK_FORMAT_VERSION,
  type RawDictionaryEntry,
} from './shards.ts';

export const PACK_SECURITY_LIMITS = {
  maxCatalogBytes: 1 * 1024 * 1024, // 1 MB
  maxCompressedBytes: 50 * 1024 * 1024, // 50 MB
  maxUncompressedBytes: 150 * 1024 * 1024, // 150 MB (supports full JMdict)
  maxEntries: 400_000,
} as const;

export class PackValidationError extends Error {
  readonly errors: SchemaValidationError[];
  constructor(message: string, errors: SchemaValidationError[] = []) {
    super(message);
    this.name = 'PackValidationError';
    this.errors = errors;
  }
}

export function assertSafePackUrl(rawUrl: string, allowRelative = false): string {
  const trimmed = rawUrl.trim();
  if (!isSafePackUrl(trimmed, allowRelative)) {
    throw new PackValidationError(
      allowRelative
        ? `Unsafe or invalid pack URL "${rawUrl}". Only https:// URLs or safe /packs/... paths are allowed.`
        : `Unsafe or invalid pack URL "${rawUrl}". Only https:// URLs without credentials are allowed.`,
    );
  }
  return trimmed.startsWith('/') ? trimmed : `https://${trimmed.slice(8)}`;
}

/**
 * Validates raw JSON text for the unified static `packs.json` manifest (§3.4, §6.3, §13).
 */
export function parseAndValidatePackCatalog(
  rawJson: string,
  opts?: { allowRelativeUrls?: boolean },
): PackCatalog {
  if (rawJson.length > PACK_SECURITY_LIMITS.maxCatalogBytes) {
    throw new PackValidationError(
      `Pack catalog exceeds max size (${PACK_SECURITY_LIMITS.maxCatalogBytes} bytes).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new PackValidationError(
      `Invalid packs.json manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const res = validatePackCatalog(parsed);
  if (!res.ok) {
    throw new PackValidationError('Invalid packs.json catalog schema.', res.errors);
  }

  const allowRelative = Boolean(opts?.allowRelativeUrls);
  const seenIds = new Set<string>();
  for (const entry of res.data.packs) {
    if (seenIds.has(entry.id)) {
      throw new PackValidationError(`Duplicate pack id "${entry.id}" in packs.json.`);
    }
    seenIds.add(entry.id);
    assertSafePackUrl(entry.url, allowRelative);
    if (entry.char_url_template) {
      assertSafePackUrl(entry.char_url_template, allowRelative);
    }
  }

  return res.data;
}

/** Streaming gzip decompression with strict uncompressed byte cap (§13 gzip-bomb guard). */
export function safeGunzipWithCap(
  bytes: Uint8Array,
  maxUncompressedBytes = PACK_SECURITY_LIMITS.maxUncompressedBytes,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;

  const gunzip = new Gunzip((chunk) => {
    total += chunk.byteLength;
    if (total > maxUncompressedBytes) {
      exceeded = true;
      throw new PackValidationError(
        `Pack archive exceeds maximum uncompressed byte cap (${maxUncompressedBytes} bytes).`,
      );
    }
    chunks.push(chunk);
  });

  // Feed in 64 KB slices so oversized bombs abort early before allocating huge output buffers
  const sliceSize = 64 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += sliceSize) {
    const end = Math.min(offset + sliceSize, bytes.byteLength);
    const isFinal = end >= bytes.byteLength;
    gunzip.push(bytes.subarray(offset, end), isFinal);
    if (exceeded) {
      throw new PackValidationError(
        `Pack archive exceeds maximum uncompressed byte cap (${maxUncompressedBytes} bytes).`,
      );
    }
  }

  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

function isGzipMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

/** Per-entry caps for the optional Phase 10 word-pack fields (defence against oversized packs). */
const WORD_FIELD_LIMITS = {
  maxStringLength: 2000,
  maxListItems: 32,
  maxSenses: 64,
  maxExamplesPerSense: 8,
} as const;

function cleanString(val: unknown): string | undefined {
  if (!isNonEmptyString(val)) return undefined;
  const t = val.normalize('NFC').trim();
  return t.length > WORD_FIELD_LIMITS.maxStringLength
    ? t.slice(0, WORD_FIELD_LIMITS.maxStringLength)
    : t;
}

function cleanStringList(val: unknown, max: number = WORD_FIELD_LIMITS.maxListItems): string[] {
  if (!Array.isArray(val)) return [];
  const out: string[] = [];
  for (const item of val) {
    const s = cleanString(item);
    if (s !== undefined) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

const LEVELS: ReadonlySet<string> = new Set<DictionaryLevel>([
  'beginner',
  'intermediate',
  'advanced',
]);
const EXAMPLE_TYPES: ReadonlySet<string> = new Set(['phrase', 'sentence', 'dialogue']);
const SENSE_SOURCES: ReadonlySet<string> = new Set<DictionarySenseSource>([
  'krdict',
  'urimalsam',
  'kaikki',
  'app',
]);

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return val && typeof val === 'object' ? (val as Record<string, unknown>) : undefined;
}

function decodeExample(raw: unknown): DictionaryExample | undefined {
  const ex = asRecord(raw);
  if (!ex) return undefined;
  const text = cleanString(ex['text']);
  if (!text) return undefined;
  const translation = cleanString(ex['translation']);
  const type = typeof ex['type'] === 'string' && EXAMPLE_TYPES.has(ex['type']) ? ex['type'] : '';
  return {
    text,
    ...(translation ? { translation } : {}),
    ...(type ? { type: type as NonNullable<DictionaryExample['type']> } : {}),
  };
}

function decodeExamples(val: unknown): DictionaryExample[] {
  if (!Array.isArray(val)) return [];
  const examples: DictionaryExample[] = [];
  for (const rawEx of val) {
    if (examples.length >= WORD_FIELD_LIMITS.maxExamplesPerSense) break;
    const ex = decodeExample(rawEx);
    if (ex) examples.push(ex);
  }
  return examples;
}

const RELATION_TYPES: ReadonlySet<string> = new Set(['synonym', 'antonym', 'related']);
const MAX_RELATIONS_PER_SENSE = 12;

function decodeRelations(val: unknown): DictionaryRelation[] {
  if (!Array.isArray(val)) return [];
  const out: DictionaryRelation[] = [];
  const seen = new Set<string>();
  for (const raw of val) {
    if (out.length >= MAX_RELATIONS_PER_SENSE) break;
    const r = asRecord(raw);
    const word = r ? cleanString(r['word']) : undefined;
    if (!r || !word || typeof r['type'] !== 'string' || !RELATION_TYPES.has(r['type'])) continue;
    const key = `${r['type']}:${word}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: r['type'] as DictionaryRelation['type'], word });
  }
  return out;
}

/** One sense, or `undefined` when it carries neither an equivalent nor a definition. */
function decodeSense(raw: unknown): DictionarySense | undefined {
  const s = asRecord(raw);
  if (!s) return undefined;
  const equivalents = cleanStringList(s['equivalents']);
  const definition = cleanString(s['definition']);
  const definitionNative = cleanString(s['definitionNative']);
  if (equivalents.length === 0 && !definition && !definitionNative) return undefined;
  const examples = decodeExamples(s['examples']);
  const relations = decodeRelations(s['relations']);
  const source =
    typeof s['source'] === 'string' && SENSE_SOURCES.has(s['source'])
      ? (s['source'] as DictionarySenseSource)
      : undefined;
  return {
    equivalents,
    ...(definition ? { definition } : {}),
    ...(definitionNative ? { definitionNative } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    ...(relations.length > 0 ? { relations } : {}),
    ...(source ? { source } : {}),
  };
}

function decodeSenses(val: unknown): DictionarySense[] {
  if (!Array.isArray(val)) return [];
  const senses: DictionarySense[] = [];
  for (const raw of val) {
    if (senses.length >= WORD_FIELD_LIMITS.maxSenses) break;
    const sense = decodeSense(raw);
    if (sense) senses.push(sense);
  }
  return senses;
}

/**
 * Decodes the optional Phase 10 word-pack fields (`pos`, `level`, `origin`, `homonym`, `forms`,
 * `senses`, `topics`). Absent fields stay absent, so Phase 6 packs decode byte-for-byte as before.
 */
function decodeWordPackFields(
  e: Record<string, unknown>,
): Pick<DictionaryEntry, 'pos' | 'level' | 'origin' | 'homonym' | 'forms' | 'senses' | 'topics'> {
  const pos = cleanStringList(e['pos'], 8);
  const level =
    typeof e['level'] === 'string' && LEVELS.has(e['level'])
      ? (e['level'] as DictionaryLevel)
      : undefined;
  const origin = cleanString(e['origin']);
  const homonym =
    typeof e['homonym'] === 'number' &&
    Number.isInteger(e['homonym']) &&
    e['homonym'] >= 0 &&
    e['homonym'] < 1000
      ? e['homonym']
      : undefined;
  const forms = cleanStringList(e['forms']);
  const senses = decodeSenses(e['senses']);
  const topics = [...new Set(cleanStringList(e['topics'], 8).map((t) => t.slice(0, 64)))];
  return {
    ...(pos.length > 0 ? { pos } : {}),
    ...(level ? { level } : {}),
    ...(origin ? { origin } : {}),
    ...(homonym !== undefined ? { homonym } : {}),
    ...(forms.length > 0 ? { forms } : {}),
    ...(senses.length > 0 ? { senses } : {}),
    ...(topics.length > 0 ? { topics } : {}),
  };
}

function checkedEntryArray(val: unknown): unknown[] {
  if (!Array.isArray(val)) {
    throw new PackValidationError('Dictionary pack must contain an "entries" array.');
  }
  if (val.length > PACK_SECURITY_LIMITS.maxEntries) {
    throw new PackValidationError(
      `Dictionary pack exceeds entry limit (${PACK_SECURITY_LIMITS.maxEntries}).`,
    );
  }
  return val;
}

function nonEmptyStrings(val: unknown): string[] | undefined {
  return Array.isArray(val) ? val.filter((x): x is string => isNonEmptyString(x)) : undefined;
}

function positiveNumber(val: unknown, integer: boolean): number | undefined {
  if (typeof val !== 'number' || val <= 0) return undefined;
  const valid = integer ? Number.isInteger(val) : Number.isFinite(val);
  return valid ? val : undefined;
}

function trimmedNonEmpty(val: unknown): string | undefined {
  return isNonEmptyString(val) ? val.trim() : undefined;
}

/** One pack entry, or `undefined` when it has no headword. */
function decodeDictionaryEntry(rawEntry: unknown): RawDictionaryEntry | undefined {
  if (!rawEntry || typeof rawEntry !== 'object') return undefined;
  const e = rawEntry as Record<string, unknown>;
  if (!isNonEmptyString(e['headword'])) return undefined;
  const readings = nonEmptyStrings(e['readings']) ?? [];
  const meanings = nonEmptyStrings(e['meanings']) ?? [];
  const altForms = nonEmptyStrings(e['altForms']);
  const eumhun = nonEmptyStrings(e['eumhun']);
  const strokeCount = positiveNumber(e['strokeCount'], true);
  const radical = trimmedNonEmpty(e['radical']);
  const grade = trimmedNonEmpty(e['grade']);
  const frequency = positiveNumber(e['frequency'], false);

  return {
    headword: e['headword'].normalize('NFC').trim(),
    readings,
    meanings,
    ...(altForms && altForms.length > 0 ? { altForms } : {}),
    ...(eumhun && eumhun.length > 0 ? { eumhun } : {}),
    ...(strokeCount !== undefined ? { strokeCount } : {}),
    ...(radical !== undefined ? { radical } : {}),
    ...(grade !== undefined ? { grade } : {}),
    ...(frequency !== undefined ? { frequency } : {}),
    ...decodeWordPackFields(e),
  };
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Validates a sharded index's `manifest.sharding` against the index's entry count. */
function decodeSharding(raw: unknown, entryCount: number): DictionaryShardingInfo {
  const res = validateDictionarySharding(raw);
  if (!res.ok) {
    throw new PackValidationError('Invalid sharded pack manifest ("sharding").', res.errors);
  }
  const sharding = res.data;
  if (sharding.total_entries !== entryCount) {
    throw new PackValidationError(
      `Sharded pack index lists ${entryCount} entries but its manifest says ${sharding.total_entries}.`,
    );
  }
  let sum = 0;
  let restShards = 0;
  const keys = new Set<string>();
  const files = new Set<string>();
  const ranges: Array<[string, string]> = [];
  for (const shard of sharding.shards) {
    sum += shard.entry_count;
    if (keys.has(shard.key) || files.has(shard.file)) {
      throw new PackValidationError(`Duplicate shard "${shard.key}" in sharded pack manifest.`);
    }
    keys.add(shard.key);
    files.add(shard.file);
    if (shard.from !== undefined && shard.to !== undefined) ranges.push([shard.from, shard.to]);
    else restShards++;
  }
  ranges.sort((a, b) => compareCodeUnits(a[0], b[0]));
  const overlaps = ranges.some((r, i) => i > 0 && (ranges[i - 1]?.[1] ?? '') >= r[0]);
  if (restShards > 1 || overlaps) {
    throw new PackValidationError('Sharded pack manifest has overlapping shards.');
  }
  if (sum !== entryCount) {
    throw new PackValidationError(
      `Sharded pack shards hold ${sum} entries but the index lists ${entryCount}.`,
    );
  }
  return sharding;
}

export interface DecodedDictionaryShard {
  key: string;
  /** Position in the pack index of each entry (same order as `entries`). */
  indices: number[];
  entries: RawDictionaryEntry[];
}

/**
 * Decodes and validates one shard of a sharded dictionary pack against the installed index:
 * size caps, SHA-256 from the index manifest, pack id / version / key, and every entry's
 * position (each must hold a headword the index routes to this shard).
 */
export function decodeDictionaryShard(
  bytes: Uint8Array,
  expected: {
    packId: DictionaryPackId;
    version: string;
    sharding: DictionaryShardingInfo;
    shard: DictionaryShardDescriptor;
  },
): DecodedDictionaryShard {
  const { shard } = expected;
  const root = parseJsonPack(bytes, {
    expectedSha256: shard.sha256,
    maxCompressedBytes: PACK_SECURITY_LIMITS.maxCompressedBytes,
    maxUncompressedBytes: PACK_SECURITY_LIMITS.maxUncompressedBytes,
  });
  const header = asRecord(root['shard']);
  if (
    header?.['format_version'] !== SHARDED_PACK_FORMAT_VERSION ||
    header['pack_id'] !== expected.packId ||
    header['version'] !== expected.version ||
    header['key'] !== shard.key
  ) {
    throw new PackValidationError(
      `Shard "${shard.key}" does not belong to ${expected.packId} ${expected.version}.`,
    );
  }
  const rawEntries = checkedEntryArray(root['entries']);
  const rawIndices = root['indices'];
  if (
    !Array.isArray(rawIndices) ||
    rawIndices.length !== rawEntries.length ||
    rawEntries.length !== shard.entry_count
  ) {
    throw new PackValidationError(`Shard "${shard.key}" has the wrong number of entries.`);
  }
  const indices: number[] = [];
  const entries: RawDictionaryEntry[] = [];
  const seen = new Set<number>();
  rawEntries.forEach((rawEntry, i) => {
    const index = rawIndices[i];
    const entry = decodeDictionaryEntry(rawEntry);
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expected.sharding.total_entries ||
      seen.has(index) ||
      !entry ||
      findShardForHeadword(expected.sharding, entry.headword)?.key !== shard.key
    ) {
      throw new PackValidationError(`Shard "${shard.key}" has an invalid entry at ${i}.`);
    }
    seen.add(index);
    indices.push(index);
    entries.push(entry);
  });
  return { key: shard.key, indices, entries };
}

function validateManifestCommon(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    throw new PackValidationError('Pack archive is missing manifest object.');
  }
  const m = raw as Record<string, unknown>;
  const shardedIndex =
    m['format_version'] === SHARDED_PACK_FORMAT_VERSION && m['kind'] === 'dictionary';
  if (m['format_version'] !== 1 && !shardedIndex) {
    throw new PackValidationError(
      `Unsupported pack format_version: ${String(m['format_version'])}.`,
    );
  }
  const idCheck = PackIdSchema.safeParse(m['id']);
  if (!idCheck.success) {
    throw new PackValidationError(`Invalid pack id "${String(m['id'])}".`);
  }
  for (const field of [
    'name',
    'version',
    'language',
    'description',
    'license_name',
    'license_url',
    'attribution',
    'source_url',
  ]) {
    if (!isNonEmptyString(m[field])) {
      throw new PackValidationError(`Pack manifest missing required field "${field}".`);
    }
  }
  // The licence and source links are shown to the user, so they must be plain https (S13).
  for (const field of ['license_url', 'source_url']) {
    if (!isSafePackUrl(String(m[field]).trim(), false)) {
      throw new PackValidationError(`Pack manifest field "${field}" must be an https:// URL.`);
    }
  }
  return m;
}

/**
 * Decodes and validates a downloadable dictionary or stroke pack (`.json.gz` or `.json`).
 * Enforces compressed + uncompressed byte caps (§13), optional SHA-256 verification,
 * and strict structural validation.
 */
export function decodePackArchive(
  bytes: Uint8Array,
  opts?: {
    expectedSha256?: string;
    maxCompressedBytes?: number;
    maxUncompressedBytes?: number;
  },
): DecodedPackPayload {
  const root = parseJsonPack(bytes, opts);
  const manifestObj = validateManifestCommon(root['manifest']);
  return decodePackRoot(root, manifestObj);
}

/** Size caps, gunzip, optional SHA-256 check and JSON parse shared by packs and shards. */
function parseJsonPack(
  bytes: Uint8Array,
  opts?: {
    expectedSha256?: string;
    maxCompressedBytes?: number;
    maxUncompressedBytes?: number;
  },
): Record<string, unknown> {
  const maxCompressed = opts?.maxCompressedBytes ?? PACK_SECURITY_LIMITS.maxCompressedBytes;
  const maxUncompressed = opts?.maxUncompressedBytes ?? PACK_SECURITY_LIMITS.maxUncompressedBytes;

  if (bytes.byteLength === 0) {
    throw new PackValidationError('Pack file is empty.');
  }
  if (bytes.byteLength > maxCompressed) {
    throw new PackValidationError(`Pack file exceeds maximum size (${maxCompressed} bytes).`);
  }

  const rawBytes = isGzipMagic(bytes) ? safeGunzipWithCap(bytes, maxUncompressed) : bytes;
  if (rawBytes.byteLength > maxUncompressed) {
    throw new PackValidationError(
      `Pack JSON exceeds maximum uncompressed size (${maxUncompressed} bytes).`,
    );
  }

  if (opts?.expectedSha256) {
    const expected = opts.expectedSha256.trim().toLowerCase();
    const wireHash = sha256Hex(bytes);
    const contentHash = rawBytes === bytes ? wireHash : sha256Hex(rawBytes);
    if (wireHash !== expected && contentHash !== expected) {
      throw new PackValidationError(
        `Pack SHA-256 checksum mismatch (expected ${opts.expectedSha256}, got ${contentHash}).`,
      );
    }
  }

  let parsed: unknown;
  try {
    const text = decodeUtf8(rawBytes);
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PackValidationError(
      `Failed to parse pack JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new PackValidationError('Pack payload must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function decodeDictionaryRoot(
  root: Record<string, unknown>,
  manifestObj: Record<string, unknown>,
): DecodedPackPayload {
  const sharded = manifestObj['format_version'] === SHARDED_PACK_FORMAT_VERSION;
  const rawEntries = checkedEntryArray(root['entries']);
  const entries: RawDictionaryEntry[] = [];
  for (const rawEntry of rawEntries) {
    const entry = decodeDictionaryEntry(rawEntry);
    if (entry) entries.push(entry);
    else if (sharded) {
      // Index rows are matched to shard rows by position, so none may be dropped.
      throw new PackValidationError('Sharded pack index contains an invalid entry.');
    }
  }
  const manifest = manifestObj as unknown as DictionaryPackManifest & { id: DictionaryPackId };
  if (sharded) manifest.sharding = decodeSharding(manifestObj['sharding'], entries.length);
  else delete manifest.sharding;
  return { manifest, entries };
}

function decodeStrokeRoot(
  root: Record<string, unknown>,
  manifestObj: Record<string, unknown>,
): DecodedPackPayload {
  if (manifestObj['script'] !== 'ja' && manifestObj['script'] !== 'zh-Hans') {
    throw new PackValidationError(
      `Stroke pack manifest must declare script "ja" or "zh-Hans", got "${String(manifestObj['script'])}".`,
    );
  }
  const rawChars = root['characters'];
  if (!rawChars || typeof rawChars !== 'object' || Array.isArray(rawChars)) {
    throw new PackValidationError('Stroke pack must contain a "characters" map.');
  }
  const characters: Record<string, { strokes: string[]; medians: number[][][] }> = {};
  let count = 0;
  for (const [ch, data] of Object.entries(rawChars as Record<string, unknown>)) {
    if (!ch || [...ch].length !== 1) continue;
    if (!isValidHanziStrokeData(data)) continue;
    characters[ch] = { strokes: data.strokes, medians: data.medians };
    count++;
    if (count > PACK_SECURITY_LIMITS.maxEntries) {
      throw new PackValidationError('Stroke pack exceeds maximum character cap.');
    }
  }
  return {
    manifest: manifestObj as unknown as StrokePackManifest & { id: StrokePackId },
    characters,
  };
}

function decodePackRoot(
  root: Record<string, unknown>,
  manifestObj: Record<string, unknown>,
): DecodedPackPayload {
  if (manifestObj['kind'] === 'dictionary') return decodeDictionaryRoot(root, manifestObj);
  if (manifestObj['kind'] === 'strokes') return decodeStrokeRoot(root, manifestObj);
  throw new PackValidationError(`Unknown pack kind "${String(manifestObj['kind'])}".`);
}

/**
 * Hydrates raw pack entries into indexed `DictionaryEntry` rows ready for storage.
 * `indices` gives each entry's position in the pack (a shard's entries; default: array order),
 * so a shard's full rows get the ids of the index's stub rows. `stub` marks index rows.
 */
export function materializeDictionaryEntries(
  packId: DictionaryPackId,
  rawEntries: readonly RawDictionaryEntry[],
  opts?: { indices?: readonly number[]; stub?: boolean },
): DictionaryEntry[] {
  return rawEntries.map((entry, i) => {
    const idx = opts?.indices?.[i] ?? i;
    const id = `${packId}:${idx}:${entry.headword}`;
    return {
      ...entry,
      id,
      packId,
      searchTokens: buildEntrySearchTokens(entry),
      browseKeys: buildEntryBrowseKeys({ ...entry, id, packId }),
      ...(opts?.stub ? { stub: true as const } : {}),
    };
  });
}
