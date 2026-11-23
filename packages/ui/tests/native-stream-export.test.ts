import {
  applyEvents,
  createEmptyState,
  createEventFactory,
  createHlcState,
  type CollectionState,
} from '@flash/core';
import { buildSampleDeckEvents, SAMPLE_SEED_EPOCH_MS } from '@flash/core/samples';
import type { FileSink, PlatformServices } from '@flash/platform';
import { describe, expect, it } from 'vitest';
import { exportAnkiApkg } from '../src/export/ankiApkgExport.ts';
import { exportAnkiCsvZip } from '../src/export/ankiExport.ts';

function sampleState(): { state: CollectionState; deckId: string } {
  const factory = createEventFactory('dev', 0, createHlcState('dev', 0));
  const events = buildSampleDeckEvents(factory, SAMPLE_SEED_EPOCH_MS);
  const state = applyEvents(createEmptyState(), events);
  const deckId = [...state.decks.keys()][0] as string;
  return { state, deckId };
}

function fakePlatform(files: Record<string, unknown>): PlatformServices {
  return {
    files,
    storage: { getMedia: async () => undefined },
  } as unknown as PlatformServices;
}

const noDownload = async () => undefined;

describe('native streamed export (UI call site)', () => {
  it('writes chunks to the sink in order, then closes', async () => {
    const { state, deckId } = sampleState();
    const log: string[] = [];
    const chunks: Uint8Array[] = [];
    const sink: FileSink = {
      write: async (c) => {
        chunks.push(c);
        log.push('write');
      },
      close: async () => void log.push('close'),
      abort: async () => void log.push('abort'),
    };
    const downloadFile = async () => {
      throw new Error('fallback must not run');
    };
    const text = await exportAnkiCsvZip(
      fakePlatform({ downloadFile, saveStream: async () => sink }),
      state,
      { deckId },
    );
    expect(text).toMatch(/^Exported /);
    expect(log.at(-1)).toBe('close');
    expect(log.filter((l) => l === 'close')).toHaveLength(1);
    expect(log).not.toContain('abort');
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.length;
    }
    // A zip starts with the local file header signature "PK\x03\x04".
    expect([...joined.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('aborts the sink when a write fails', async () => {
    const { state, deckId } = sampleState();
    let aborted = false;
    const sink: FileSink = {
      write: async () => {
        throw new Error('disk full');
      },
      close: async () => undefined,
      abort: async () => {
        aborted = true;
      },
    };
    await expect(
      exportAnkiCsvZip(
        fakePlatform({ downloadFile: noDownload, saveStream: async () => sink }),
        state,
        { deckId },
      ),
    ).rejects.toThrow('disk full');
    expect(aborted).toBe(true);
  });

  it('stops with a cancelled message when the save dialog is cancelled', async () => {
    const { state, deckId } = sampleState();
    await expect(
      exportAnkiCsvZip(
        fakePlatform({ downloadFile: noDownload, saveStream: async () => null }),
        state,
        { deckId },
      ),
    ).rejects.toThrow('Export cancelled.');
  });

  it('falls back to downloadFile when saveStream is missing', async () => {
    const { state, deckId } = sampleState();
    const saved: Array<{ name: string; size: number }> = [];
    const text = await exportAnkiCsvZip(
      fakePlatform({
        downloadFile: async (name: string, data: Uint8Array) =>
          void saved.push({ name, size: data.length }),
      }),
      state,
      { deckId },
    );
    expect(text).toMatch(/^Exported /);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.size).toBeGreaterThan(0);
  });

  it('prefers downloadBlob over saveStream (web unchanged)', async () => {
    const { state, deckId } = sampleState();
    let blobs = 0;
    await exportAnkiCsvZip(
      fakePlatform({
        downloadFile: noDownload,
        downloadBlob: async () => void blobs++,
        saveStream: async () => {
          throw new Error('must not stream on web');
        },
      }),
      state,
      { deckId },
    );
    expect(blobs).toBe(1);
  });
});

describe('native streamed export: failures and .apkg', () => {
  it('a write error with writes pending: nothing lands after abort, the rest is not zipped', async () => {
    const { state, deckId } = sampleState();
    const events: string[] = [];
    let n = 0;
    const sink: FileSink = {
      write: async () => {
        events.push('write');
        n += 1;
        await new Promise((r) => setTimeout(r, 5));
        if (n === 1) throw new Error('disk full');
      },
      close: async () => void events.push('close'),
      abort: async () => void events.push('abort'),
    };
    const platform = fakePlatform({ downloadFile: noDownload, saveStream: async () => sink });
    await expect(exportAnkiCsvZip(platform, state, { deckId })).rejects.toThrow('disk full');
    expect(events.at(-1)).toBe('abort');
    expect(events).not.toContain('close');
    expect(events.filter((e) => e === 'abort')).toHaveLength(1);
  });

  it('streams the .apkg path and aborts on a write error', async () => {
    const { state, deckId } = sampleState();
    const chunks: Uint8Array[] = [];
    const log: string[] = [];
    let fail = false;
    const sink: FileSink = {
      write: async (c) => {
        if (fail) throw new Error('disk full');
        chunks.push(c);
      },
      close: async () => void log.push('close'),
      abort: async () => void log.push('abort'),
    };
    const platform = {
      files: { downloadFile: noDownload, saveStream: async () => sink },
      storage: { getMedia: async () => undefined },
      getAnkiPackageReader: async () => ({
        writeCollection: async () => new TextEncoder().encode('sqlite'),
      }),
    } as unknown as PlatformServices;
    const text = await exportAnkiApkg(platform, state, { deckIds: [deckId] });
    expect(text).toMatch(/^Exported /);
    expect(log).toEqual(['close']);
    expect([...(chunks[0] ?? []).subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    fail = true;
    await expect(exportAnkiApkg(platform, state, { deckIds: [deckId] })).rejects.toThrow(
      'disk full',
    );
    expect(log).toEqual(['close', 'abort']);
  });
});

describe('native streamed backup file', () => {
  it('streams Export Backup to the sink in chunks and it reads back as a backup', async () => {
    const { saveFullBackupFile } = await import('../src/backups/backupRunner.ts');
    const { readBackupArchive } = await import('@flash/core/backup');
    const { state } = sampleState();
    const chunks: Uint8Array[] = [];
    const log: string[] = [];
    const sink: FileSink = {
      write: async (c) => void chunks.push(c.slice()),
      close: async () => void log.push('close'),
      abort: async () => void log.push('abort'),
    };
    const downloadFile = async () => {
      throw new Error('fallback must not run');
    };
    const name = await saveFullBackupFile(
      fakePlatform({ downloadFile, saveStream: async () => sink }),
      state,
      { deviceId: 'dev-a' },
    );
    expect(name).toMatch(/^flashcards-backup-\d{4}-\d{2}-\d{2}\.flashpkg$/);
    expect(log).toEqual(['close']);
    expect(chunks.length).toBeGreaterThan(1);
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.length;
    }
    const read = readBackupArchive(joined);
    expect(read.state.notes.size).toBe(state.notes.size);
  });

  it('a cancelled save dialog throws ExportCancelledError', async () => {
    const { saveFullBackupFile } = await import('../src/backups/backupRunner.ts');
    const { isExportCancelled } = await import('../src/export/saveStreamedZip.ts');
    const { state } = sampleState();
    const err = await saveFullBackupFile(
      fakePlatform({ downloadFile: noDownload, saveStream: async () => null }),
      state,
      { deviceId: 'dev-a' },
    ).catch((e: unknown) => e);
    expect(isExportCancelled(err)).toBe(true);
  });

  it('saveBytes slices a finished array for a native sink; web keeps downloadFile', async () => {
    const { saveBytes } = await import('../src/export/saveStreamedZip.ts');
    const bytes = new Uint8Array(1_200_000).map((_, i) => i & 0xff);
    const sizes: number[] = [];
    const sink: FileSink = {
      write: async (c) => void sizes.push(c.length),
      close: async () => undefined,
      abort: async () => undefined,
    };
    await saveBytes(
      fakePlatform({ downloadFile: noDownload, saveStream: async () => sink }),
      'b.flashpkg',
      bytes,
      'application/zip',
    );
    expect(sizes).toEqual([524_288, 524_288, 151_424]);
    const saved: number[] = [];
    await saveBytes(
      fakePlatform({
        downloadFile: async (_n: string, d: Uint8Array) => void saved.push(d.length),
        downloadBlob: async () => {
          throw new Error('not for finished arrays');
        },
        saveStream: async () => {
          throw new Error('must not stream on web');
        },
      }),
      'b.flashpkg',
      bytes,
      'application/zip',
    );
    expect(saved).toEqual([1_200_000]);
  });
});
