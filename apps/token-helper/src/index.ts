export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Comma-separated exact origins, e.g. "http://localhost:5173,https://flashcards-spike.pages.dev" */
  ALLOWED_ORIGINS: string;
}

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_BODY_BYTES = 16_384;

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const trimmed = part.trim().replace(/\/+$/, '');
    if (trimmed) out.add(trimmed);
  }
  return out;
}

function buildHeaders(origin: string | null): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: buildHeaders(origin) });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function forwardToGoogle(params: URLSearchParams, origin: string | null): Promise<Response> {
  const upstream = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const raw = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  if (!upstream.ok) {
    return jsonResponse(
      {
        error: typeof raw.error === 'string' ? raw.error : 'token_exchange_failed',
        error_description:
          typeof raw.error_description === 'string' ? raw.error_description : undefined,
      },
      upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
      origin,
    );
  }
  return jsonResponse(
    {
      access_token: raw.access_token,
      ...(typeof raw.refresh_token === 'string' ? { refresh_token: raw.refresh_token } : {}),
      expires_in: raw.expires_in,
      scope: raw.scope,
      token_type: raw.token_type,
    },
    200,
    origin,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const corsOrigin = origin && allowed.has(origin) ? origin : null;

    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ ok: true, stateless: true }, 200, corsOrigin);
    }

    if (origin && !corsOrigin) {
      return jsonResponse({ error: 'origin_not_allowed' }, 403, null);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: buildHeaders(corsOrigin) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, corsOrigin);
    }

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return jsonResponse({ error: 'server_misconfigured' }, 500, corsOrigin);
    }

    const body = await readJsonBody(request);
    if (!body) {
      return jsonResponse({ error: 'invalid_json_body' }, 400, corsOrigin);
    }

    if (url.pathname === '/auth/exchange') {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri.trim() : '';
      const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier.trim() : '';
      if (!code || !redirectUri) {
        return jsonResponse({ error: 'missing_code_or_redirect_uri' }, 400, corsOrigin);
      }
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      });
      if (codeVerifier) {
        params.set('code_verifier', codeVerifier);
      }
      return forwardToGoogle(params, corsOrigin);
    }

    if (url.pathname === '/auth/refresh') {
      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : '';
      if (!refreshToken) {
        return jsonResponse({ error: 'missing_refresh_token' }, 400, corsOrigin);
      }
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      });
      return forwardToGoogle(params, corsOrigin);
    }

    return jsonResponse({ error: 'not_found' }, 404, corsOrigin);
  },
};
