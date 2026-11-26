import 'fake-indexeddb/auto';
import { isSyncTransportError } from '@flash/core';
import Dexie from 'dexie';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoogleOAuthWindowLike } from '../src/auth/google-oauth-web.ts';
import {
  MicrosoftOAuthWebAuth,
  type StoredMicrosoftTokens,
} from '../src/auth/microsoft-oauth-web.ts';
import { DexieStorage } from '../src/storage/dexie-storage.ts';

const createdDbs: string[] = [];
const HELPER = 'https://helper.example.workers.dev';

function createStorage(name: string): DexieStorage {
  const s = new DexieStorage(`ms-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

interface HelperCall {
  url: string;
  body: Record<string, string>;
}

function createHelperFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: HelperCall[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  return { calls, fetchImpl };
}

afterEach(async () => {
  while (createdDbs.length > 0) {
    const db = createdDbs.pop();
    if (db) await Dexie.delete(db);
  }
});

describe('MicrosoftOAuthWebAuth (PKCE redirect + token helper /ms/*)', () => {
  it('redirects with PKCE, exchanges via /ms/exchange, then refreshes and stores the rotated token', async () => {
    const storage = createStorage('flow');
    const { win, assigned } = createMockWindow('https://app.example.com/?device=a');
    const { calls, fetchImpl } = createHelperFetch([
      {
        status: 200,
        body: { access_token: 'ms-acc-1', refresh_token: 'ms-ref-1', expires_in: 3600 },
      },
      {
        status: 200,
        body: { access_token: 'ms-acc-2', refresh_token: 'ms-ref-2', expires_in: 3600 },
      },
    ]);
    let clock = 1_750_000_000_000;
    const auth = new MicrosoftOAuthWebAuth({
      clientId: 'ms-client-id',
      tokenHelperUrl: `${HELPER}/`,
      storage,
      fetchImpl,
      windowImpl: win,
      nowMs: () => clock,
    });
    expect(auth.isConfigured()).toBe(true);

    await auth.signIn({ intent: 'sync' });
    const authUrl = new URL(assigned[0] ?? '');
    expect(authUrl.origin).toBe('https://login.microsoftonline.com');
    expect(authUrl.pathname).toBe('/consumers/oauth2/v2.0/authorize');
    expect(authUrl.searchParams.get('scope')).toBe('Files.ReadWrite.AppFolder offline_access');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://app.example.com/');
    const state = authUrl.searchParams.get('state') ?? '';
    expect(state.startsWith('ms.')).toBe(true);

    // A foreign callback (Google/Dropbox state) is ignored and the URL is left alone.
    win.location.search = '?code=other&state=google-state';
    expect(await auth.handleRedirectCallback()).toBeNull();
    expect(win.location.search).toBe('?code=other&state=google-state');

    win.location.search = `?device=a&code=ms-code&state=${encodeURIComponent(state)}`;
    const session = await auth.handleRedirectCallback();
    expect(session?.provider).toBe('onedrive');
    expect(session?.intent).toBe('sync');
    expect(win.location.search).toBe('?device=a');
    expect(calls[0]?.url).toBe(`${HELPER}/ms/exchange`);
    expect(calls[0]?.body['code']).toBe('ms-code');
    expect(calls[0]?.body['code_verifier']?.length).toBeGreaterThan(30);
    expect(calls[0]?.body['scope']).toBe('Files.ReadWrite.AppFolder offline_access');
    expect(await auth.isConnected()).toBe(true);
    expect(await auth.getValidAccessToken()).toBe('ms-acc-1');

    clock += 3_600_000;
    expect(await auth.getValidAccessToken()).toBe('ms-acc-2');
    expect(calls[1]?.url).toBe(`${HELPER}/ms/refresh`);
    expect(calls[1]?.body).toEqual({
      refresh_token: 'ms-ref-1',
      scope: 'Files.ReadWrite.AppFolder offline_access',
    });
    const stored = await storage.getKv<StoredMicrosoftTokens>('onedrive_oauth_tokens');
    expect(stored?.refreshToken).toBe('ms-ref-2');
  });

  it('adds Files.Read for the picker (intent "sources") and keeps already-granted scopes', async () => {
    const storage = createStorage('picker');
    const { win, assigned } = createMockWindow('https://app.example.com/');
    await storage.setKv('onedrive_oauth_tokens', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      scope: 'Files.ReadWrite.AppFolder offline_access',
    } satisfies StoredMicrosoftTokens);
    const auth = new MicrosoftOAuthWebAuth({
      clientId: 'ms-client-id',
      tokenHelperUrl: HELPER,
      tenant: 'common',
      storage,
      windowImpl: win,
    });
    expect(await auth.hasScope('Files.Read')).toBe(false);
    await auth.signIn({ intent: 'sources' });
    const authUrl = new URL(assigned[0] ?? '');
    expect(authUrl.pathname.startsWith('/common/')).toBe(true);
    expect(authUrl.searchParams.get('scope')).toBe(
      'Files.ReadWrite.AppFolder offline_access Files.Read',
    );
  });

  it('marks reconnect required on invalid_grant and maps helper outages to NETWORK', async () => {
    const storage = createStorage('errors');
    await storage.setKv('onedrive_oauth_tokens', {
      accessToken: '',
      refreshToken: 'revoked',
      expiresAt: 0,
      scope: 'Files.ReadWrite.AppFolder offline_access',
    } satisfies StoredMicrosoftTokens);
    const { fetchImpl } = createHelperFetch([
      { status: 503, body: { error: 'temporarily_unavailable' } },
      { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000' } },
    ]);
    const auth = new MicrosoftOAuthWebAuth({
      clientId: 'ms-client-id',
      tokenHelperUrl: HELPER,
      storage,
      fetchImpl,
    });

    const outage = await auth.getValidAccessToken().catch((e: unknown) => e);
    expect(isSyncTransportError(outage) && outage.code).toBe('NETWORK');
    expect(await auth.isConnected()).toBe(true);

    const revoked = await auth.getValidAccessToken().catch((e: unknown) => e);
    expect(isSyncTransportError(revoked) && revoked.code).toBe('AUTH_REQUIRED');
    expect(await auth.isConnected()).toBe(false);
    const again = await auth.getValidAccessToken().catch((e: unknown) => e);
    expect(String(again)).toMatch(/reconnect/i);

    await auth.signOut();
    expect(await storage.getKv('onedrive_oauth_tokens')).toBeUndefined();
  });

  it('surfaces a cancelled sign-in and refuses to start when unconfigured', async () => {
    const storage = createStorage('cancel');
    const { win, assigned } = createMockWindow('https://app.example.com/');
    const auth = new MicrosoftOAuthWebAuth({
      clientId: 'ms-client-id',
      tokenHelperUrl: HELPER,
      storage,
      windowImpl: win,
    });
    await auth.signIn();
    const state = new URL(assigned[0] ?? '').searchParams.get('state') ?? '';
    win.location.search = `?error=access_denied&error_description=User+cancelled&state=${encodeURIComponent(state)}`;
    await expect(auth.handleRedirectCallback()).rejects.toThrow(/cancelled or failed/);

    const unconfigured = new MicrosoftOAuthWebAuth({
      clientId: '',
      tokenHelperUrl: HELPER,
      storage,
    });
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(unconfigured.signIn()).rejects.toThrow(/not configured/);
  });
});

describe('OneDrive PKCE record expiry (S13)', () => {
  it('refuses a callback whose PKCE record is older than PKCE_MAX_AGE_MS', async () => {
    const storage = createStorage('expiry');
    const { win, assigned } = createMockWindow('https://app.example.com/');
    const { calls, fetchImpl } = createHelperFetch([]);
    let clock = 1_750_000_000_000;
    const auth = new MicrosoftOAuthWebAuth({
      clientId: 'ms-client-id',
      tokenHelperUrl: `${HELPER}/`,
      storage,
      fetchImpl,
      windowImpl: win,
      nowMs: () => clock,
    });
    await auth.signIn({ intent: 'sync' });
    const state = new URL(assigned[0] ?? '').searchParams.get('state') ?? '';
    clock += 31 * 60_000;
    win.location.search = `?code=ms-code&state=${encodeURIComponent(state)}`;
    await expect(auth.handleRedirectCallback()).rejects.toThrow(/took too long/);
    expect(calls).toHaveLength(0);
    expect(win.location.search).toBe('');
    storage.close();
  });
});
