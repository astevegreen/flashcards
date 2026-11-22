import { WebPlugin } from '@capacitor/core';
import type { FlashSecureStoragePlugin } from './definitions.ts';

const UNAVAILABLE_MESSAGE =
  'Secure storage is only available in the Android and iOS apps. Browsers keep sign-in data in the app database instead.';

/**
 * Browser fallback. Refuses every secret operation instead of falling back to `localStorage` or
 * IndexedDB, so a token can never be stored insecurely by mistake.
 */
export class FlashSecureStorageWeb extends WebPlugin implements FlashSecureStoragePlugin {
  async get(_options: { key: string }): Promise<{ value: string | null }> {
    throw this.unavailable(UNAVAILABLE_MESSAGE);
  }

  async set(_options: { key: string; value: string }): Promise<void> {
    throw this.unavailable(UNAVAILABLE_MESSAGE);
  }

  async remove(_options: { key: string }): Promise<void> {
    throw this.unavailable(UNAVAILABLE_MESSAGE);
  }

  async removeLegacyPreference(_options: {
    key: string;
    androidPreferencesName?: string;
  }): Promise<void> {
    // Browsers have no native preference store, so there is never anything to clear.
  }
}
