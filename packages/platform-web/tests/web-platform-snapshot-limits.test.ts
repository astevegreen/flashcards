import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

describe('createWebPlatform snapshot caps', () => {
  beforeAll(async () => {
    await import('../src/index.ts');
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function platformFor(userAgent: string) {
    vi.stubGlobal('window', { location: { search: '' } });
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 0, platform: '' });
    const { createWebPlatform } = await import('../src/index.ts');
    return createWebPlatform();
  }

  it('a mobile browser syncs under the 25 MiB raw snapshot cap', async () => {
    const platform = await platformFor(ANDROID);
    expect(platform.syncSnapshotLimits?.maxUncompressedBytes).toBe(25 * 1024 * 1024);
  });

  it('a desktop browser keeps the engine default', async () => {
    const platform = await platformFor(DESKTOP);
    expect(platform.syncSnapshotLimits).toBeUndefined();
  });
});
