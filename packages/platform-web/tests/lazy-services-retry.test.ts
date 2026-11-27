import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The first load of `lazy-services.ts` fails (as a chunk fetch would offline); later loads work.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/lazy-services.ts', async (importOriginal) => {
  loads.count += 1;
  if (loads.count === 1) throw new Error('chunk fetch failed');
  return importOriginal();
});

describe('createWebPlatform lazy services', () => {
  // Load (and transform) the platform and the Google auth module it loads before the test runs: inside the test
  // these first imports took seconds on a machine loaded by parallel gates. The mocked lazy-services module itself
  // is still loaded, and failed, inside the test, so the retry it checks is unchanged.
  beforeAll(async () => {
    await Promise.all([import('../src/index.ts'), import('../src/auth/google-oauth-web.ts')]);
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries the lazy services module after a failed load', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    const { createWebPlatform } = await import('../src/index.ts');
    const platform = createWebPlatform({ googleClientId: 'test-client' });

    await expect(platform.getGoogleAuth()).rejects.toThrow();
    const auth = await platform.getGoogleAuth();
    expect(auth).toBeDefined();
    expect(loads.count).toBe(2);
  });
});
