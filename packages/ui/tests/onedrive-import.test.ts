import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyState,
  createEventFactory,
  createHlcState,
  encodeUtf8,
  type KnownEvent,
} from '../../core/src/index.ts';
import type { PlatformServices } from '../../platform/src/index.ts';
import { importPickedOneDriveFile } from '../src/sources/oneDriveImport.ts';

function context() {
  const state = createEmptyState();
  const noteTypeId = [...state.noteTypes.keys()][0] ?? '';
  const emitted: KnownEvent[] = [];
  const createDeck = vi.fn((_name: string, _noteTypeId: string, _language: string) => 'deck-1');
  return {
    emitted,
    createDeck,
    ctx: {
      platform: {} as PlatformServices,
      state,
      entitlement: { personalBuild: true, unlocked: false } as never,
      getEventFactory: () => createEventFactory('dev-od', 0, createHlcState('dev-od', 1)),
      emitEvents: (events: readonly KnownEvent[]) => emitted.push(...events),
      createDeck,
      noteTypeId,
      language: 'ko',
    },
  };
}

describe('OneDrive picked-file import', () => {
  it('creates no deck when a spreadsheet holds no notes', async () => {
    const { ctx, createDeck, emitted } = context();
    expect(ctx.noteTypeId).not.toBe('');
    const picked = { name: 'empty.csv', bytes: encodeUtf8(''), mime: 'text/csv' };
    await expect(importPickedOneDriveFile(picked as never, ctx)).rejects.toThrow(/no notes/);
    expect(createDeck).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
});

describe('cloud one-shot .xlsx import on a device without an Excel reader (C21)', () => {
  it('says so before parsing, like a linked Dropbox or OneDrive file does', async () => {
    const { ctx, createDeck } = context();
    const parseXlsxBytes = vi.fn(async () => [['Word'], ['나무']]);
    ctx.platform = {
      getLocalFolderSources: async () => ({ canParseXlsx: () => false, parseXlsxBytes }),
    } as unknown as PlatformServices;
    const picked = { name: 'deck.xlsx', bytes: new Uint8Array([1]), mime: 'application/zip' };
    await expect(importPickedOneDriveFile(picked as never, ctx)).rejects.toThrow(
      /Excel files can't be read on this device/,
    );
    expect(parseXlsxBytes).not.toHaveBeenCalled();
    expect(createDeck).not.toHaveBeenCalled();
  });
});
