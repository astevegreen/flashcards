export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Comma-separated exact origins, e.g. "http://localhost:5173,https://flashcards-spike.pages.dev" */
  ALLOWED_ORIGINS: string;
  /** Microsoft Entra app client ID for OneDrive web sign-in (`/ms/*`, §15 Phase 12). */
  MS_CLIENT_ID?: string;
  /** Microsoft Entra client secret (Web platform redirect URI; confidential client). */
  MS_CLIENT_SECRET?: string;
  /**
   * Entra authority tenant: `consumers` (default, personal Microsoft accounts), `common`,
   * `organizations`, or a tenant GUID / domain.
   */
  MS_TENANT?: string;
  /**
   * Cloudflare rate-limiting binding (`[[ratelimits]]` in wrangler.toml), keyed by client IP and
   * route. A browser Origin header is easy to fake outside a browser, so this is what caps what one
   * client can do with the client secret. When the binding is absent the check is skipped.
   */
  TOKEN_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_BODY_BYTES = 16_384;
const DEFAULT_MS_TENANT = 'consumers';
/** Tenant names are plain identifiers, GUIDs or domain names (never a path or URL). */
const MS_TENANT_PATTERN = /^[A-Za-z0-9.-]{1,64}$/;
/**
 * The only scopes the Worker forwards to Microsoft: OneDrive app-folder sync, the optional picker
 * read scope, refresh tokens and basic sign-in claims. Anything else is rejected.
 */
const MS_ALLOWED_SCOPES = new Set([
  'Files.ReadWrite.AppFolder',
  'Files.Read',
  'offline_access',
  'openid',
  'profile',
  'User.Read',
]);
const MS_DEFAULT_SCOPE = 'Files.ReadWrite.AppFolder offline_access';

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

const BODY_TOO_LARGE = Symbol('body_too_large');

/**
 * Reads at most `MAX_BODY_BYTES` of the body. A declared `Content-Length` over the cap is refused
 * before anything is read, and a streamed body is cancelled as soon as it passes the cap.
 */
async function readBoundedText(request: Request): Promise<string | typeof BODY_TOO_LARGE> {
  const declared = Number(request.headers.get('Content-Length') ?? '');
  if (declared > MAX_BODY_BYTES) return BODY_TOO_LARGE;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return BODY_TOO_LARGE;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Posts a token request upstream and returns only the token fields (never the client secret or
 * any upstream extras such as ID tokens). Nothing is stored or logged.
 */
async function forwardTokenRequest(
  endpoint: string,
  params: URLSearchParams,
  origin: string | null,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch {
    return jsonResponse({ error: 'upstream_unreachable' }, 502, origin);
  }
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
  // A 200 without a token is a broken upstream reply: never pass it on as a success (§11).
  if (typeof raw.access_token !== 'string' || !raw.access_token) {
    return jsonResponse({ error: 'invalid_upstream_response' }, 502, origin);
  }
  return jsonResponse(
    {
      access_token: raw.access_token,
      ...(typeof raw.refresh_token === 'string' ? { refresh_token: raw.refresh_token } : {}),
      ...(typeof raw.expires_in === 'number' ? { expires_in: raw.expires_in } : {}),
      ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
      ...(typeof raw.token_type === 'string' ? { token_type: raw.token_type } : {}),
    },
    200,
    origin,
  );
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Validates a client-requested Microsoft scope list against the allowlist (null = rejected). */
export function sanitizeMicrosoftScope(raw: string): string | null {
  if (!raw) return MS_DEFAULT_SCOPE;
  const parts = raw.split(' ').filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > MS_ALLOWED_SCOPES.size) return null;
  return parts.every((p) => MS_ALLOWED_SCOPES.has(p)) ? parts.join(' ') : null;
}

type RouteHandler = (
  body: Record<string, unknown>,
  env: Env,
  origin: string | null,
) => Promise<Response>;

interface TokenRoute {
  /** True when this provider's client credentials are present in the Worker env. */
  isConfigured: (env: Env) => boolean;
  handle: RouteHandler;
}

const googleExchange: RouteHandler = async (body, env, origin) => {
  const code = stringField(body, 'code');
  const redirectUri = stringField(body, 'redirect_uri');
  const codeVerifier = stringField(body, 'code_verifier');
  if (!code || !redirectUri) {
    return jsonResponse({ error: 'missing_code_or_redirect_uri' }, 400, origin);
  }
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
  if (codeVerifier) params.set('code_verifier', codeVerifier);
  return forwardTokenRequest(GOOGLE_TOKEN_ENDPOINT, params, origin);
};

const googleRefresh: RouteHandler = async (body, env, origin) => {
  const refreshToken = stringField(body, 'refresh_token');
  if (!refreshToken) return jsonResponse({ error: 'missing_refresh_token' }, 400, origin);
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
  return forwardTokenRequest(GOOGLE_TOKEN_ENDPOINT, params, origin);
};

function microsoftTokenEndpoint(env: Env): string | null {
  const tenant = env.MS_TENANT?.trim() || DEFAULT_MS_TENANT;
  if (!MS_TENANT_PATTERN.test(tenant)) return null;
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

/** Shared tail of the `/ms/*` routes: scope allowlist, tenant endpoint, client credentials. */
async function microsoftTokenRequest(
  body: Record<string, unknown>,
  env: Env,
  origin: string | null,
  grant: Record<string, string>,
): Promise<Response> {
  const scope = sanitizeMicrosoftScope(stringField(body, 'scope'));
  if (!scope) return jsonResponse({ error: 'scope_not_allowed' }, 400, origin);
  const endpoint = microsoftTokenEndpoint(env);
  if (!endpoint) return jsonResponse({ error: 'server_misconfigured' }, 500, origin);
  const params = new URLSearchParams({
    ...grant,
    scope,
    client_id: env.MS_CLIENT_ID ?? '',
    client_secret: env.MS_CLIENT_SECRET ?? '',
  });
  return forwardTokenRequest(endpoint, params, origin);
}

const microsoftExchange: RouteHandler = async (body, env, origin) => {
  const code = stringField(body, 'code');
  const redirectUri = stringField(body, 'redirect_uri');
  const codeVerifier = stringField(body, 'code_verifier');
  if (!code || !redirectUri) {
    return jsonResponse({ error: 'missing_code_or_redirect_uri' }, 400, origin);
  }
  return microsoftTokenRequest(body, env, origin, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  });
};

const microsoftRefresh: RouteHandler = async (body, env, origin) => {
  const refreshToken = stringField(body, 'refresh_token');
  if (!refreshToken) return jsonResponse({ error: 'missing_refresh_token' }, 400, origin);
  return microsoftTokenRequest(body, env, origin, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
};

/** A 429 once this IP has used up its requests to this route for the minute (S2), else null. */
async function rateLimitResponse(
  request: Request,
  env: Env,
  pathname: string,
  origin: string,
): Promise<Response | null> {
  if (!env.TOKEN_RATE_LIMITER) return null;
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success } = await env.TOKEN_RATE_LIMITER.limit({ key: `${ip} ${pathname}` });
  if (success) return null;
  const res = jsonResponse({ error: 'rate_limited' }, 429, origin);
  res.headers.set('Retry-After', '60');
  return res;
}

const googleConfigured = (env: Env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const microsoftConfigured = (env: Env) => Boolean(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);

const ROUTES = new Map<string, TokenRoute>([
  ['/auth/exchange', { isConfigured: googleConfigured, handle: googleExchange }],
  ['/auth/refresh', { isConfigured: googleConfigured, handle: googleRefresh }],
  ['/ms/exchange', { isConfigured: microsoftConfigured, handle: microsoftExchange }],
  ['/ms/refresh', { isConfigured: microsoftConfigured, handle: microsoftRefresh }],
]);

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

    const route = ROUTES.get(url.pathname);
    if (!route) {
      return jsonResponse({ error: 'not_found' }, 404, corsOrigin);
    }
    // Only the web app calls these routes, and a browser always sends Origin on a cross-origin
    // POST. The native apps talk to Google, Microsoft and Dropbox directly.
    if (!corsOrigin) {
      return jsonResponse({ error: 'origin_not_allowed' }, 403, null);
    }
    if (!route.isConfigured(env)) {
      return jsonResponse({ error: 'server_misconfigured' }, 500, corsOrigin);
    }
    const limited = await rateLimitResponse(request, env, url.pathname, corsOrigin);
    if (limited) return limited;

    const text = await readBoundedText(request);
    if (text === BODY_TOO_LARGE) {
      return jsonResponse({ error: 'body_too_large' }, 413, corsOrigin);
    }
    const body = parseJsonObject(text);
    if (!body) {
      return jsonResponse({ error: 'invalid_json_body' }, 400, corsOrigin);
    }
    return route.handle(body, env, corsOrigin);
  },
};
