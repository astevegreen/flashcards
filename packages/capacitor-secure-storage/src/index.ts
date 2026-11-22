import { registerPlugin } from '@capacitor/core';
import type { FlashSecureStoragePlugin } from './definitions.ts';

/**
 * The native secure store (`FlashSecureStoragePlugin.swift` / `SecureStoragePlugin.java`).
 * Only `@flash/platform-capacitor/native` imports this, so it never reaches the PWA's initial chunk.
 */
export const FlashSecureStorage = registerPlugin<FlashSecureStoragePlugin>('FlashSecureStorage', {
  web: () => import('./web.ts').then((m) => new m.FlashSecureStorageWeb()),
});

export type { FlashSecureStoragePlugin } from './definitions.ts';
