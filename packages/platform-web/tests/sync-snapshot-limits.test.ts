import { SYNC_CODEC_LIMITS } from '@flash/core';
import { describe, expect, it } from 'vitest';
import {
  isMobileBrowser,
  MOBILE_WEB_SYNC_SNAPSHOT_LIMITS,
  webSyncSnapshotLimits,
} from '../src/sync/snapshot-limits.ts';

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  // iPadOS Safari asks for the desktop site by default.
  ipadDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

describe('mobile-browser snapshot cap', () => {
  it('phones and tablets get the 25 MiB raw cap, as the Capacitor apps do', () => {
    expect(MOBILE_WEB_SYNC_SNAPSHOT_LIMITS.maxUncompressedBytes).toBe(
      SYNC_CODEC_LIMITS.maxUncompressedBytes,
    );
    for (const hints of [
      { userAgent: UA.androidChrome },
      { userAgent: UA.iphone, maxTouchPoints: 5 },
      { userAgent: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5 },
      // Some browsers report an empty `platform`: the user agent still says Macintosh.
      { userAgent: UA.ipadDesktop, platform: '', maxTouchPoints: 5 },
      { userAgent: UA.windowsChrome, userAgentData: { mobile: true } },
    ]) {
      expect(isMobileBrowser(hints)).toBe(true);
      expect(webSyncSnapshotLimits(hints)).toBe(MOBILE_WEB_SYNC_SNAPSHOT_LIMITS);
    }
  });

  it('desktop browsers keep the engine default', () => {
    for (const hints of [
      { userAgent: UA.windowsChrome, maxTouchPoints: 10, userAgentData: { mobile: false } },
      { userAgent: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 0 },
      undefined,
    ]) {
      expect(isMobileBrowser(hints)).toBe(false);
      expect(webSyncSnapshotLimits(hints)).toBeUndefined();
    }
  });
});
