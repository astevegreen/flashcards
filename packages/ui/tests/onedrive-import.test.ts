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
