import type { BrowserContext, Route } from '@playwright/test';
import { FakeDropboxServer } from '../../../packages/platform-web/tests/fakes/fake-dropbox.ts';

export { FakeDropboxServer };

const APP_KEY = 'e2e-dropbox-app-key';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, dropbox-api-arg',
  'access-control-expose-headers': 'dropbox-api-result',
};

export interface DropboxFakes {
  server: FakeDropboxServer;
  exchanges: { code: string; scope: string }[];
}

async function preflight(route: Route): Promise<boolean> {
  if (route.request().method() !== 'OPTIONS') return false;
  await route.fulfill({ status: 204, headers: CORS_HEADERS });
  return true;
}

/** Routes Dropbox OAuth authorize, token exchange, and API v2 calls to the in-memory fake. */
export async function installDropboxFakes(
  context: BrowserContext,
  fakes: DropboxFakes,
  devParams: () => string,
): Promise<void> {
  await context.addInitScript((appKey) => {
    (
      window as unknown as { __FLASH_TEST_DROPBOX_APP_KEY__?: string }
    ).__FLASH_TEST_DROPBOX_APP_KEY__ = appKey;
  }, APP_KEY);

  await context.route('https://www.dropbox.com/oauth2/authorize**', async (route) => {
    const url = new URL(route.request().url());
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '/', url);
    const back = new URLSearchParams(devParams());
    back.set('code', `dbx-code-${fakes.exchanges.length + 1}`);
    back.set('state', url.searchParams.get('state') ?? '');
    fakes.exchanges.push({
      code: back.get('code') ?? '',
      scope: url.searchParams.get('scope') ?? '',
    });
    await route.fulfill({ status: 302, headers: { location: `${redirect.href}?${back}` } });
  });

  await context.route('https://api.dropboxapi.com/oauth2/token', async (route) => {
    if (await preflight(route)) return;
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'dbx-e2e-token',
        refresh_token: 'dbx-e2e-refresh',
        expires_in: 14400,
        account_id: 'dbid:e2e',
      }),
    });
  });

  const forwardApi = async (route: Route) => {
    if (await preflight(route)) return;
    const req = route.request();
    const body = req.postDataBuffer();
    const res = await fakes.server.handle({
      method: req.method(),
      url: req.url(),
      headers: await req.allHeaders(),
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
    await route.fulfill({
      status: res.status,
      headers: { ...res.headers, ...CORS_HEADERS },
      body: Buffer.from(res.body),
    });
  };

  await context.route('https://api.dropboxapi.com/2/**', forwardApi);
  await context.route('https://content.dropboxapi.com/2/**', forwardApi);
}
