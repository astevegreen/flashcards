import 'fake-indexeddb/auto';
import { isSyncTransportError } from '@flash/core';
import Dexie from 'dexie';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropboxOAuthWebAuth, type StoredDropboxTokens } from '../src/auth/dropbox-oauth-web.ts';
import type { GoogleOAuthWindowLike } from '../src/auth/google-oauth-web.ts';
import { DexieStorage } from '../src/storage/dexie-storage.ts';

const createdDbs: string[] = [];

function createStorage(name: string): DexieStorage {
  const s = new DexieStorage(`dbx-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  createdDbs.push(s.dbName);
  return s;
}

function createMockWindow(initialUrl: string): { win: GoogleOAuthWindowLike; assigned: string[] } {
  const parsed = new URL(initialUrl);
  const assigned: string[] = [];
  const win: GoogleOAuthWindowLike = {
    location: {
      origin: parsed.origin,
      pathname: parsed.pathname,
      search: parsed.search,
      assign(url: string) {
        assigned.push(url);
      },
    },
    history: {
      replaceState(_d: unknown, _u: string, url?: string | URL | null) {
        if (url) win.location.search = new URL(String(url)).search;
      },
    },
    crypto: webcrypto as unknown as GoogleOAuthWindowLike['crypto'],
    document: { title: 'Flashcards' },
  };
  return { win, assigned };
}

afterEach(async () => {
  while (createdDbs.length > 0) {
    const db = createdDbs.pop();
    if (db) await Dexie.delete(db);
  }
});

describe('DropboxOAuthWebAuth (PKCE, no Worker)', () => {
  it('redirects with PKCE, ignores foreign callbacks, exchanges code directly and refreshes', async () => {
    const storage = createStorage('flow');
    const { win, assigned } = createMockWindow('https://app.example.com/?device=a');
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      bodies.push(body);
      if (body.includes('grant_type=authorization_code')) {
        return new Response(
          JSON.stringify({ access_token: 'dbx-acc', refresh_token: 'dbx-ref', expires_in: 14400 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ access_token: 'dbx-acc-2', expires_in: 14400 }), {
        status: 200,
      });
    });
    let clock = 1_750_000_000_000;
    const auth = new DropboxOAuthWebAuth({
      appKey: 'app-key',
      storage,
      fetchImpl,
      windowImpl: win,
      nowMs: () => clock,
    });

    await auth.signIn();
    const authUrl = new URL(assigned[0] ?? '');
    expect(authUrl.hostname).toBe('www.dropbox.com');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('token_access_type')).toBe('offline');
    const state = authUrl.searchParams.get('state') ?? '';

    // A Google callback (different state) is left alone for Google to handle
    win.location.search = '?code=google-code&state=google-state';
    expect(await auth.handleRedirectCallback()).toBeNull();
    expect(win.location.search).toContain('google-code');

    win.location.search = `?device=a&code=dbx-code&state=${encodeURIComponent(state)}`;
    const session = await auth.handleRedirectCallback();
    expect(session?.provider).toBe('dropbox');
    expect(win.location.search).toBe('?device=a');
    expect(bodies[0]).toContain('code_verifier=');
    expect(bodies[0]).toContain('client_id=app-key');
    expect(bodies[0]).not.toContain('client_secret');
    expect(await auth.getValidAccessToken()).toBe('dbx-acc');

    clock += 4 * 60 * 60 * 1000; // expired -> direct refresh with the stored refresh token
    expect(await auth.getValidAccessToken()).toBe('dbx-acc-2');
    expect(bodies[1]).toContain('grant_type=refresh_token');
    expect(bodies[1]).toContain('refresh_token=dbx-ref');
    storage.close();
  });

  it('marks reconnect required when the refresh token is revoked', async () => {
    const storage = createStorage('revoked');
    const now = 1_750_000_000_000;
    await storage.setKv('dropbox_oauth_tokens', {
      accessToken: 'old',
      refreshToken: 'revoked',
      expiresAt: now - 1,
    } satisfies StoredDropboxTokens);
    const auth = new DropboxOAuthWebAuth({
      appKey: 'app-key',
      storage,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      ),
      nowMs: () => now,
    });
    await expect(auth.getValidAccessToken()).rejects.toSatisfy(
      (err: unknown) => isSyncTransportError(err) && err.code === 'AUTH_REQUIRED',
    );
    expect(await auth.isConnected()).toBe(false);
    storage.close();
  });
});

describe('Dropbox PKCE record expiry (S13)', () => {
  it('refuses a callback whose PKCE record is older than PKCE_MAX_AGE_MS', async () => {
    const storage = createStorage('expiry');
    const { win, assigned } = createMockWindow('https://app.example.com/');
    let clock = 1_750_000_000_000;
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const auth = new DropboxOAuthWebAuth({
      appKey: 'app-key',
      storage,
      fetchImpl,
      windowImpl: win,
      nowMs: () => clock,
    });
    await auth.signIn();
    const state = new URL(assigned[0] ?? '').searchParams.get('state') ?? '';
    clock += 31 * 60_000;
    win.location.search = `?code=dbx-code&state=${encodeURIComponent(state)}`;
    await expect(auth.handleRedirectCallback()).rejects.toThrow(/took too long/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(win.location.search).toBe('');
    storage.close();
  });
});
