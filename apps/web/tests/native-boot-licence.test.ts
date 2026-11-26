import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformServices } from '@flash/platform';

const seen = vi.hoisted(() => ({ capacitor: [] as unknown[], tauri: [] as unknown[] }));

vi.mock('@flash/platform-capacitor/native', () => ({
  bootCapacitorPlatform: vi.fn(async (config: unknown) => {
    seen.capacitor.push(config);
    return {} as PlatformServices;
  }),
}));
vi.mock('@flash/platform-tauri/native', () => ({
  bootTauriPlatform: vi.fn(async (config: unknown) => {
    seen.tauri.push(config);
    return {} as PlatformServices;
  }),
}));

const { bootNativePlatform } = await import('../src/native-boot.ts');

const settings = {
  googleClientId: '',
  googleApiKey: '',
  isPersonalBuild: false,
  licensePublicKeyHex: 'ab'.repeat(32),
  microsoftClientId: '',
  microsoftTenant: '',
  dropboxAppKey: '',
  packCatalogUrl: '',
  starterCatalogUrl: '',
};

afterEach(() => {
  vi.unstubAllEnvs();
  seen.capacitor.length = 0;
  seen.tauri.length = 0;
});

describe('native boot licence wiring (S12)', () => {
  it('hands the licence key to both shells; store builds keep licence keys off by default', async () => {
    await bootNativePlatform('capacitor', {} as PlatformServices, settings);
    await bootNativePlatform('tauri', {} as PlatformServices, settings);
    expect(seen.capacitor[0]).toMatchObject({
      licensePublicKeyHex: 'ab'.repeat(32),
      allowLicenseKeys: false,
    });
    expect(seen.tauri[0]).toMatchObject({ licensePublicKeyHex: 'ab'.repeat(32) });
  });

  it('VITE_STORE_LICENSE_KEYS=true opts a store build in', async () => {
    vi.stubEnv('VITE_STORE_LICENSE_KEYS', 'true');
    await bootNativePlatform('capacitor', {} as PlatformServices, settings);
    expect(seen.capacitor[0]).toMatchObject({ allowLicenseKeys: true });
  });
});
