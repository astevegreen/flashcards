import { afterEach, describe, expect, it, vi } from 'vitest';
import { FREE_PAGES_SCRUBBED_KV_KEY, scrubFreePagesOnce } from '../src/storage/scrub-once.ts';
import { TauriSqliteStorage } from '../src/index.ts';
import { memoryTauriDb } from './support/memory-tauri-db.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('desktop free-page scrub (N9)', () => {
  it('runs VACUUM once per database, then never again', async () => {
    const storage = new TauriSqliteStorage(memoryTauriDb());
    const vacuum = vi.fn(async () => undefined);
    await scrubFreePagesOnce({ storage, vacuum, nowMs: () => 42 });
    await scrubFreePagesOnce({ storage, vacuum, nowMs: () => 43 });
    expect(vacuum).toHaveBeenCalledTimes(1);
    expect(await storage.getKv(FREE_PAGES_SCRUBBED_KV_KEY)).toEqual({ at: 42 });
  });

  it('a failed VACUUM is logged and retried at the next launch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = new TauriSqliteStorage(memoryTauriDb());
    const vacuum = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue(undefined);
    await scrubFreePagesOnce({ storage, vacuum });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await storage.getKv(FREE_PAGES_SCRUBBED_KV_KEY)).toBeUndefined();
    await scrubFreePagesOnce({ storage, vacuum });
    expect(vacuum).toHaveBeenCalledTimes(2);
    expect(await storage.getKv(FREE_PAGES_SCRUBBED_KV_KEY)).toBeDefined();
  });
});
