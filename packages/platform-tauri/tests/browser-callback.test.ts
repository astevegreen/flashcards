import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshTokenStore } from '../src/auth/refresh-token-store.ts';

const plugin = vi.hoisted(() => ({
  urlListener: undefined as ((url: string) => void) | undefined,
  /** How long `onUrl` takes to register its listener (the real one is an IPC round trip). */
  listenDelayMs: 0,
  /** When false, the "browser" never redirects back. */
  browserAnswers: true,
  nextPort: 53682,
  log: [] as string[],
}));

vi.mock('@fabianlars/tauri-plugin-oauth', () => ({
  start: vi.fn(async () => {
    const port = plugin.nextPort++;
    plugin.log.push(`start:${port}`);
    return port;
  }),
  cancel: vi.fn(async (port: number) => {
    plugin.log.push(`cancel:${port}`);
  }),
  onUrl: vi.fn(async (cb: (url: string) => void) => {
    if (plugin.listenDelayMs > 0) {
      await new Promise((r) => setTimeout(r, plugin.listenDelayMs));
    }
    plugin.urlListener = cb;
    return () => {
      if (plugin.urlListener === cb) plugin.urlListener = undefined;
    };
  }),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  // The "browser" redirects back at once, with the code and the same state.
  openUrl: vi.fn(async (url: string) => {
    const parsed = new URL(url);
    const state = parsed.searchParams.get('state') ?? '';
    const redirect = parsed.searchParams.get('redirect_uri') ?? '';
    plugin.log.push('open');
    if (plugin.browserAnswers) {
      queueMicrotask(() => plugin.urlListener?.(`${redirect}/?code=c1&state=${state}`));
    }
  }),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(
    async () =>
      new Response(
        JSON.stringify({ access_token: 'a1', expires_in: 14_400, refresh_token: 'r1' }),
        {
          status: 200,
        },
      ),
  ),
}));

const { awaitBrowserCallback, BrowserCallbackError, createLatestAttempt } =
  await import('../src/native/browser-callback.ts');
const { createDropboxLoopbackBridge } = await import('../src/native/dropbox-loopback.ts');

function memoryStore(): RefreshTokenStore {
  let value: string | undefined;
  return {
    get: async () => value,
    set: async (token) => {
      value = token;
    },
    delete: async () => {
      value = undefined;
    },
  };
}

beforeEach(() => {
  plugin.urlListener = undefined;
  plugin.listenDelayMs = 0;
  plugin.browserAnswers = true;
  plugin.nextPort = 53682;
  plugin.log = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Tauri system-browser callbacks (N6)', () => {
  it('catches a redirect that arrives right as the browser opens', async () => {
    // The listener takes a moment to register; the old code opened the browser without waiting
    // for it, missed the redirect, and waited forever.
    plugin.listenDelayMs = 20;
    const bridge = createDropboxLoopbackBridge({ appKey: 'k', tokenStore: memoryStore() });
    await expect(bridge.authorize()).resolves.toEqual({
      accessToken: 'a1',
      expiresInSeconds: 14_400,
    });
  }, 2_000);

  it('gives up after the timeout, stops listening and frees the loopback port', async () => {
    vi.useFakeTimers();
    plugin.browserAnswers = false;
    const bridge = createDropboxLoopbackBridge({ appKey: 'k', tokenStore: memoryStore() });
    const attempt = bridge.authorize();
    const settled = expect(attempt).rejects.toThrow('Dropbox sign-in timed out');
    // PKCE hashing runs off the fake clock; the timeout starts once the browser has opened.
    await vi.waitFor(() => expect(plugin.log).toContain('open'));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(plugin.log).not.toContain('cancel:53682');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
    expect(plugin.urlListener).toBeUndefined();
    expect(plugin.log).toEqual(['start:53682', 'open', 'cancel:53682']);
  });

  it('a second Connect replaces the waiting one, after its port is freed', async () => {
    plugin.browserAnswers = false;
    const bridge = createDropboxLoopbackBridge({ appKey: 'k', tokenStore: memoryStore() });
    const first = bridge.authorize();
    const firstFailed = expect(first).rejects.toMatchObject({ reason: 'superseded' });
    await vi.waitFor(() => expect(plugin.log).toContain('open'));
    plugin.browserAnswers = true;
    const second = bridge.authorize();
    await firstFailed;
    await expect(second).resolves.toMatchObject({ accessToken: 'a1' });
    expect(plugin.log).toEqual([
      'start:53682',
      'open',
      'cancel:53682',
      'start:53683',
      'open',
      'cancel:53683',
    ]);
  });

  it('awaitBrowserCallback opens only after the listener is live, and skips URLs it doesn’t accept', async () => {
    const order: string[] = [];
    let deliver: ((url: string) => void) | undefined;
    const url = await awaitBrowserCallback({
      subscribe: async (cb) => {
        await new Promise((r) => setTimeout(r, 10));
        deliver = cb;
        order.push('listening');
        return () => order.push('unsubscribed');
      },
      open: async () => {
        order.push('open');
        deliver?.('flashcards://add-device?x=1');
        deliver?.('flashcards://picker-callback?files=[]');
      },
      accept: (u) => u.startsWith('flashcards://picker-callback'),
      timeoutMs: 1_000,
      label: 'Picker',
    });
    expect(url).toBe('flashcards://picker-callback?files=[]');
    expect(order).toEqual(['listening', 'open', 'unsubscribed']);
  });

  it('createLatestAttempt aborts the waiting attempt and starts the next once it settles', async () => {
    const latest = createLatestAttempt();
    const events: string[] = [];
    const first = latest(
      (signal) =>
        new Promise<string>((_, reject) => {
          events.push('first started');
          signal.addEventListener('abort', () => {
            events.push('first aborted');
            setTimeout(() => {
              events.push('first cleaned up');
              reject(new BrowserCallbackError('superseded', 'replaced'));
            }, 5);
          });
        }),
    );
    const firstFailed = expect(first).rejects.toMatchObject({ reason: 'superseded' });
    await vi.waitFor(() => expect(events).toContain('first started'));
    const second = latest(async () => {
      events.push('second started');
      return 'ok';
    });
    await firstFailed;
    await expect(second).resolves.toBe('ok');
    expect(events).toEqual([
      'first started',
      'first aborted',
      'first cleaned up',
      'second started',
    ]);
  });

  it('an attempt replaced before it starts gives up at once', async () => {
    const latest = createLatestAttempt();
    const opened: string[] = [];
    const attempt = (label: string) =>
      latest((signal) =>
        awaitBrowserCallback({
          subscribe: async () => () => undefined,
          open: async () => {
            opened.push(label);
          },
          timeoutMs: 50,
          signal,
          label,
        }),
      );
    const first = attempt('first');
    const firstFailed = expect(first).rejects.toMatchObject({ reason: 'superseded' });
    const second = attempt('second');
    await firstFailed;
    await expect(second).rejects.toMatchObject({ reason: 'timeout' });
    expect(opened).toEqual(['second']);
  });
});
