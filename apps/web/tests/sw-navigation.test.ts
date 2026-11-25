import { describe, expect, it } from 'vitest';
import { NAVIGATE_FALLBACK_DENYLIST } from '../sw-navigation.ts';

/** Workbox matches the denylist against `pathname + search` (N3). */
const denied = (path: string) => NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(path));

describe('service worker navigation fallback', () => {
  it('lets the Picker bridge, notices and packs reach the network', () => {
    expect(denied('/picker.html')).toBe(true);
    expect(denied('/picker.html?mode=drive')).toBe(true);
    expect(denied('/picker')).toBe(true);
    expect(denied('/THIRD-PARTY-NOTICES.txt')).toBe(true);
    expect(denied('/packs/ko/index.json')).toBe(true);
  });

  it('still serves the app shell for app routes', () => {
    expect(denied('/')).toBe(false);
    expect(denied('/?device=a')).toBe(false);
    expect(denied('/study')).toBe(false);
    expect(denied('/pickers-guide')).toBe(false);
  });
});
