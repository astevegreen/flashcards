import { describe, expect, it, vi } from 'vitest';
import {
  createSecureDropboxBridge,
  migrateDropboxRefreshToken,
  type DropboxSocialLoginPort,
} from '../src/auth/dropbox-secure-bridge.ts';
import {
  APP_URL_SCHEME,
  assertNativeOAuthRedirect,
  isAppDeepLink,
  OAUTH_REDIRECT_HOST,
} from '../src/native/deep-links.ts';
import { DEFAULT_DROPBOX_NATIVE_REDIRECT } from '../src/native/dropbox-social-login.ts';
import { DROPBOX_REFRESH_TOKEN_KEY, type SecureStore } from '../src/secure/secure-store.ts';

function fakeSecureStore(): SecureStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
    remove: async (k) => {
      map.delete(k);
    },
  };
}

describe('Dropbox native deep-link redirect', () => {
  it('accepts flashcards://oauth/dropbox and matches the oauth deep-link host', () => {
    expect(assertNativeOAuthRedirect(DEFAULT_DROPBOX_NATIVE_REDIRECT)).toBe(
      'flashcards://oauth/dropbox',
    );
    expect(
      isAppDeepLink(
        'flashcards://oauth/dropbox?code=abc&state=xyz',
        APP_URL_SCHEME,
        OAUTH_REDIRECT_HOST,
      ),
    ).toBe(true);
    expect(() => assertNativeOAuthRedirect('flashcards://oauth/dropbox?code=abc')).toThrow();
  });
});

describe('createSecureDropboxBridge', () => {
  it('moves refresh token to secure store, deletes plugin copy, and refreshes via native HTTP', async () => {
    const secureStore = fakeSecureStore();
    const socialLogin: DropboxSocialLoginPort = {
      login: vi.fn(async () => ({
        accessToken: { token: 'dbx-acc-1', refreshToken: 'dbx-ref-1' },
        expiresIn: 14400,
      })),
      readStoredTokens: vi.fn(async () => null),
      clearStoredTokens: vi.fn(async () => {}),
    };
    const postToken = vi.fn(async () => ({
      status: 200,
      data: { access_token: 'dbx-acc-2', expires_in: 14400 },
    }));

    const bridge = createSecureDropboxBridge({
      appKey: 'app-key',
      socialLogin,
      secureStore,
      postToken,
    });

    const first = await bridge.authorize();
    expect(first).toEqual({ accessToken: 'dbx-acc-1', expiresInSeconds: 14400 });
    expect(secureStore.map.get(DROPBOX_REFRESH_TOKEN_KEY)).toBe('dbx-ref-1');
    expect(socialLogin.clearStoredTokens).toHaveBeenCalledTimes(1);

    const refreshed = await bridge.refresh();
    expect(refreshed).toEqual({ accessToken: 'dbx-acc-2', expiresInSeconds: 14400 });
    expect(postToken).toHaveBeenCalledWith({
      client_id: 'app-key',
      grant_type: 'refresh_token',
      refresh_token: 'dbx-ref-1',
    });

    await bridge.signOut();
    expect(secureStore.map.has(DROPBOX_REFRESH_TOKEN_KEY)).toBe(false);
  });

  it('migrates a legacy plugin refresh token and deletes the plaintext copy', async () => {
    const secureStore = fakeSecureStore();
    const socialLogin: DropboxSocialLoginPort = {
      login: vi.fn(),
      readStoredTokens: vi.fn(async () => ({ refreshToken: 'legacy-ref' })),
      clearStoredTokens: vi.fn(async () => {}),
    };
    expect(await migrateDropboxRefreshToken({ socialLogin, secureStore })).toBe(true);
    expect(secureStore.map.get(DROPBOX_REFRESH_TOKEN_KEY)).toBe('legacy-ref');
    expect(socialLogin.clearStoredTokens).toHaveBeenCalledTimes(1);
  });
});
