import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.ts';

const TEST_ENV: Env = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'super-secret-value',
  ALLOWED_ORIGINS: 'http://localhost:5173, https://flashcards-spike.pages.dev/',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('@flash/token-helper stateless Cloudflare Worker', () => {
  it('serves /health with no-store headers', async () => {
    const req = new Request('https://worker.example/health', {
      method: 'GET',
      headers: { Origin: 'http://localhost:5173' },
    });
    const res = await worker.fetch(req, TEST_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(await res.json()).toEqual({ ok: true, stateless: true });
  });

  it('rejects disallowed origins with 403 and no CORS header', async () => {
    const req = new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'rt' }),
    });
    const res = await worker.fetch(req, TEST_ENV);
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('handles CORS preflight for allowed origins (stripping trailing slashes)', async () => {
    const req = new Request('https://worker.example/auth/exchange', {
      method: 'OPTIONS',
      headers: { Origin: 'https://flashcards-spike.pages.dev' },
    });
    const res = await worker.fetch(req, TEST_ENV);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://flashcards-spike.pages.dev',
    );
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('exchanges auth code + PKCE verifier with Google and never leaks client_secret', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
          expires_in: 3599,
          scope: 'https://www.googleapis.com/auth/drive.appdata',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const req = new Request('https://worker.example/auth/exchange', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: '4/0AcvDMr',
        redirect_uri: 'http://localhost:5173/',
        code_verifier: 'pkce-verifier-123',
      }),
    });
    const res = await worker.fetch(req, TEST_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const [endpoint, init] = fetchMock.mock.calls[0] ?? [];
    expect(endpoint).toBe('https://oauth2.googleapis.com/token');
    const sent = new URLSearchParams(String(init?.body ?? ''));
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_id')).toBe(TEST_ENV.GOOGLE_CLIENT_ID);
    expect(sent.get('client_secret')).toBe(TEST_ENV.GOOGLE_CLIENT_SECRET);
    expect(sent.get('code_verifier')).toBe('pkce-verifier-123');

    const bodyText = await res.text();
    expect(bodyText).not.toContain(TEST_ENV.GOOGLE_CLIENT_SECRET);
    expect(JSON.parse(bodyText)).toEqual({
      access_token: 'ya29.access',
      refresh_token: '1//refresh',
      expires_in: 3599,
      scope: 'https://www.googleapis.com/auth/drive.appdata',
      token_type: 'Bearer',
    });
  });

  it('refreshes tokens via /auth/refresh and surfaces Google errors cleanly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been revoked.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const req = new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'revoked-token' }),
    });
    const res = await worker.fetch(req, TEST_ENV);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({
      error: 'invalid_grant',
      error_description: 'Token has been revoked.',
    });
  });

  it('rejects malformed JSON payloads', async () => {
    const req = new Request('https://worker.example/auth/exchange', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
      body: '{"code": ',
    });
    const res = await worker.fetch(req, TEST_ENV);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json_body' });
  });

  it('rejects a token request with no Origin header, before calling Google (S2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const req = new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'rt' }),
    });
    const res = await worker.fetch(req, TEST_ENV);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still answers /health without an Origin header', async () => {
    const res = await worker.fetch(new Request('https://worker.example/health'), TEST_ENV);
    expect(res.status).toBe(200);
  });

  it('refuses a declared Content-Length over the cap without reading the body (S2)', async () => {
    const req = new Request('https://worker.example/auth/exchange', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
        'Content-Length': '1000000',
      },
      body: '{}',
    });
    const res = await worker.fetch(req, TEST_ENV);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'body_too_large' });
    expect(req.bodyUsed).toBe(false);
  });

  it('stops reading a streamed body once it passes the cap (S2)', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(4096));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request('https://worker.example/auth/exchange', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    const res = await worker.fetch(req, TEST_ENV);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'body_too_large' });
    // 16 KiB is five 4 KiB chunks; the stream may queue one more ahead of the reader.
    expect(pulled).toBeLessThan(10);
  });

  it('answers 429 once the per-IP rate limit is spent, before calling Google (S2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const limit = vi.fn(async () => ({ success: false }));
    const env: Env = { ...TEST_ENV, TOKEN_RATE_LIMITER: { limit } };
    const req = new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.7',
      },
      body: JSON.stringify({ refresh_token: 'rt' }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    // The browser must be able to read the 429, so it keeps its CORS header.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.7 /auth/refresh' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the request while the rate limit allows it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'a', expires_in: 3599 }), { status: 200 }),
    );
    const env: Env = {
      ...TEST_ENV,
      TOKEN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const req = new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'rt' }),
    });
    expect((await worker.fetch(req, env)).status).toBe(200);
  });
});
