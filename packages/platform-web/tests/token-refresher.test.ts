import { isSyncTransportError } from '@flash/core';
import { describe, expect, it, vi } from 'vitest';
import {
  reconnectRequiredTokens,
  requireAccessToken,
  TokenRefresher,
  type RefreshableTokens,
} from '../src/auth/token-refresher.ts';

const NOW = 1_000_000;

function setup(stored: RefreshableTokens | undefined, extra: { unexpired?: boolean } = {}) {
  let resolveRefresh: (token: string) => void = () => {};
  const refresh = vi.fn(
    (_tokens: RefreshableTokens, _forced: boolean) =>
      new Promise<string>((resolve) => {
        resolveRefresh = resolve;
      }),
  );
  const refresher = new TokenRefresher({
    label: 'Box',
    marginMs: 60_000,
    nowMs: () => NOW,
    read: async () => stored,
    refresh,
    cannotRefreshMessage: 'Box needs a reconnect.',
    ...(extra.unexpired ? { useUnexpiredWhenUnrefreshable: true } : {}),
  });
  return { refresher, refresh, finish: (t: string) => resolveRefresh(t) };
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e: unknown) => (isSyncTransportError(e) ? e.code : 'other'),
  );
}

const fresh: RefreshableTokens = { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 600_000 };
const stale: RefreshableTokens = { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 1_000 };

describe('TokenRefresher (R2)', () => {
  it('returns a fresh token without refreshing', async () => {
    const { refresher, refresh } = setup(fresh);
    await expect(refresher.getValidAccessToken()).resolves.toBe('a');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shares one refresh between concurrent callers', async () => {
    const { refresher, refresh, finish } = setup(stale);
    const a = refresher.getValidAccessToken();
    const b = refresher.getValidAccessToken({ forceRefresh: true });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    finish('new');
    await expect(Promise.all([a, b])).resolves.toEqual(['new', 'new']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes a fresh token when forced (after a 401)', async () => {
    const { refresher, refresh, finish } = setup(fresh);
    const p = refresher.getValidAccessToken({ forceRefresh: true });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith(fresh, true));
    finish('b');
    await expect(p).resolves.toBe('b');
  });

  it('is AUTH_REQUIRED when not connected, after a revoked refresh, or without a refresh token', async () => {
    expect(await codeOf(setup(undefined).refresher.getValidAccessToken())).toBe('AUTH_REQUIRED');
    const revoked = reconnectRequiredTokens(fresh);
    expect(revoked).toMatchObject({ accessToken: '', expiresAt: 0, reconnectRequired: true });
    expect(await codeOf(setup(revoked).refresher.getValidAccessToken())).toBe('AUTH_REQUIRED');
    const noRefresh = { ...stale, refreshToken: null };
    expect(await codeOf(setup(noRefresh).refresher.getValidAccessToken())).toBe('AUTH_REQUIRED');
  });

  it('can keep an unexpired token when it cannot refresh, unless forced', async () => {
    const { refresher } = setup({ ...stale, refreshToken: null }, { unexpired: true });
    await expect(refresher.getValidAccessToken()).resolves.toBe('a');
    expect(await codeOf(refresher.getValidAccessToken({ forceRefresh: true }))).toBe(
      'AUTH_REQUIRED',
    );
  });

  it('rejects a token reply without access_token', () => {
    expect(requireAccessToken({ access_token: 'x' }, 'Box')).toBe('x');
    expect(() => requireAccessToken({ access_token: '' }, 'Box')).toThrow(/missing access_token/);
    expect(() => requireAccessToken({}, 'Box')).toThrow(/missing access_token/);
  });
});
