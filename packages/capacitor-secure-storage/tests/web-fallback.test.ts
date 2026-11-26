import { describe, expect, it } from 'vitest';
import { FlashSecureStorage } from '../src/index.ts';
import { FlashSecureStorageWeb } from '../src/web.ts';

// §9: the native Keychain/Keystore code only runs on a device. What can run in node is the
// browser fallback, which must refuse every secret operation rather than store a token in
// browser storage, and the plugin registration that picks it outside the native shells.
describe('@flash/capacitor-secure-storage web fallback', () => {
  const web = new FlashSecureStorageWeb();

  it('refuses get, set and remove with UNAVAILABLE', async () => {
    for (const call of [
      () => web.get({ key: 'google-refresh-token' }),
      () => web.set({ key: 'google-refresh-token', value: 'secret' }),
      () => web.remove({ key: 'google-refresh-token' }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: expect.stringMatching(/only available in the Android and iOS apps/),
      });
    }
  });

  it('treats clearing a legacy preference as done: browsers have none', async () => {
    await expect(
      web.removeLegacyPreference({ key: 'CapgoOAuth2ProviderTokens_google' }),
    ).resolves.toBeUndefined();
  });

  it('the registered plugin falls back to the refusing web implementation outside a native shell', async () => {
    await expect(FlashSecureStorage.get({ key: 'google-refresh-token' })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    await expect(
      FlashSecureStorage.set({ key: 'google-refresh-token', value: 'secret' }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      FlashSecureStorage.removeLegacyPreference({ key: 'x', androidPreferencesName: 'y' }),
    ).resolves.toBeUndefined();
  });
});
