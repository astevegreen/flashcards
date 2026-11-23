import { encodeUtf8 } from '../ids.ts';
import { decodeUtf8 } from '../utf8-decode.ts';

export const FREE_TIER_MAX_DECKS = 2;
export const UNLOCK_PRODUCT_ID = 'unlock_full';
export const LICENSE_KEY_PREFIX = 'FLASH1';

export type LicenseSource = 'personal_build' | 'store_iap' | 'license_key' | 'free';

export interface EntitlementState {
  unlocked: boolean;
  source: LicenseSource;
  personalBuild: boolean;
  productId: typeof UNLOCK_PRODUCT_ID;
  keyId?: string;
  holder?: string;
  verifiedAt?: number;
}

export interface SignedLicensePayload {
  v: 1;
  product: 'flashcards-unlock-v1';
  edition: 'lifetime';
  keyId: string;
  issuedAt: number;
  holder?: string;
}

export interface ParsedLicenseKey {
  prefix: typeof LICENSE_KEY_PREFIX;
  payloadB64Url: string;
  signatureB64Url: string;
  signingMessageBytes: Uint8Array;
  signatureBytes: Uint8Array;
  payload: SignedLicensePayload;
}

export interface Ed25519CryptoProvider {
  verify(publicKeyRaw: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean>;
}

export interface LicenseVerifyResult {
  valid: boolean;
  payload?: SignedLicensePayload;
  reason?: string;
}

export interface FeatureGateDecision {
  allowed: boolean;
  reason?: string;
  maxFreeDecks: number;
}

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP = (() => {
  const table = new Int16Array(128);
  table.fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) {
    table[B64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** Pure ES2023 Base64url encoder (zero DOM `btoa` or Node `Buffer` dependency). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;

    out += B64URL_ALPHABET[b0 >> 2] ?? '';
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)] ?? '';
    if (hasB1) {
      out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] ?? '';
    }
    if (hasB2) {
      out += B64URL_ALPHABET[b2 & 0x3f] ?? '';
    }
  }
  return out;
}

/** Pure ES2023 Base64url decoder. Throws on malformed input. */
export function base64UrlDecode(input: string): Uint8Array {
  const cleaned = input.trim().replace(/=+$/, '');
  if (cleaned.length % 4 === 1) {
    throw new Error('Invalid base64url length.');
  }
  const outLen = Math.floor((cleaned.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let outIdx = 0;
  for (let i = 0; i < cleaned.length; i += 4) {
    const c0 = cleaned.charCodeAt(i);
    const c1 = cleaned.charCodeAt(i + 1);
    const c2 = i + 2 < cleaned.length ? cleaned.charCodeAt(i + 2) : -1;
    const c3 = i + 3 < cleaned.length ? cleaned.charCodeAt(i + 3) : -1;

    const v0 = c0 < 128 ? (B64URL_LOOKUP[c0] ?? -1) : -1;
    const v1 = c1 < 128 ? (B64URL_LOOKUP[c1] ?? -1) : -1;
    if (v0 < 0 || v1 < 0) {
      throw new Error('Invalid base64url character.');
    }
    out[outIdx++] = (v0 << 2) | (v1 >> 4);

    if (c2 >= 0) {
      const v2 = c2 < 128 ? (B64URL_LOOKUP[c2] ?? -1) : -1;
      if (v2 < 0) throw new Error('Invalid base64url character.');
      out[outIdx++] = ((v1 & 0x0f) << 4) | (v2 >> 2);

      if (c3 >= 0) {
        const v3 = c3 < 128 ? (B64URL_LOOKUP[c3] ?? -1) : -1;
        if (v3 < 0) throw new Error('Invalid base64url character.');
        out[outIdx++] = ((v2 & 0x03) << 6) | v3;
      }
    }
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Invalid hex byte string.');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function canonicalLicenseMessage(payloadB64Url: string): Uint8Array {
  return encodeUtf8(`${LICENSE_KEY_PREFIX}.${payloadB64Url}`);
}

export function encodeLicenseKey(
  payload: SignedLicensePayload,
  signatureBytes: Uint8Array,
): string {
  const canonicalJson = JSON.stringify({
    v: payload.v,
    product: payload.product,
    edition: payload.edition,
    keyId: payload.keyId,
    issuedAt: payload.issuedAt,
    ...(payload.holder !== undefined ? { holder: payload.holder } : {}),
  });
  const payloadB64Url = base64UrlEncode(encodeUtf8(canonicalJson));
  const signatureB64Url = base64UrlEncode(signatureBytes);
  return `${LICENSE_KEY_PREFIX}.${payloadB64Url}.${signatureB64Url}`;
}

export function parseLicenseKey(rawKey: string): ParsedLicenseKey {
  const trimmed = rawKey.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_KEY_PREFIX) {
    throw new Error(`License key must start with "${LICENSE_KEY_PREFIX}." and have 3 parts.`);
  }
  const payloadB64Url = parts[1] ?? '';
  const signatureB64Url = parts[2] ?? '';
  if (!payloadB64Url || !signatureB64Url) {
    throw new Error('License key payload or signature is empty.');
  }

  const payloadBytes = base64UrlDecode(payloadB64Url);
  const signatureBytes = base64UrlDecode(signatureB64Url);
  if (signatureBytes.byteLength !== 64) {
    throw new Error('Invalid Ed25519 signature byte length (expected 64 bytes).');
  }

  const parsed = JSON.parse(decodeUtf8(payloadBytes)) as Record<string, unknown>;
  if (
    parsed['v'] !== 1 ||
    parsed['product'] !== 'flashcards-unlock-v1' ||
    parsed['edition'] !== 'lifetime' ||
    typeof parsed['keyId'] !== 'string' ||
    !parsed['keyId'].trim() ||
    typeof parsed['issuedAt'] !== 'number' ||
    !Number.isFinite(parsed['issuedAt'])
  ) {
    throw new Error('Malformed license payload fields.');
  }

  const payload: SignedLicensePayload = {
    v: 1,
    product: 'flashcards-unlock-v1',
    edition: 'lifetime',
    keyId: parsed['keyId'].trim(),
    issuedAt: parsed['issuedAt'],
    ...(typeof parsed['holder'] === 'string' && parsed['holder'].trim()
      ? { holder: parsed['holder'].trim() }
      : {}),
  };

  return {
    prefix: LICENSE_KEY_PREFIX,
    payloadB64Url,
    signatureB64Url,
    signingMessageBytes: canonicalLicenseMessage(payloadB64Url),
    signatureBytes,
    payload,
  };
}

/**
 * Verifies an offline Ed25519-signed license key (§12.1) without any network call.
 */
export async function verifyEd25519LicenseKey(
  rawKey: string,
  publicKeyHex: string,
  cryptoProvider: Ed25519CryptoProvider,
): Promise<LicenseVerifyResult> {
  let parsed: ParsedLicenseKey;
  try {
    parsed = parseLicenseKey(rawKey);
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = hexToBytes(publicKeyHex);
    if (publicKeyBytes.byteLength !== 32) {
      return { valid: false, reason: 'Public key must be a 32-byte Ed25519 key.' };
    }
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const ok = await cryptoProvider.verify(
      publicKeyBytes,
      parsed.signatureBytes,
      parsed.signingMessageBytes,
    );
    if (!ok) {
      return { valid: false, reason: 'Ed25519 license signature verification failed.' };
    }
    return { valid: true, payload: parsed.payload };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function createPersonalEntitlement(): EntitlementState {
  return {
    unlocked: true,
    source: 'personal_build',
    personalBuild: true,
    productId: UNLOCK_PRODUCT_ID,
  };
}

export function createFreeTierEntitlement(): EntitlementState {
  return {
    unlocked: false,
    source: 'free',
    personalBuild: false,
    productId: UNLOCK_PRODUCT_ID,
  };
}

/**
 * Free-tier policy (§12.1, §16.2):
 * - Personal/family builds (`personalBuild: true`) and unlocked builds allow unlimited decks.
 * - Commercial free tier includes up to `FREE_TIER_MAX_DECKS` (2) local-only decks.
 */
export function canCreateOrImportDeck(
  activeDeckCount: number,
  entitlement: EntitlementState,
): FeatureGateDecision {
  if (entitlement.personalBuild || entitlement.unlocked) {
    return { allowed: true, maxFreeDecks: FREE_TIER_MAX_DECKS };
  }
  if (activeDeckCount < FREE_TIER_MAX_DECKS) {
    return { allowed: true, maxFreeDecks: FREE_TIER_MAX_DECKS };
  }
  return {
    allowed: false,
    maxFreeDecks: FREE_TIER_MAX_DECKS,
    reason: `Free tier supports up to ${FREE_TIER_MAX_DECKS} local decks. Unlock once for unlimited decks & cloud sync.`,
  };
}

/**
 * Commercial free tier is local-only; one-time Unlock (or personal build) enables cloud sync (§16.2).
 */
export function canUseCloudSync(entitlement: EntitlementState): FeatureGateDecision {
  if (entitlement.personalBuild || entitlement.unlocked) {
    return { allowed: true, maxFreeDecks: FREE_TIER_MAX_DECKS };
  }
  return {
    allowed: false,
    maxFreeDecks: FREE_TIER_MAX_DECKS,
    reason:
      'Cloud sync requires the one-time Unlock upgrade (free tier supports local study & .flashpkg backup).',
  };
}
