import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshTokenStore } from '../src/auth/refresh-token-store.ts';

const plugin = vi.hoisted(() => ({
  urlListener: undefined as ((url: string) => void) | undefined,
  tokenResponse: {} as Record<string, unknown>,
}));

vi.mock('@fabianlars/tauri-plugin-oauth', () => ({
  start: vi.fn(async () => 51234),
  cancel: vi.fn(async () => undefined),
  onUrl: vi.fn(async (cb: (url: string) => void) => {
    plugin.urlListener = cb;
    return () => undefined;
  }),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  // The "browser" answers at once: the loopback listener receives the code and the same state.
  openUrl: vi.fn(async (url: string) => {
    const state = new URL(url).searchParams.get('state') ?? '';
    queueMicrotask(() => plugin.urlListener?.(`http://localhost:51234/?code=c1&state=${state}`));
  }),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => new Response(JSON.stringify(plugin.tokenResponse), { status: 200 })),
}));

const { createMicrosoftLoopbackBridge } = await import('../src/native/microsoft-loopback.ts');

function memoryStore(initial?: string): RefreshTokenStore & { value: string | undefined } {
  const store = {
    value: initial,
    get: async () => store.value,
    set: async (token: string) => {
      store.value = token;
    },
    delete: async () => {
      store.value = undefined;
    },
  };
  return store;
}

describe('Tauri Microsoft loopback sign-in: refresh token handling', () => {
  beforeEach(() => {
    plugin.urlListener = undefined;
  });

  it('stores the refresh token a sign-in returns', async () => {
    const tokenStore = memoryStore('old');
    plugin.tokenResponse = { access_token: 'a1', expires_in: 3600, refresh_token: 'new' };
    const bridge = createMicrosoftLoopbackBridge({ clientId: 'c', tokenStore });
    await expect(bridge.authorize(['offline_access'])).resolves.toEqual({
      accessToken: 'a1',
      expiresInSeconds: 3600,
    });
    expect(tokenStore.value).toBe('new');
  });

  it('a sign-in without a refresh token forgets the old one (it may be another account)', async () => {
    const tokenStore = memoryStore('old-account');
    plugin.tokenResponse = { access_token: 'a1', expires_in: 3600 };
    const bridge = createMicrosoftLoopbackBridge({ clientId: 'c', tokenStore });
    await bridge.authorize(['offline_access']);
    expect(tokenStore.value).toBeUndefined();
  });

  it('a refresh that rotates nothing keeps the current token', async () => {
    const tokenStore = memoryStore('current');
    plugin.tokenResponse = { access_token: 'a2', expires_in: 3600 };
    const bridge = createMicrosoftLoopbackBridge({ clientId: 'c', tokenStore });
    await bridge.refresh(['offline_access']);
    expect(tokenStore.value).toBe('current');
  });
});
