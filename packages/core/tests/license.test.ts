import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  canCreateOrImportDeck,
  canUseCloudSync,
  canonicalLicenseMessage,
  createFreeTierEntitlement,
  createPersonalEntitlement,
  encodeLicenseKey,
  type EntitlementState,
  FREE_TIER_MAX_DECKS,
  parseLicenseKey,
  UNLOCK_PRODUCT_ID,
  verifyEd25519LicenseKey,
  type Ed25519CryptoProvider,
} from '../src/license/index.ts';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const nodeEd25519Provider: Ed25519CryptoProvider = {
  async verify(publicKeyRaw, signature, message) {
    const pub = await webcrypto.subtle.importKey(
      'raw',
      new Uint8Array(publicKeyRaw).buffer,
      'Ed25519',
      false,
      ['verify'],
    );
    return webcrypto.subtle.verify(
      'Ed25519',
      pub,
      new Uint8Array(signature).buffer,
      new Uint8Array(message).buffer,
    );
  },
};

describe('Phase 8 License, Free-Tier Policy & Offline Ed25519 Verification (§12.1, §16)', () => {
  it('round-trips pure ES2023 base64url encoding', () => {
    const sample = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const encoded = base64UrlEncode(sample);
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(base64UrlDecode(encoded)).toEqual(sample);
  });

  it('signs and verifies Ed25519 license keys offline and rejects tampering', async () => {
    const pair = (await webcrypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as webcrypto.CryptoKeyPair;
    const publicKeyRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
    const publicKeyHex = bytesToHex(publicKeyRaw);

    const payload = {
      v: 1 as const,
      product: 'flashcards-unlock-v1' as const,
      edition: 'lifetime' as const,
      keyId: 'lic-2026-0001',
      issuedAt: 1_760_000_000_000,
      holder: 'family@example.com',
    };
    const provisional = encodeLicenseKey(payload, new Uint8Array(64));
    const payloadB64Url = provisional.split('.')[1] ?? '';
    const msg = canonicalLicenseMessage(payloadB64Url);
    const sig = new Uint8Array(
      await webcrypto.subtle.sign('Ed25519', pair.privateKey, new Uint8Array(msg).buffer),
    );
    const signedKey = encodeLicenseKey(payload, sig);

    const parsed = parseLicenseKey(signedKey);
    expect(parsed.payload).toEqual(payload);

    const ok = await verifyEd25519LicenseKey(signedKey, publicKeyHex, nodeEd25519Provider);
    expect(ok.valid).toBe(true);
    expect(ok.payload?.keyId).toBe('lic-2026-0001');

    // Tampered payload rejected
    const tamperedPayload = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ ...payload, keyId: 'lic-hacked' })),
    );
    const tamperedKey = `FLASH1.${tamperedPayload}.${signedKey.split('.')[2]}`;
    const tamperedRes = await verifyEd25519LicenseKey(
      tamperedKey,
      publicKeyHex,
      nodeEd25519Provider,
    );
    expect(tamperedRes.valid).toBe(false);

    // Wrong public key rejected
    const wrongPubHex = bytesToHex(new Uint8Array(32).fill(7));
    const wrongKeyRes = await verifyEd25519LicenseKey(signedKey, wrongPubHex, nodeEd25519Provider);
    expect(wrongKeyRes.valid).toBe(false);
  });

  it('enforces free-tier limits (2 local decks, no cloud sync) vs unlocked & personal builds', () => {
    const free = createFreeTierEntitlement();
    expect(canCreateOrImportDeck(0, free).allowed).toBe(true);
    expect(canCreateOrImportDeck(FREE_TIER_MAX_DECKS - 1, free).allowed).toBe(true);
    expect(canCreateOrImportDeck(FREE_TIER_MAX_DECKS, free).allowed).toBe(false);
    expect(canUseCloudSync(free).allowed).toBe(false);

    const unlocked: EntitlementState = {
      unlocked: true,
      source: 'store_iap',
      personalBuild: false,
      productId: UNLOCK_PRODUCT_ID,
    };
    expect(canCreateOrImportDeck(100, unlocked).allowed).toBe(true);
    expect(canUseCloudSync(unlocked).allowed).toBe(true);

    const personal = createPersonalEntitlement();
    expect(personal.unlocked).toBe(true);
    expect(personal.personalBuild).toBe(true);
    expect(canCreateOrImportDeck(50, personal).allowed).toBe(true);
    expect(canUseCloudSync(personal).allowed).toBe(true);
  });
});

describe('licence keys have one spelling (S13)', () => {
  const payload = {
    v: 1 as const,
    product: 'flashcards-unlock-v1' as const,
    edition: 'lifetime' as const,
    keyId: 'KEY-1',
    issuedAt: 1_760_000_000_000,
  };
  const key = encodeLicenseKey(payload, new Uint8Array(64).fill(7));
  const [prefix, body, sig] = key.split('.') as [string, string, string];

  it('accepts the canonical key', () => {
    expect(parseLicenseKey(key).payload.keyId).toBe('KEY-1');
  });

  it('refuses padding and stray trailing bits', () => {
    // 64 signature bytes end in one lone byte: two characters, the last with 4 unused bits.
    const last = sig.charAt(sig.length - 1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const strayBits = alphabet.charAt(alphabet.indexOf(last) | 1);
    expect(strayBits).not.toBe(last);
    for (const variant of [
      `${prefix}.${body}.${sig}==`,
      `${prefix}.${body}.${sig.slice(0, -1)}${strayBits}`,
    ]) {
      expect(() => parseLicenseKey(variant), variant).toThrow(/canonical/);
    }
  });
});
