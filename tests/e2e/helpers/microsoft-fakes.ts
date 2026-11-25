import type { BrowserContext, Route } from '@playwright/test';
import {
  FAKE_DOWNLOAD_ORIGIN,
  FAKE_UPLOAD_ORIGIN,
  FakeGraphServer,
} from '../../../packages/platform-web/tests/fakes/fake-graph.ts';
import { addTestOverrides } from './test-overrides.ts';

/**
 * Microsoft sign-in, the token-helper's `/ms/*` endpoints and Graph, all answered by
 * `context.route` against the shared in-process fake Graph
 * (`packages/platform-web/tests/fakes/fake-graph.ts`), so nothing leaves the machine.
 */

export { FakeGraphServer };

const TOKEN_HELPER_ORIGIN = 'https://flashcards-token-helper.yodc.workers.dev';
const CLIENT_ID = 'e2e-client';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, content-range',
  'access-control-expose-headers': 'retry-after, location',
};

export interface MicrosoftFakes {
  graph: FakeGraphServer;
  exchanges: { code: string; scope: string }[];
}

async function preflight(route: Route): Promise<boolean> {
  if (route.request().method() !== 'OPTIONS') return false;
  await route.fulfill({ status: 204, headers: CORS_HEADERS });
  return true;
}

async function forwardToGraph(route: Route, graph: FakeGraphServer): Promise<void> {
  if (await preflight(route)) return;
  const req = route.request();
  const body = req.postDataBuffer();
  const res = await graph.handle({
    method: req.method(),
    url: req.url(),
    headers: await req.allHeaders(),
    body: body ? new Uint8Array(body) : undefined,
  });
  await route.fulfill({
    status: res.status,
    headers: { ...res.headers, ...CORS_HEADERS },
    body: Buffer.from(res.body),
  });
}

/** Routes Microsoft sign-in, the token-helper's `/ms/*` endpoints and Graph for one context. */
export async function installMicrosoftFakes(
  context: BrowserContext,
  fakes: MicrosoftFakes,
  devParams: () => string,
): Promise<void> {
  // The production preview build takes its test client ID only from this init script.
  await addTestOverrides(context, { msClientId: CLIENT_ID });
  // Sign-in page: consent is instant, so answer with the redirect straight back to the app. The
  // real redirect URI has no query; the fake keeps the dev `?device=` param.
  await context.route('https://login.microsoftonline.com/**', async (route) => {
    const url = new URL(route.request().url());
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '/', url);
    const back = new URLSearchParams(devParams());
    back.set('code', `code-${fakes.exchanges.length + 1}`);
    back.set('state', url.searchParams.get('state') ?? '');
    await route.fulfill({ status: 302, headers: { location: `${redirect.href}?${back}` } });
  });

  await context.route(`${TOKEN_HELPER_ORIGIN}/ms/**`, async (route) => {
    if (await preflight(route)) return;
    const req = route.request();
    const body = (req.postDataJSON() ?? {}) as Record<string, string>;
    if (req.url().endsWith('/ms/exchange')) {
      fakes.exchanges.push({ code: body['code'] ?? '', scope: body['scope'] ?? '' });
    }
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'graph-token-1',
        refresh_token: 'ms-refresh-rotated',
        expires_in: 3600,
        scope: body['scope'] ?? '',
      }),
    });
  });

  for (const pattern of [
    'https://graph.microsoft.com/**',
    `${FAKE_DOWNLOAD_ORIGIN}/**`,
    `${FAKE_UPLOAD_ORIGIN}/**`,
  ]) {
    await context.route(pattern, (route) => forwardToGraph(route, fakes.graph));
  }
}
