import 'fake-indexeddb/auto';
import { isSyncTransportError } from '@flash/core';
import Dexie from 'dexie';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleOAuthWebAuth,
  type GoogleOAuthWindowLike,
  type StoredOAuthTokens,
} from '../src/auth/google-oauth-web.ts';
import { DexieStorage } from '../src/storage/dexie-storage.ts';

const createdDbs: string[] = [];

function createStorage(name: string): DexieStorage {
  const s = new DexieStorage(
    `oauth-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  createdDbs.push(s.dbName);
  return s;
}

function createMockWindow(initialUrl = 'https://app.example.com/?device=a'): {
  win: GoogleOAuthWindowLike;
  assignedUrls: string[];
  replacedUrls: string[];
  setSearch: (search: string) => void;
} {
  const parsed = new URL(initialUrl);
  const assignedUrls: string[] = [];
  const replacedUrls: string[] = [];
  const win: GoogleOAuthWindowLike = {
    location: {
      origin: parsed.origin,
      pathname: parsed.pathname,
      search: parsed.search,
      assign(url: string) {
        assignedUrls.push(url);
      },
    },
    history: {
      replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
        if (url) {
          replacedUrls.push(String(url));
          const next = new URL(String(url), parsed.origin);
          win.location.pathname = next.pathname;
          win.location.search = next.search;
        }
      },
    },
    crypto: webcrypto as unknown as GoogleOAuthWindowLike['crypto'],
    document: { title: 'Flashcards' },
  };
  return {
    win,
    assignedUrls,
    replacedUrls,
    setSearch: (s: string) => {
      win.location.search = s;
    },
  };
}

afterEach(async () => {
  while (createdDbs.length > 0) {
    const db = createdDbs.pop();
    if (db) await Dexie.delete(db);
  }
});

describe('GoogleOAuthWebAuth unit tests', () => {
  it('generates PKCE S256 redirect, verifies CSRF state, exchanges code via Worker, and persists refresh_token in IndexedDB', async () => {
    const storage = createStorage('pkce');
    const { win, assignedUrls, replacedUrls, setSearch } = createMockWindow(
      'https://app.example.com/?device=a',
    );
    let now = 1_750_000_000_000;

    const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://token-helper.example.workers.dev/auth/exchange');
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body['code']).toBe('auth-code-123');
      expect(body['redirect_uri']).toBe('https://app.example.com/');
      expect(body['code_verifier']?.length).toBeGreaterThan(20);
      return new Response(
        JSON.stringify({
          access_token: 'acc-1',
          refresh_token: 'ref-1',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive.appdata',
        }),
        { status: 200 },
      );
    });

    const auth = new GoogleOAuthWebAuth({
      clientId: 'client-123.apps.googleusercontent.com',
      tokenHelperUrl: 'https://token-helper.example.workers.dev/',
      storage,
      fetchImpl: mockFetch,
      windowImpl: win,
      nowMs: () => now,
    });

    expect(auth.isConfigured()).toBe(true);
    await auth.signIn();
    expect(assignedUrls).toHaveLength(1);
    const firstAssigned = assignedUrls[0];
    if (!firstAssigned) throw new Error('Expected redirect URL');

    const authUrl = new URL(firstAssigned);
    expect(authUrl.origin).toBe('https://accounts.google.com');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('prompt')).toBe('consent');
    expect(authUrl.searchParams.get('scope')).toContain('drive.appdata');
    const state = authUrl.searchParams.get('state') ?? '';
    expect(state).toBeTruthy();

    // Simulate redirect callback from Google
    setSearch(`?code=auth-code-123&state=${encodeURIComponent(state)}&scope=drive.appdata`);
    const session = await auth.handleRedirectCallback();
    expect(session?.accessToken).toBe('acc-1');
    expect(await auth.isConnected()).toBe(true);
    // Clean URL restores original `?device=a` and strips OAuth params
    expect(replacedUrls[0]).toBe('https://app.example.com/?device=a');
    expect(await storage.getKv('oauth_pkce')).toBeUndefined();

    const stored = await storage.getKv<StoredOAuthTokens>('oauth_tokens');
    expect(stored?.refreshToken).toBe('ref-1');

    // Valid token returned without calling refresh when > 5 min remain
    now += 10 * 60 * 1000;
    expect(await auth.getValidAccessToken()).toBe('acc-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    storage.close();
  });

  it('rejects CSRF state mismatch on redirect callback', async () => {
    const storage = createStorage('csrf');
    const { win, setSearch } = createMockWindow('https://app.example.com/');
    const auth = new GoogleOAuthWebAuth({
      clientId: 'cid',
      tokenHelperUrl: 'https://th.example.com',
      storage,
      windowImpl: win,
    });

    await auth.signIn();
    setSearch('?code=abc&state=wrong-state');

    await expect(auth.handleRedirectCallback()).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'AUTH_REQUIRED',
    );
    expect(win.location.search).toBe('');

    storage.close();
  });

  it('silently refreshes when < 5 min remain, deduplicates concurrent refreshes, retains token on offline failure, and flags invalid_grant', async () => {
    const storage = createStorage('refresh');
    const now = 1_750_000_000_000;
    await storage.setKv('oauth_tokens', {
      accessToken: 'acc-expiring',
      refreshToken: 'ref-valid',
      expiresAt: now + 2 * 60 * 1000, // 2 minutes left (< 5 min threshold)
      reconnectRequired: false,
    } satisfies StoredOAuthTokens);

    let mode: 'ok' | 'offline' | 'invalid_grant' = 'ok';
    const mockFetch = vi.fn(async () => {
      if (mode === 'offline') {
        throw new TypeError('NetworkError');
      }
      if (mode === 'invalid_grant') {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: 'acc-refreshed', expires_in: 3600 }), {
        status: 200,
      });
    });

    const auth = new GoogleOAuthWebAuth({
      clientId: 'cid',
      tokenHelperUrl: 'https://th.example.com',
      storage,
      fetchImpl: mockFetch,
      nowMs: () => now,
    });

    // 3 concurrent calls trigger only ONE /auth/refresh HTTP call
    const [t1, t2, t3] = await Promise.all([
      auth.getValidAccessToken(),
      auth.getValidAccessToken(),
      auth.getValidAccessToken(),
    ]);
    expect([t1, t2, t3]).toEqual(['acc-refreshed', 'acc-refreshed', 'acc-refreshed']);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Offline failure keeps refreshToken intact and throws NETWORK
    mode = 'offline';
    await expect(auth.getValidAccessToken({ forceRefresh: true })).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'NETWORK',
    );
    const afterOffline = await storage.getKv<StoredOAuthTokens>('oauth_tokens');
    expect(afterOffline?.refreshToken).toBe('ref-valid');
    expect(afterOffline?.reconnectRequired).toBe(false);

    // invalid_grant clears accessToken and sets reconnectRequired = true
    mode = 'invalid_grant';
    await expect(auth.getValidAccessToken({ forceRefresh: true })).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'AUTH_REQUIRED',
    );
    const afterRevoke = await storage.getKv<StoredOAuthTokens>('oauth_tokens');
    expect(afterRevoke?.accessToken).toBe('');
    expect(afterRevoke?.reconnectRequired).toBe(true);
    expect(await auth.isConnected()).toBe(false);

    storage.close();
  });

  it('cleans up stored PKCE verifier even when /auth/exchange fails due to a network error', async () => {
    const storage = createStorage('pkce-cleanup');
    const { win, assignedUrls, setSearch } = createMockWindow('https://app.example.com/');
    const auth = new GoogleOAuthWebAuth({
      clientId: 'cid',
      tokenHelperUrl: 'https://th.example.com',
      storage,
      windowImpl: win,
      fetchImpl: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });

    await auth.signIn();
    const state = new URL(assignedUrls[0] ?? '').searchParams.get('state') ?? '';
    setSearch(`?code=abc&state=${encodeURIComponent(state)}`);

    await expect(auth.handleRedirectCallback()).rejects.toSatisfy(
      (err) => isSyncTransportError(err) && err.code === 'NETWORK',
    );
    expect(await storage.getKv('oauth_pkce')).toBeUndefined();

    storage.close();
  });
});
