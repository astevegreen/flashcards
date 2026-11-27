import { createEmptyState } from '@flash/core';
import type { EntitlementState, PlatformServices } from '@flash/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLaunchSourceCheck } from '../src/sources/launchSourceCheck.ts';

const refreshAllSources = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/sources/sourceRunner.ts', () => ({ refreshAllSources }));

const entitlement = { unlocked: true } as EntitlementState;

function context(saved: unknown, getKv = vi.fn(async () => saved)) {
  const platform = { storage: { getKv } } as unknown as PlatformServices;
  return {
    platform,
    getState: () => createEmptyState(),
    getEventFactory: vi.fn(),
    emitEvents: vi.fn(),
    refreshEntitlement: vi.fn(async () => entitlement),
  };
}

afterEach(() => refreshAllSources.mockClear());

describe('runLaunchSourceCheck (launch, after first paint)', () => {
  it('does not load the source runner when no source is linked', async () => {
    const ctx = context(undefined);
    await runLaunchSourceCheck(ctx);
    expect(refreshAllSources).not.toHaveBeenCalled();
    expect(ctx.refreshEntitlement).not.toHaveBeenCalled();
  });

  it('refreshes linked sources quietly, without asking for folder permission', async () => {
    const ctx = context({ googleSources: [{ id: 's1' }] });
    await runLaunchSourceCheck(ctx);
    expect(refreshAllSources).toHaveBeenCalledTimes(1);
    expect(refreshAllSources).toHaveBeenCalledWith(
      expect.objectContaining({ platform: ctx.platform, entitlement }),
      { requestFolderPermission: false },
    );
  });

  it('swallows a failure (the Sources panel shows the details)', async () => {
    const ctx = context(
      undefined,
      vi.fn(async () => {
        throw new Error('blocked');
      }),
    );
    await expect(runLaunchSourceCheck(ctx)).resolves.toBeUndefined();
    expect(refreshAllSources).not.toHaveBeenCalled();
  });
});
