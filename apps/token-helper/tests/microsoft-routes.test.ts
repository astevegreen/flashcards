import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { sanitizeMicrosoftScope, type Env } from '../src/index.ts';

const MS_ENV: Env = {
  GOOGLE_CLIENT_ID: 'google-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  MS_CLIENT_ID: '00000000-1111-2222-3333-444444444444',
  MS_CLIENT_SECRET: 'ms-super-secret~value',
};

function post(path: string, body: unknown, origin = 'http://localhost:5173'): Request {
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockUpstream(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('@flash/token-helper Microsoft OneDrive routes (§15 Phase 12)', () => {
  it('exchanges a code + PKCE verifier at the consumers tenant without leaking the secret', async () => {
    const fetchMock = mockUpstream({
      access_token: 'EwB.access',
      refresh_token: 'M.C.refresh',
      expires_in: 3600,
      scope: 'Files.ReadWrite.AppFolder offline_access',
      token_type: 'Bearer',
      id_token: 'should-not-be-forwarded',
    });
    const res = await worker.fetch(
      post('/ms/exchange', {
        code: 'M.C123',
        redirect_uri: 'http://localhost:5173/',
        code_verifier: 'verifier-abc',
      }),
      MS_ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');

    const [endpoint, init] = fetchMock.mock.calls[0] ?? [];
    expect(endpoint).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    const sent = new URLSearchParams(String(init?.body ?? ''));
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_id')).toBe(MS_ENV.MS_CLIENT_ID);
    expect(sent.get('client_secret')).toBe(MS_ENV.MS_CLIENT_SECRET);
    expect(sent.get('code_verifier')).toBe('verifier-abc');
    expect(sent.get('scope')).toBe('Files.ReadWrite.AppFolder offline_access');

    const text = await res.text();
    expect(text).not.toContain(MS_ENV.MS_CLIENT_SECRET);
    expect(JSON.parse(text)).toEqual({
      access_token: 'EwB.access',
      refresh_token: 'M.C.refresh',
      expires_in: 3600,
      scope: 'Files.ReadWrite.AppFolder offline_access',
      token_type: 'Bearer',
    });
  });

  it('refreshes with the requested allowlisted scope and forwards the rotated refresh token', async () => {
    const fetchMock = mockUpstream({
      access_token: 'EwB.new',
      refresh_token: 'M.C.rotated',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    const res = await worker.fetch(
      post('/ms/refresh', {
        refresh_token: 'M.C.refresh',
        scope: 'Files.ReadWrite.AppFolder Files.Read offline_access',
      }),
      { ...MS_ENV, MS_TENANT: 'common' },
    );
    expect(res.status).toBe(200);
    const [endpoint, init] = fetchMock.mock.calls[0] ?? [];
    expect(endpoint).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    const sent = new URLSearchParams(String(init?.body ?? ''));
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('M.C.refresh');
    expect(sent.get('scope')).toBe('Files.ReadWrite.AppFolder Files.Read offline_access');
    expect(((await res.json()) as { refresh_token?: string }).refresh_token).toBe('M.C.rotated');
  });

  it('surfaces Microsoft errors (e.g. invalid_grant) with their status', async () => {
    mockUpstream({ error: 'invalid_grant', error_description: 'AADSTS70000: expired' }, 400);
    const res = await worker.fetch(post('/ms/refresh', { refresh_token: 'old' }), MS_ENV);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'AADSTS70000: expired',
    });
  });

  it('rejects scopes outside the allowlist without calling Microsoft', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(
      post('/ms/refresh', { refresh_token: 'rt', scope: 'Files.ReadWrite.All offline_access' }),
      MS_ENV,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'scope_not_allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates required fields, origins and configuration like the Google routes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const missing = await worker.fetch(post('/ms/exchange', { code: 'x' }), MS_ENV);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'missing_code_or_redirect_uri' });

    const noToken = await worker.fetch(post('/ms/refresh', {}), MS_ENV);
    expect(await noToken.json()).toEqual({ error: 'missing_refresh_token' });

    const evil = await worker.fetch(
      post('/ms/refresh', { refresh_token: 'rt' }, 'https://evil.example'),
      MS_ENV,
    );
    expect(evil.status).toBe(403);
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const { MS_CLIENT_SECRET: _secret, ...unconfigured } = MS_ENV;
    void _secret;
    const misconfigured = await worker.fetch(post('/ms/refresh', { refresh_token: 'rt' }), {
      ...unconfigured,
    });
    expect(misconfigured.status).toBe(500);
    expect(await misconfigured.json()).toEqual({ error: 'server_misconfigured' });

    const badTenant = await worker.fetch(post('/ms/refresh', { refresh_token: 'rt' }), {
      ...MS_ENV,
      MS_TENANT: 'evil.example/../x',
    });
    expect(badTenant.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps Google routes working when only Microsoft is configured, and vice versa', async () => {
    const googleOnly: Env = {
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 's',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    };
    const msRes = await worker.fetch(post('/ms/refresh', { refresh_token: 'rt' }), googleOnly);
    expect(msRes.status).toBe(500);

    mockUpstream({ access_token: 'g-access', expires_in: 3599, token_type: 'Bearer' });
    const msOnly: Env = { ...MS_ENV, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' };
    const gRes = await worker.fetch(post('/auth/refresh', { refresh_token: 'rt' }), msOnly);
    expect(gRes.status).toBe(500);
    const msOk = await worker.fetch(post('/ms/refresh', { refresh_token: 'rt' }), msOnly);
    expect(msOk.status).toBe(200);
  });

  it('answers 502 when Microsoft is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('network down'));
    const res = await worker.fetch(post('/ms/refresh', { refresh_token: 'rt' }), MS_ENV);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_unreachable' });
  });

  it('sanitizes scope strings', () => {
    expect(sanitizeMicrosoftScope('')).toBe('Files.ReadWrite.AppFolder offline_access');
    expect(sanitizeMicrosoftScope('  Files.Read   offline_access ')).toBe(
      'Files.Read offline_access',
    );
    expect(sanitizeMicrosoftScope('https://graph.microsoft.com/.default')).toBeNull();
    expect(sanitizeMicrosoftScope('   ')).toBeNull();
  });
});
