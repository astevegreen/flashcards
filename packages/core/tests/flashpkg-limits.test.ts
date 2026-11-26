import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createEventFactory, replayAllEvents, type CollectionState } from '../src/events/replay.ts';
import { createHlcState } from '../src/hlc.ts';
import { FLASH_NAMESPACE_UUID, uuidv5 } from '../src/ids.ts';
import { exportFlashpkg, FlashpkgSecurityError, importFlashpkg } from '../src/import/flashpkg.ts';
import type { ArchiveLimits } from '../src/import/safe-unzip.ts';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '../src/samples/decks.ts';
import { sha256Hex } from '../src/sources/hash.ts';

// §9: the `.flashpkg` caps were only tested through the Anki importer. These run the real
// `.flashpkg` path with tightened limits, on a real export.
const KO = uuidv5(FLASH_NAMESPACE_UUID, 'sample-ko-vocab');

function sampleState(device: string): CollectionState {
  const factory = createEventFactory(device, 0, createHlcState(device, SAMPLE_SEED_EPOCH_MS));
  return replayAllEvents(buildSampleDeckEvents(factory));
}

/** A friend's export of the Korean sample deck, with extra archive entries added. */
function packageWith(extra: Record<string, Uint8Array> = {}): Uint8Array {
  const files = unzipSync(
    exportFlashpkg(sampleState('dev-friend'), { deckId: KO, packageId: 'pkg:x' }),
  );
  return zipSync({ ...files, ...extra });
}

function importInto(bytes: Uint8Array, limits: Partial<ArchiveLimits> = {}) {
  const factory = createEventFactory('dev-me', 0, createHlcState('dev-me', SAMPLE_SEED_EPOCH_MS));
  return importFlashpkg(bytes, sampleState('dev-me'), factory, {
    nowMs: SAMPLE_SEED_EPOCH_MS + 60_000,
    limits,
  });
}

const clip = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);

describe('.flashpkg archive limits (§13, §9)', () => {
  it('imports the unmodified package within the default limits', () => {
    const result = importInto(packageWith({ [`media/${sha256Hex(clip)}.mp3`]: clip }));
    expect(result.decksImported + result.upgradedDecks).toBeGreaterThan(0);
    expect(result.extractedMedia.map((m) => m.hash)).toEqual([sha256Hex(clip)]);
  });

  it('rejects an archive with more files than the file-count cap', () => {
    const fileCount = Object.keys(unzipSync(packageWith())).length;
    const bytes = packageWith();
    expect(() => importInto(bytes, { maxFiles: fileCount })).not.toThrow();
    expect(() => importInto(bytes, { maxFiles: fileCount - 1 })).toThrow(/maximum file count/);
    expect(() => importInto(bytes, { maxFiles: fileCount - 1 })).toThrow(FlashpkgSecurityError);
  });

  it('rejects one file over the single-file cap even when the total is under its cap', () => {
    const big = new Uint8Array(20_000).fill(7);
    const bytes = packageWith({ [`media/${sha256Hex(big)}.mp3`]: big });
    expect(() =>
      importInto(bytes, { maxSingleFileBytes: 10_000, maxTotalUncompressedBytes: 10_000_000 }),
    ).toThrow(/single-file size/);
  });

  it('rejects an archive over the compressed-size cap before unzipping it', () => {
    const bytes = packageWith();
    expect(() => importInto(bytes, { maxCompressedBytes: bytes.byteLength - 1 })).toThrow(
      /max compressed size/,
    );
    expect(() => importInto(bytes, { maxCompressedBytes: bytes.byteLength })).not.toThrow();
  });

  it('rejects a media file whose bytes do not match the hash in its name', () => {
    const wrongName = `media/${sha256Hex(new Uint8Array([1, 2, 3]))}.mp3`;
    expect(() => importInto(packageWith({ [wrongName]: clip }))).toThrow(/Media hash mismatch/);
    expect(() => importInto(packageWith({ [wrongName]: clip }))).toThrow(FlashpkgSecurityError);
  });
});
