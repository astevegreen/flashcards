import type { OAuth2ProviderConfig } from '@capgo/capacitor-social-login';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecureStore } from '../src/secure/secure-store.ts';

type Oauth2Map = Record<string, OAuth2ProviderConfig>;

const plugin = vi.hoisted(() => ({ initializeCalls: [] as Array<{ oauth2?: Oauth2Map }> }));

vi.mock('@capgo/capacitor-social-login', () => ({
  SocialLogin: {
    initialize: vi.fn(async (options: { oauth2?: Oauth2Map }) => {
      plugin.initializeCalls.push(options);
    }),
    // No tokens stored by the plugin: the launch migration has nothing to move.
    getAuthorizationCode: vi.fn(async () => {
      throw new Error('no tokens');
    }),
    login: vi.fn(),
    logout: vi.fn(async () => undefined),
  },
}));

const { createOAuth2ProviderRegistry } = await import('../src/native/oauth2-providers.ts');
const { createMicrosoftSocialLoginBridge } =
  await import('../src/native/microsoft-social-login.ts');
const { createDropboxSocialLoginBridge } = await import('../src/native/dropbox-social-login.ts');

function memorySecureStore(): SecureStore {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
    remove: async (k) => {
      map.delete(k);
    },
  };
}

const config = (appId: string): OAuth2ProviderConfig => ({
  appId,
  authorizationBaseUrl: 'https://auth.example',
  redirectUrl: 'flashcards://oauth/test',
});

describe('generic OAuth2 providers share one initialize (N5)', () => {
  beforeEach(() => {
    plugin.initializeCalls.length = 0;
  });

  it('connecting Dropbox after OneDrive keeps OneDrive’s config (Android replaces the map)', async () => {
    const secureStore = memorySecureStore();
    await createMicrosoftSocialLoginBridge({ clientId: 'ms-client', secureStore });
    await createDropboxSocialLoginBridge({ appKey: 'dbx-key', secureStore });
    const last = plugin.initializeCalls.at(-1)?.oauth2 ?? {};
    expect(Object.values(last).map((c) => c.appId)).toEqual(['ms-client', 'dbx-key']);
  });

  it('re-registering the same config does not initialize again', async () => {
    const calls: Oauth2Map[] = [];
    const register = createOAuth2ProviderRegistry(async ({ oauth2 }) => {
      calls.push(oauth2);
    });
    await register('a', config('A'));
    await register('a', config('A'));
    await register('b', config('B'));
    await register('a', config('A2'));
    expect(calls.map((c) => Object.values(c).map((p) => p.appId))).toEqual([
      ['A'],
      ['A', 'B'],
      ['A2', 'B'],
    ]);
  });

  it('runs one initialize at a time, and a failed one is retried on the next registration', async () => {
    const calls: string[][] = [];
    let fail = true;
    let inFlight = 0;
    const register = createOAuth2ProviderRegistry(async ({ oauth2 }) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      calls.push(Object.keys(oauth2));
      if (fail) {
        fail = false;
        throw new Error('bad config');
      }
    });
    const first = register('a', config('A'));
    const second = register('b', config('B'));
    await expect(first).rejects.toThrow('bad config');
    await expect(second).resolves.toBeUndefined();
    await register('a', config('A'));
    expect(calls).toEqual([['a'], ['a', 'b']]);
  });
});
