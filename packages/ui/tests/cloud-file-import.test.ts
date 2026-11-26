import { describe, expect, it, vi } from 'vitest';
import {
  applyEvents,
  BUILTIN_NOTE_TYPE_IDS,
  createEmptyState,
  createEventFactory,
  createHlcState,
  deriveNoteId,
  encodeUtf8,
  type KnownEvent,
} from '../../core/src/index.ts';
import { exportFlashpkg } from '@flash/core/flashpkg';
import { createFreeTierEntitlement } from '../../core/src/license/index.ts';
import type { PlatformServices } from '../../platform/src/index.ts';
import { gridToCsv, importPickedCloudFile, readXlsxGrid } from '../src/sources/cloudFileImport.ts';

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
    await expect(importPickedCloudFile(picked as never, ctx, 'OneDrive')).rejects.toThrow(
      /no notes/,
    );
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
    await expect(importPickedCloudFile(picked as never, ctx, 'OneDrive')).rejects.toThrow(
      /Excel files can't be read on this device/,
    );
    expect(parseXlsxBytes).not.toHaveBeenCalled();
    expect(createDeck).not.toHaveBeenCalled();
  });
});

describe('readXlsxGrid, shared by cloud imports and Bring my cards (C21)', () => {
  it('refuses before parsing on a device without an Excel reader, else parses', async () => {
    const parseXlsxBytes = vi.fn(async () => [['Word'], ['나무']]);
    const platform = (canParse: boolean) =>
      ({
        getLocalFolderSources: async () => ({ canParseXlsx: () => canParse, parseXlsxBytes }),
      }) as unknown as PlatformServices;
    await expect(readXlsxGrid(platform(false), 'deck.xlsx', new Uint8Array([1]))).rejects.toThrow(
      /Excel files can't be read on this device/,
    );
    expect(parseXlsxBytes).not.toHaveBeenCalled();
    expect(await readXlsxGrid(platform(true), 'deck.xlsx', new Uint8Array([1]))).toEqual([
      ['Word'],
      ['나무'],
    ]);
  });
});

describe('gridToCsv (every .xlsx import goes through it)', () => {
  it('trims every cell, so a cell with a comma is trimmed like any other', () => {
    expect(
      gridToCsv([
        [' Word ', ' a, b '],
        [' x ', 'y '],
      ]),
    ).toBe(['Word,"a, b"', 'x,y'].join('\n'));
  });
});

describe('importPickedCloudFile (merged OneDrive/Dropbox import, R5)', () => {
  function freeTier(ctx: ReturnType<typeof context>['ctx']) {
    ctx.entitlement = createFreeTierEntitlement();
  }

  function addDecks(state: ReturnType<typeof context>['ctx']['state'], count: number) {
    const factory = createEventFactory('dev-x', 0, createHlcState('dev-x', 1));
    for (let i = 0; i < count; i += 1) {
      applyEvents(state, [
        factory.create(
          'DeckCreated',
          {
            deck_id: `existing-${i}`,
            name: `Existing ${i}`,
            note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
            language: 'ko',
            created_at: 1,
          },
          1,
        ),
      ]);
    }
  }

  function flashpkg(): Uint8Array {
    const st = createEmptyState();
    const factory = createEventFactory('pkg', 0, createHlcState('pkg', 1000));
    applyEvents(st, [
      factory.create(
        'DeckCreated',
        {
          deck_id: 'pkg-deck',
          name: 'Pack',
          note_type_id: BUILTIN_NOTE_TYPE_IDS.VOCAB_KO,
          language: 'ko',
          created_at: 1000,
        },
        1000,
      ),
      factory.create(
        'NoteUpserted',
        {
          note_id: deriveNoteId('pkg-deck', '나무'),
          deck_id: 'pkg-deck',
          source_key: '나무',
          fields: { word: '나무', meaning: 'tree' },
          tags: [],
          provenance: { source: 'import', reviewed: true },
          created_order: 0,
        },
        1001,
      ),
    ]);
    return exportFlashpkg(st, { packageId: 'pkg:pack', name: 'Pack', version: '1.0.0' });
  }

  it('turns a Dropbox .csv into a new deck named after the file, and names the drive', async () => {
    const { ctx, createDeck, emitted } = context();
    const picked = {
      name: 'Lesson 1.csv',
      bytes: encodeUtf8('word,meaning\n나무,tree\n강,river\n'),
    };
    const message = await importPickedCloudFile(picked as never, ctx, 'Dropbox');
    expect(createDeck).toHaveBeenCalledWith('Lesson 1', ctx.noteTypeId, 'ko');
    expect(emitted.filter((e) => e.type === 'NoteUpserted')).toHaveLength(2);
    expect(message).toMatch(/from Dropbox into "Lesson 1"/);
  });

  it('reads a .tsv with tabs', async () => {
    const { ctx, emitted } = context();
    const picked = { name: 'words.tsv', bytes: encodeUtf8('word\tmeaning\n달\tmoon\n') };
    await importPickedCloudFile(picked as never, ctx, 'OneDrive');
    expect(emitted.filter((e) => e.type === 'NoteUpserted')).toHaveLength(1);
  });

  it('refuses a spreadsheet past the free-tier deck limit before creating a deck', async () => {
    const { ctx, createDeck, emitted } = context();
    freeTier(ctx);
    addDecks(ctx.state, 2);
    const picked = { name: 'more.csv', bytes: encodeUtf8('word,meaning\n달,moon\n') };
    await expect(importPickedCloudFile(picked as never, ctx, 'Dropbox')).rejects.toThrow(
      /Free tier/,
    );
    expect(createDeck).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('imports a .flashpkg, and refuses one that would pass the free-tier deck limit', async () => {
    const ok = context();
    const message = await importPickedCloudFile(
      { name: 'pack.flashpkg', bytes: flashpkg() } as never,
      ok.ctx,
      'Dropbox',
    );
    expect(message).toMatch(/Imported "Pack" from Dropbox \(1 deck\(s\), 1 note\(s\)/);
    expect(ok.emitted.some((e) => e.type === 'DeckCreated')).toBe(true);

    const full = context();
    freeTier(full.ctx);
    addDecks(full.ctx.state, 2);
    await expect(
      importPickedCloudFile(
        { name: 'pack.flashpkg', bytes: flashpkg() } as never,
        full.ctx,
        'Dropbox',
      ),
    ).rejects.toThrow(/Free tier/);
    expect(full.emitted).toEqual([]);
  });

  it('rejects other file types', async () => {
    const { ctx } = context();
    await expect(
      importPickedCloudFile(
        { name: 'notes.docx', bytes: new Uint8Array() } as never,
        ctx,
        'Dropbox',
      ),
    ).rejects.toThrow(/is not a \.csv, \.tsv, \.xlsx or \.flashpkg file/);
  });
});
