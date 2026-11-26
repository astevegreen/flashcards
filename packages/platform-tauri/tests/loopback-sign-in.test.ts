import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What the fake "browser" sends back to the loopback server for each attempt. */
const plugin = vi.hoisted(() => ({
  urlListener: undefined as ((url: string) => void) | undefined,
  reply: (state: string): string => `http://127.0.0.1:51234/?code=c1&state=${state}`,
}));

const start = vi.fn(async (_opts: { ports?: number[]; response?: string }) => 51234);
const cancel = vi.fn(async (_port: number) => undefined);

vi.mock('@fabianlars/tauri-plugin-oauth', () => ({
  start: (opts: { ports?: number[]; response?: string }) => start(opts),
  cancel: (port: number) => cancel(port),
  onUrl: vi.fn(async (cb: (url: string) => void) => {
    plugin.urlListener = cb;
    return () => undefined;
  }),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async (url: string) => {
    const state = new URL(url).searchParams.get('state') ?? '';
    queueMicrotask(() => plugin.urlListener?.(plugin.reply(state)));
  }),
}));

const { runLoopbackSignIn } = await import('../src/native/loopback-sign-in.ts');

const baseOptions = {
  provider: 'Dropbox',
  successHtml: '<p>ok</p>',
  buildAuthUrl: ({ state, challenge }: { state: string; challenge: string }) =>
    `https://auth.example/authorize?state=${state}&code_challenge=${challenge}`,
};

describe('runLoopbackSignIn (R3)', () => {
  beforeEach(() => {
    plugin.urlListener = undefined;
    plugin.reply = (state) => `http://127.0.0.1:51234/?code=c1&state=${state}`;
    start.mockClear();
    cancel.mockClear();
  });

  it('redeems the code with the verifier and redirect URI, then releases the server', async () => {
    const redeem = vi.fn(async (p: { code: string; verifier: string; redirectUri: string }) => p);
    const result = await runLoopbackSignIn(baseOptions, redeem);
    expect(result.code).toBe('c1');
    expect(result.verifier).toMatch(/^[\w-]{43}$/);
    expect(result.redirectUri).toBe('http://127.0.0.1:51234');
    expect(cancel).toHaveBeenCalledWith(51234);
  });

  it('passes fixed ports through (Dropbox needs exact redirect URIs)', async () => {
    await runLoopbackSignIn({ ...baseOptions, ports: [53682, 53683] }, async () => 'ok');
    expect(start).toHaveBeenCalledWith({ ports: [53682, 53683], response: '<p>ok</p>' });
  });

  it('lets any free port be used when no ports are given', async () => {
    await runLoopbackSignIn({ ...baseOptions, redirectHost: 'localhost' }, async (p) => p);
    expect(start).toHaveBeenCalledWith({ response: '<p>ok</p>' });
  });

  it('refuses a callback whose state does not match', async () => {
    plugin.reply = () => 'http://127.0.0.1:51234/?code=c1&state=forged';
    const redeem = vi.fn(async () => 'never');
    await expect(runLoopbackSignIn(baseOptions, redeem)).rejects.toThrow('OAuth state mismatch.');
    expect(redeem).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(51234);
  });

  it("reports the provider's error", async () => {
    plugin.reply = (state) => `http://127.0.0.1:51234/?error=access_denied&state=${state}`;
    await expect(runLoopbackSignIn(baseOptions, async () => 'never')).rejects.toThrow(
      'Dropbox sign-in failed: access_denied',
    );
  });

  it('releases the server when redeeming the code throws', async () => {
    await expect(
      runLoopbackSignIn(baseOptions, async () => {
        throw new Error('token endpoint down');
      }),
    ).rejects.toThrow('token endpoint down');
    expect(cancel).toHaveBeenCalledWith(51234);
  });
});
