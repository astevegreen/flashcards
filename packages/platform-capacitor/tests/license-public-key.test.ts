import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalLicenseMessage, encodeLicenseKey } from '@flash/core/license';
import {
  LICENSE_PUBLIC_KEY_MISSING_REASON,
  PLACEHOLDER_LICENSE_PUBLIC_KEY_HEX,
  WebLicensePurchase,
  webCryptoEd25519Provider,
} from '@flash/platform-web/purchase-license';
import {
  CapacitorSqliteStorage,
  CapacitorStorePurchase,
  createCapacitorPlatform,
} from '../src/index.ts';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signedLicence(): Promise<{ key: string; publicKeyHex: string }> {
  const pair = (await webcrypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyHex = hex(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)));
  const payload = {
    v: 1 as const,
    product: 'flashcards-unlock-v1' as const,
    edition: 'lifetime' as const,
    keyId: 'phone-key-1',
    issuedAt: 1_760_000_000_000,
  };
  const provisional = encodeLicenseKey(payload, new Uint8Array(64));
  const msg = canonicalLicenseMessage(provisional.split('.')[1] ?? '');
  const sig = new Uint8Array(
    await webcrypto.subtle.sign('Ed25519', pair.privateKey, new Uint8Array(msg).buffer),
  );
  return { key: encodeLicenseKey(payload, sig), publicKeyHex };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('licence public key (S12)', () => {
  it('web: no key or the old placeholder warns and refuses keys with a clear reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { key } = await signedLicence();
    for (const publicKeyHex of [undefined, PLACEHOLDER_LICENSE_PUBLIC_KEY_HEX]) {
      warn.mockClear();
      const purchase = new WebLicensePurchase({
        storage: new CapacitorSqliteStorage(),
        isPersonalBuild: false,
        ...(publicKeyHex ? { publicKeyHex } : {}),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const res = await purchase.activateLicenseKey(key);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe(LICENSE_PUBLIC_KEY_MISSING_REASON);
      expect(res.entitlement.unlocked).toBe(false);
    }
  });

  it('a personal build does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new WebLicensePurchase({ storage: new CapacitorSqliteStorage(), isPersonalBuild: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('store build: no key warns and refuses keys with a clear reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const purchase = new CapacitorStorePurchase({
      storage: new CapacitorSqliteStorage(),
      cryptoProvider: webCryptoEd25519Provider,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const res = await purchase.activateLicenseKey((await signedLicence()).key);
    expect(res.reason).toBe(LICENSE_PUBLIC_KEY_MISSING_REASON);
  });

  it('Capacitor passes the key and crypto provider through, so a phone can activate a key', async () => {
    const { key, publicKeyHex } = await signedLicence();
    const platform = createCapacitorPlatform({
      deviceId: 'phone',
      storage: new CapacitorSqliteStorage(),
      isPersonalBuild: false,
      licensePublicKeyHex: publicKeyHex,
      licenseCryptoProvider: webCryptoEd25519Provider,
    });
    const purchase = (await platform.getPurchase?.()) as CapacitorStorePurchase;
    const res = await purchase.activateLicenseKey(key);
    expect(res.reason).toBeUndefined();
    expect(res.valid).toBe(true);
    expect(res.entitlement).toMatchObject({ unlocked: true, source: 'license_key' });
  });
});
