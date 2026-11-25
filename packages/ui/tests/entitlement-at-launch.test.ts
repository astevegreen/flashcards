import type { Purchase } from '@flash/platform';
import { describe, expect, it, vi } from 'vitest';
import { refreshThenRecheckStore } from '../src/state/entitlementAtLaunch.ts';

function purchaseWith(recheckStore?: () => Promise<unknown>): Purchase {
  return { ...(recheckStore ? { recheckStore } : {}) } as unknown as Purchase;
}

describe('launch: the cached entitlement first, then the store again (S8)', () => {
  it('shows the cached entitlement, asks the store, then shows its answer', async () => {
    const calls: string[] = [];
    const refresh = vi.fn(async () => {
      calls.push('refresh');
    });
    const recheck = vi.fn(async () => {
      calls.push('recheck');
    });
    await refreshThenRecheckStore(async () => purchaseWith(recheck), refresh);
    expect(calls).toEqual(['refresh', 'recheck', 'refresh']);
  });

  it('a build with no store (web, desktop) only reads the cache', async () => {
    const refresh = vi.fn(async () => undefined);
    await refreshThenRecheckStore(async () => purchaseWith(), refresh);
    await refreshThenRecheckStore(undefined, refresh);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a store check that throws keeps what the cache said', async () => {
    const refresh = vi.fn(async () => undefined);
    await expect(
      refreshThenRecheckStore(
        async () =>
          purchaseWith(async () => {
            throw new Error('offline');
          }),
        refresh,
      ),
    ).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
